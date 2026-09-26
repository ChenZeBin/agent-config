import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { createCallbackService } from "../../src/wechat/callback-service.js";
import { decryptWeChatPayload, encryptWeChatPayload } from "../../src/wechat/crypto.js";
import { parseEncryptedEnvelopeXml } from "../../src/wechat/callback-xml.js";
import { FIXTURE_CONFIG, encryptFixturePayload, fixtureSignature } from "../helpers/wechat-fixture-crypto.js";

const linkFixture = resolve("test/fixtures/wechat-link-plain.xml");
const timestamp = "1712345678";
const nonce = "nonce-1";

class Clock {
  wall = new Date("2024-04-05T06:07:08.000Z");
  mono = 50;
  wallNow(): Date { return new Date(this.wall); }
  monotonicNowMs(): number { return this.mono; }
}

function query(overrides: Partial<{ signature: string; msgSignature: string; echoStr: string; encryptType: "aes" }> = {}) {
  return {
    signature: overrides.signature ?? createHash("sha1").update([FIXTURE_CONFIG.token, timestamp, nonce].sort().join("")).digest("hex"),
    msgSignature: overrides.msgSignature ?? null,
    timestamp,
    nonce,
    echoStr: overrides.echoStr ?? null,
    encryptType: overrides.encryptType ?? null,
  } as const;
}

function setup(authorizedSenderHmac?: string) {
  const clock = new Clock();
  const jobs: unknown[] = [];
  const observations: unknown[] = [];
  const captures: unknown[] = [];
  const fingerprints: string[] = [];
  let sequence = 0;
  const service = createCallbackService({
    config: {
      ...FIXTURE_CONFIG,
      publicBaseUrl: new URL("https://probe.example/"),
      ...(authorizedSenderHmac === undefined ? {} : { authorizedSenderHmac }),
    },
    clock,
    scheduler: { enqueue(job) { jobs.push(job); } },
    fingerprint: { hmac(value) { const text = typeof value === "string" ? value : Buffer.from(value).toString("base64"); fingerprints.push(text); return createHmac("sha256", "test-key").update(value).digest("hex"); } },
    observation: { record(observation) { observations.push(observation); } },
    replayCapture: { capture(capture) { captures.push(capture); } },
    newProbeId: () => `probe-${++sequence}`,
  });
  return { service, clock, jobs, observations, captures, fingerprints };
}

test("acknowledges an unauthorized sender without allocating, capturing, or scheduling", async () => {
  const rawXml = await readFile(linkFixture, "utf8");
  const { service, jobs, observations, captures, fingerprints } = setup("not-the-sender-hmac");
  const plan = service.planPost(query(), rawXml);
  assert.deepEqual({ status: plan.statusCode, body: plan.body, probe: plan.probeId }, { status: 200, body: "success", probe: null });
  plan.afterAck?.(60);
  assert.equal(jobs.length, 0);
  assert.equal(captures.length, 0);
  assert.equal(observations.length, 1);
  assert.equal((observations[0] as { callbackKind: string }).callbackKind, "unsupported");
  assert.equal(fingerprints.includes("9223372036854775807"), false);
  assert.equal(fingerprints.includes("https://mp.weixin.qq.com/s/example?source=probe&scene=1"), false);
});

function textXml(content: string, msgId = "9223372036854775806"): string {
  return `<xml><ToUserName><![CDATA[gh_example_account]]></ToUserName><FromUserName><![CDATA[openid_example_sender]]></FromUserName><CreateTime>1712345678</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>${msgId}</MsgId></xml>`;
}

test("plaintext handshakes return echostr only with a valid signature", () => {
  const { service } = setup();
  assert.equal(service.planGet(query({ echoStr: "echo-value" })).body, "echo-value");
  assert.equal(service.planGet(query({ echoStr: "echo-value", signature: "0".repeat(40) })).statusCode, 401);
});

