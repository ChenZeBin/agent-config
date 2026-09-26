import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import type { CallbackObservation } from "../../src/wechat/callback-service.js";
import type { RedactedProbeRecord } from "../../src/probe/contracts.js";
import { createProbeRedactor } from "../../src/probe/redaction.js";
import { createWechatWikiRuntime } from "../../src/runtime.js";
import { createMyWikiWorker } from "../../src/wiki/wiki-worker.js";

const token = "wechatTokenValue";
const timestamp = "1712345678";
const nonce = "nonce-e2e";
const sender = "openid_e2e_sender";
const articleUrl = "https://mp.weixin.qq.com/s/e2e-article";

function signature(): string {
  return createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
}

function textXml(msgId = "9223372036854775807"): string {
  return `<xml><ToUserName><![CDATA[gh_account]]></ToUserName><FromUserName><![CDATA[${sender}]]></FromUserName><CreateTime>1712345678</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${articleUrl}]]></Content><MsgId>${msgId}</MsgId></xml>`;
}

test("valid WeChat text link reaches immutable intake and LLM Wiki consistency exactly once after ACK", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "my-wiki-flow-"));
  const rawBundle = join(repoRoot, "raw", "wechat", "bundle-1");
  await mkdir(rawBundle, { recursive: true });
  const hmacKey = "h".repeat(32);
  const redactor = createProbeRedactor(hmacKey);
  const callbackRecords: CallbackObservation[] = [];
  const eventRecords: RedactedProbeRecord[] = [];
  let ingests = 0;
  let compiles = 0;
  const worker = createMyWikiWorker({
    repoRoot,
    ingest: async (url) => {
      ingests += 1;
      assert.equal(url, articleUrl);
      return { raw_bundle: rawBundle, bundle_checksum: "sha256:" + "a".repeat(64), content_checksum: "sha256:" + "b".repeat(64) };
    },
    compiler: { async compile(input) {
      compiles += 1;
      assert.equal(JSON.stringify(input).includes(articleUrl), false);
      assert.equal(JSON.stringify(input).includes(sender), false);
      return { state: "consistent" as const };
    } },
  });
  const runtime = createWechatWikiRuntime({
    config: {
      token,
      appId: "wx1234567890",
      encodingAesKey: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      publicBaseUrl: new URL("https://public.example/"),
      authorizedSenderHmac: redactor.hmac("sender", sender),
    },
    hmacKey,
    worker,
    callbackObservation: { record(value) { callbackRecords.push(value); } },
    eventObservation: { record(value) { eventRecords.push(value); } },
    newProbeId: () => "p".repeat(32),
  });
  await runtime.start(0, "127.0.0.1");
  test.after(async () => { await runtime.stop(); });
  const endpoint = `http://127.0.0.1:${runtime.publicAddress.port}/wechat?signature=${signature()}&timestamp=${timestamp}&nonce=${nonce}`;
  const began = performance.now();
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/xml" }, body: textXml() });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.ok(performance.now() - began < 3_000);
  assert.match(body, /\/probe\/events\/p{32}/);
  await runtime.whenIdle();
  assert.deepEqual({ ingests, compiles }, { ingests: 1, compiles: 1 });

  const status = await fetch(`http://127.0.0.1:${runtime.publicAddress.port}/probe/events/${"p".repeat(32)}`);
  assert.equal(status.status, 200);
  assert.match(await status.text(), /LLM Wiki 已更新/);

  const duplicate = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/xml" }, body: textXml() });
  assert.equal(duplicate.status, 200);
  await runtime.whenIdle();
  assert.deepEqual({ ingests, compiles }, { ingests: 1, compiles: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const persistedShape = JSON.stringify([...callbackRecords, ...eventRecords]);
  assert.equal(persistedShape.includes(articleUrl), false);
  assert.equal(persistedShape.includes(sender), false);
});
