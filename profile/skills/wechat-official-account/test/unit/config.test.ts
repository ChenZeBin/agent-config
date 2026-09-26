import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../../src/config.js";

const base = {
  WECHAT_TOKEN: "wechatTokenValue",
  WECHAT_APP_ID: "wx1234567890",
  WECHAT_ENCODING_AES_KEY: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
  PUBLIC_BASE_URL: "https://example.trycloudflare.com",
  WEBHOOK_HMAC_KEY: "h".repeat(32),
  WECHAT_ALLOWED_SENDER_HMAC: "h1:" + "a".repeat(43),
  MY_WIKI_REPO: "/Users/example/my-wiki",
};

test("loads the production-only values and keeps evidence inside the Wiki repo", () => {
  const config = loadConfig(base);
  assert.equal(config.port, 8787);
  assert.equal(config.repoRoot, "/Users/example/my-wiki");
  assert.equal(config.callbackRecordPath, "/Users/example/my-wiki/staging/private/wechat-callback.ndjson");
  assert.equal(config.dnsServer, "1.1.1.1");
  assert.equal(config.publicBaseUrl.href, "https://example.trycloudflare.com/");
});

test("fails closed without sender authorization, AES, or a public HTTPS origin", () => {
  for (const key of ["WECHAT_ENCODING_AES_KEY", "WECHAT_ALLOWED_SENDER_HMAC"] as const) {
    const env = { ...base };
    delete env[key];
    assert.throws(() => loadConfig(env), /CONFIG_INVALID/);
  }
  assert.throws(() => loadConfig({ ...base, PUBLIC_BASE_URL: "http://localhost:8787" }), /CONFIG_INVALID/);
  assert.throws(() => loadConfig({ ...base, WECHAT_ALLOWED_SENDER_HMAC: "openid-raw" }), /CONFIG_INVALID/);
  assert.throws(() => loadConfig({ ...base, WECHAT_DNS_SERVER: "dns.example" }), /CONFIG_INVALID/);
});

test("pair mode records a sender fingerprint but cannot authorize ingestion", () => {
  const env: Record<string, string | undefined> = { ...base, WECHAT_MODE: "pair" };
  delete env.WECHAT_ALLOWED_SENDER_HMAC;
  const config = loadConfig(env);
  assert.equal(config.pairingMode, true);
  assert.equal(config.authorizedSenderHmac, null);
});