test("AES handshake authenticates before decrypting and checks AppID", () => {
  const { service } = setup();
  const encrypted = encryptFixturePayload("random-handshake-string");
  const sig = fixtureSignature(FIXTURE_CONFIG.token, timestamp, nonce, encrypted);
  const valid = service.planGet(query({ encryptType: "aes", echoStr: encrypted, msgSignature: sig }));
  assert.deepEqual({ status: valid.statusCode, body: valid.body }, { status: 200, body: "random-handshake-string" });
  assert.equal(service.planGet(query({ encryptType: "aes", echoStr: encrypted, msgSignature: "0".repeat(40) })).statusCode, 401);
  assert.equal(service.planGet(query({ encryptType: "aes", echoStr: "bad", msgSignature: fixtureSignature(FIXTURE_CONFIG.token, timestamp, nonce, "bad") })).statusCode, 401);
});

test("plans a safe plaintext reply and defers all port calls", async () => {
  const rawXml = await readFile(linkFixture, "utf8");
  const { service, jobs, observations, captures, clock } = setup();
  const plan = service.planPost(query(), rawXml);
  assert.match(plan.body, /已收下这篇文章。处理结果将在这里更新：https:\/\/probe\.example\/probe\/events\/probe-1/);
  assert.equal(jobs.length, 0);
  assert.equal(observations.length, 0);
  assert.equal(captures.length, 0);
  clock.mono = 63;
  plan.afterAck?.(clock.mono);
  assert.equal(jobs.length, 1);
  assert.equal(observations.length, 1);
  assert.equal(captures.length, 1);
});

test("AES posts authenticate then decrypt inbound XML and encrypt the reply", async () => {
  const rawXml = await readFile(linkFixture, "utf8");
  const encrypt = encryptFixturePayload(rawXml);
  const { service } = setup();
  const plan = service.planPost(query({ encryptType: "aes", msgSignature: fixtureSignature(FIXTURE_CONFIG.token, timestamp, nonce, encrypt) }), `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`);
  assert.equal(plan.statusCode, 200);
  const envelope = parseEncryptedEnvelopeXml(plan.body);
  assert.match(decryptWeChatPayload(envelope.encrypt, FIXTURE_CONFIG), /<Content>已收下这篇文章。处理结果将在这里更新：https:\/\/probe\.example\/probe\/events\/probe-1<\/Content>/);
});

test("AES AppID mismatches are rejected before probe allocation", async () => {
  const rawXml = await readFile(linkFixture, "utf8");
  const foreignConfig = { ...FIXTURE_CONFIG, appId: "wx-foreign-app-id" };
  const encrypt = encryptFixturePayload(rawXml, foreignConfig);
  const { service, jobs } = setup();
  const plan = service.planPost(query({ encryptType: "aes", msgSignature: fixtureSignature(FIXTURE_CONFIG.token, timestamp, nonce, encrypt) }), `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`);
  assert.equal(plan.statusCode, 401);
  plan.afterAck?.(60);
  assert.equal(jobs.length, 0);
});

test("invalid callbacks do not allocate a probe or enqueue", async () => {
  const rawXml = await readFile(linkFixture, "utf8");
  const { service, jobs } = setup();
  assert.equal(service.planPost(query({ signature: "0".repeat(40) }), rawXml).statusCode, 401);
  assert.equal(service.planPost(query(), "<xml><MsgType>link</MsgType></xml>").statusCode, 401);
  assert.equal(jobs.length, 0);
});

test("unsupported messages are acknowledged without jobs; dedupe stores only a fingerprint", async () => {
  const rawXml = await readFile(linkFixture, "utf8");
  const { service, jobs, fingerprints } = setup();
  assert.equal(service.planPost(query(), "<xml><MsgType>text</MsgType></xml>").body, "success");
  const first = service.planPost(query(), rawXml);
  const second = service.planPost(query(), rawXml);
  assert.equal(first.probeId, second.probeId);
  first.afterAck?.(60);
  second.afterAck?.(61);
  assert.equal(jobs.length, 1);
  assert.equal(fingerprints.some((value) => value === "9223372036854775807"), false);
});

