import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { createNodeDnsAddressResolver } from "./article/dns-resolver.js";
import { createNodeHttpsTransport, createPinnedHttpsClient } from "./article/pinned-https-client.js";
import { loadConfig } from "./config.js";
import { createAsyncRedactedWriter, createCallbackObservationWriter, createNdjsonProbeRecordStore } from "./probe/record-store.js";
import { createProbeRedactor } from "./probe/redaction.js";
import { createWechatWikiRuntime } from "./runtime.js";
import { createCodexAgentRunner, createWikiCompiler } from "./wiki/wiki-compiler.js";
import { createCompileQueuePort, createMyWikiIngestPort } from "./wiki/my-wiki-adapters.js";
import { createMyWikiWorker } from "./wiki/wiki-worker.js";
import { createSafeWeChatFetch } from "./wiki/safe-wechat-fetch.js";

async function preparePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("PRIVATE_DIRECTORY_REJECTED");
  await chmod(path, 0o700);
}

export async function main(): Promise<void> {
  const config = loadConfig(process.env);
  await preparePrivateDirectory(dirname(config.callbackRecordPath));
  const records = await createNdjsonProbeRecordStore({ path: config.callbackRecordPath });
  const redactor = createProbeRedactor(config.hmacKey);
  const callbackObservation = createCallbackObservationWriter(records, redactor);
  const eventObservation = createAsyncRedactedWriter(records);
  const pinnedClient = createPinnedHttpsClient({ resolver: createNodeDnsAddressResolver(config.dnsServer), transport: createNodeHttpsTransport() });
  const safeFetch = createSafeWeChatFetch({ client: pinnedClient });
  const [ingest, queue] = await Promise.all([createMyWikiIngestPort(config.repoRoot, safeFetch), createCompileQueuePort(config.repoRoot)]);
  const compiler = createWikiCompiler({
    repoRoot: config.repoRoot,
    queue,
    runAgent: createCodexAgentRunner({ repoRoot: config.repoRoot, codexBin: config.codexBin }),
  });
  const worker = createMyWikiWorker({ repoRoot: config.repoRoot, ingest, compiler });
  const runtime = createWechatWikiRuntime({
    config: {
      token: config.token,
      appId: config.appId,
      encodingAesKey: config.encodingAesKey,
      publicBaseUrl: config.publicBaseUrl,
      authorizedSenderHmac: config.authorizedSenderHmac,
    },
    hmacKey: config.hmacKey,
    worker,
    callbackObservation,
    eventObservation,
  });
  await runtime.start(config.port);
  console.info(JSON.stringify({ event: "wechat_wiki_started", port: runtime.publicAddress.port, mode: config.pairingMode ? "pair" : "run" }));
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void runtime.stop().then(async () => {
      await Promise.all([callbackObservation.flush(), eventObservation.flush()]);
      const unhealthy = callbackObservation.health.dropped + callbackObservation.health.failed + eventObservation.health.dropped + eventObservation.health.failed > 0;
      process.exitCode = unhealthy ? 1 : 0;
      console.info(JSON.stringify({ event: "wechat_wiki_stopped", auditHealthy: !unhealthy }));
    }).catch(() => { process.exitCode = 1; });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { process.exitCode = 1; });
}
