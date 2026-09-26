import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.js";
import { createNdjsonProbeRecordStore } from "./probe/record-store.js";

export async function latestPairingHmac(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const config = loadConfig(env);
  if (!config.pairingMode) throw new Error("PAIRING_MODE_REQUIRED");
  const store = await createNdjsonProbeRecordStore({ path: config.callbackRecordPath });
  let found: string | null = null;
  for await (const record of store.readAll()) {
    if (record.stage === "callback_ignored" && record.signatureValid === true && record.senderHmac !== null) found = record.senderHmac;
  }
  if (found === null) throw new Error("PAIRING_SENDER_NOT_FOUND");
  return found;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void latestPairingHmac().then((value) => {
    process.stdout.write(`WECHAT_ALLOWED_SENDER_HMAC=${value}\n`);
  }).catch(() => { process.exitCode = 1; });
}