test("accepts only an exact copied WeChat article URL as text_link", () => {
  const { service, jobs, observations, captures } = setup();
  const plan = service.planPost(query(), textXml("https://mp.weixin.qq.com/s/copied-article?__biz=biz&mid=1"));
  assert.equal(plan.statusCode, 200);
  assert.match(plan.body, /已收下这篇文章/);
  assert.equal(jobs.length, 0);
  plan.afterAck?.(60);
  assert.equal(jobs.length, 1);
  assert.equal((jobs[0] as { rawUrl: string }).rawUrl, "https://mp.weixin.qq.com/s/copied-article?__biz=biz&mid=1");
  assert.equal((observations[0] as { callbackKind: string; linkUrlParsed: boolean }).callbackKind, "text_link");
  assert.equal((observations[0] as { linkUrlParsed: boolean }).linkUrlParsed, true);
  assert.equal(captures.length, 1);
});

test("keeps ordinary and ambiguous text out of the article queue", () => {
  const { service, jobs, observations, captures } = setup();
  const rejected = [
    "AI Agent",
    " https://mp.weixin.qq.com/s/copied ",
    "save https://mp.weixin.qq.com/s/copied",
    "https://mp.weixin.qq.com/s/one https://mp.weixin.qq.com/s/two",
    "http://mp.weixin.qq.com/s/copied",
    "https://sub.mp.weixin.qq.com/s/copied",
    "https://user" + "@mp.weixin.qq.com/s/copied",
    "https://mp.weixin.qq.com:444/s/copied",
    "https://mp.weixin.qq.com/mp/profile_ext?action=home",
    `https://mp.weixin.qq.com/s/${"a".repeat(4096)}`,
  ];
  for (const [index, content] of rejected.entries()) {
    const plan = service.planPost(query(), textXml(content, String(7000 + index)));
    assert.equal(plan.body, "success", content);
    plan.afterAck?.(60 + index);
  }
  assert.equal(jobs.length, 0);
  assert.equal(captures.length, 0);
  assert.equal(observations.every((value) => (value as { callbackKind: string }).callbackKind === "unsupported"), true);
});

test("deduplicates copied text links by the real WeChat message id", () => {
  const { service, jobs } = setup();
  const xml = textXml("https://mp.weixin.qq.com/s/copied");
  const first = service.planPost(query(), xml);
  const duplicate = service.planPost(query(), xml);
  assert.equal(first.probeId, duplicate.probeId);
  assert.equal(duplicate.duplicate, true);
  first.afterAck?.(60);
  duplicate.afterAck?.(61);
  assert.equal(jobs.length, 1);
});

test("a duplicate retry can claim the shared probe after the first response never finishes", async () => {
  const rawXml = await readFile(linkFixture, "utf8");
  const { service, jobs } = setup();
  const abandoned = service.planPost(query(), rawXml);
  const retry = service.planPost(query(), rawXml);
  assert.equal(abandoned.probeId, retry.probeId);
  assert.equal(retry.duplicate, true);
  // Simulate an aborted first response: only the retry reaches finish.
  retry.afterAck?.(60);
  abandoned.afterAck?.(61);
  assert.equal(jobs.length, 1);
});

test("after-ACK port failures are isolated and do not prevent scheduling", async () => {
  const rawXml = await readFile(linkFixture, "utf8");
  const clock = new Clock();
  const jobs: unknown[] = [];
  const service = createCallbackService({
    config: { ...FIXTURE_CONFIG, publicBaseUrl: new URL("https://probe.example/") },
    clock,
    scheduler: { enqueue(job) { jobs.push(job); } },
    fingerprint: { hmac(value) { return createHmac("sha256", "test-key").update(value).digest("hex"); } },
    observation: { record() { throw new Error("observation down"); } },
    replayCapture: { capture() { throw new Error("replay down"); } },
    newProbeId: () => "isolated-probe",
  });
  const plan = service.planPost(query(), rawXml);
  assert.doesNotThrow(() => plan.afterAck?.(60));
  assert.equal(jobs.length, 1);
});

test("uses a route receipt for ACK time and monotonic 24-hour dedupe expiry", async () => {
  const rawXml = await readFile(linkFixture, "utf8");
  const { service, jobs, observations, clock } = setup();
  const receipt = { callbackReceivedAt: "2024-01-01T00:00:00.000Z", callbackReceivedMonoMs: 100 };
  const first = service.planPost(query(), rawXml, "wechat", receipt);
  first.afterAck?.(300);
  assert.equal((observations[0] as { ackLatencyMs: number; callbackReceivedAt: string }).ackLatencyMs, 200);
  assert.equal((observations[0] as { callbackReceivedAt: string }).callbackReceivedAt, receipt.callbackReceivedAt);
  clock.wall = new Date("2000-01-01T00:00:00.000Z");
  clock.mono = 100 + 24 * 60 * 60 * 1000 - 1;
  const beforeExpiry = service.planPost(query(), rawXml, "wechat", { callbackReceivedAt: clock.wall.toISOString(), callbackReceivedMonoMs: clock.mono });
  assert.equal(beforeExpiry.duplicate, true);
  clock.mono += 1;
  const expired = service.planPost(query(), rawXml, "wechat", { callbackReceivedAt: clock.wall.toISOString(), callbackReceivedMonoMs: clock.mono });
  assert.equal(expired.duplicate, false);
  assert.equal(jobs.length, 1);
});

test("rejected callbacks remain observable but have no raw capture or job", () => {
  const { service, observations, captures, jobs } = setup();
  const plan = service.planRejected(401, { callbackReceivedAt: "2024-01-01T00:00:00.000Z", callbackReceivedMonoMs: 10 });
  plan.afterAck?.(15);
  assert.deepEqual(observations.length, 1);
  assert.equal((observations[0] as { callbackKind: string; signatureValid: boolean }).callbackKind, "invalid");
  assert.equal((observations[0] as { signatureValid: boolean }).signatureValid, false);
  assert.equal(captures.length, 0);
  assert.equal(jobs.length, 0);
});

test("admin replay neither captures nor schedules and a later real callback can claim its probe", async () => {
  const rawXml = await readFile(linkFixture, "utf8");
  const { service, captures, jobs } = setup();
  const replay = service.planPost(query(), rawXml, "admin_replay");
  replay.afterAck?.(60);
  const real = service.planPost(query(), rawXml);
  real.afterAck?.(61);
  assert.equal(replay.probeId, real.probeId);
  assert.equal(captures.length, 1);
  assert.equal(jobs.length, 1);
});

test("a scheduler failure releases its reservation so a real retry can enqueue", async () => {
  const rawXml = await readFile(linkFixture, "utf8");
  const clock = new Clock();
  let attempts = 0;
  const service = createCallbackService({
    config: { ...FIXTURE_CONFIG, publicBaseUrl: new URL("https://probe.example/") },
    clock,
    scheduler: { enqueue() { attempts += 1; if (attempts === 1) throw new Error("scheduler unavailable"); } },
    fingerprint: { hmac(value) { return createHmac("sha256", "test-key").update(value).digest("hex"); } },
    observation: { record() {} },
    replayCapture: { capture() {} },
    newProbeId: () => "retry-probe",
  });
  const first = service.planPost(query(), rawXml);
  const retry = service.planPost(query(), rawXml);
  first.afterAck?.(60);
  retry.afterAck?.(61);
  assert.equal(attempts, 2);
});

test("malformed absolute URL remains a link job with linkUrlParsed false", async () => {
  const rawXml = (await readFile(linkFixture, "utf8")).replace("https://mp.weixin.qq.com/s/example?source=probe&amp;scene=1", "not an absolute URL");
  const { service, jobs } = setup();
  const plan = service.planPost(query(), rawXml);
  plan.afterAck?.(60);
  assert.equal((jobs[0] as { rawUrl: string }).rawUrl, "not an absolute URL");
});

test("syntactically valid non-network URLs are marked parsed for later worker policy", async () => {
  const rawXml = (await readFile(linkFixture, "utf8")).replace("https://mp.weixin.qq.com/s/example?source=probe&amp;scene=1", "mailto:later" + "@example.test");
  const { service, observations } = setup();
  const plan = service.planPost(query(), rawXml);
  plan.afterAck?.(60);
  assert.equal((observations[0] as { linkUrlParsed: boolean }).linkUrlParsed, true);
});
