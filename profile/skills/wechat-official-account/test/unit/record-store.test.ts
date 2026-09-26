import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, open, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProbeEvidenceError, canonicalizeRecord, createNdjsonProbeRecordStore } from "../../src/probe/record-store.js";
import { createProbeRedactor } from "../../src/probe/redaction.js";

const secret = "k".repeat(32);
test("redacts every persisted value with versioned HMACs and independently readable lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-record-"));
  const path = join(dir, "records.ndjson");
  const redact = createProbeRedactor(secret);
  const store = await createNdjsonProbeRecordStore({ path });
  await store.append(redact.callback({ probeId: "RAW_PROBE", rawCallback: "RAW_XML", openId: "RAW_OPENID", msgId: "RAW_MSG", url: "https://mp.weixin.qq.com/s/RAW_URL", at: "2024-01-01T00:00:00.000Z", stage: "accepted", callbackKind: "link", callbackSource: "wechat", signatureValid: true }));
  const raw = await readFile(path, "utf8");
  for (const sentinel of ["RAW_PROBE", "RAW_XML", "RAW_OPENID", "RAW_MSG", "RAW_URL"]) assert.equal(raw.includes(sentinel), false);
  const row = JSON.parse(raw) as Record<string, unknown>;
  for (const key of ["probeHmac", "callbackTraceHmac", "senderHmac", "receiptHmac", "urlHmac"]) assert.match(String(row[key]), /^h1:[A-Za-z0-9_-]{43}$/);
  assert.equal((await (async () => { const got: unknown[] = []; for await (const item of store.readAll()) got.push(item); return got; })()).length, 1);
});

test("fails closed for partial or malformed evidence and refuses symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-record-"));
  const partial = join(dir, "partial.ndjson");
  await writeFile(partial, '{"schemaVersion":1}');
  await chmod(partial, 0o600);
  const store = await createNdjsonProbeRecordStore({ path: partial });
  await assert.rejects(async () => { for await (const _ of store.readAll()) { /* drain */ } }, (error: unknown) => error instanceof ProbeEvidenceError && error.code === "EVIDENCE_MISSING");
  const target = join(dir, "target"); const link = join(dir, "link");
  await writeFile(target, "x"); await symlink(target, link);
  await assert.rejects(() => createNdjsonProbeRecordStore({ path: link }));
  const corrupt = join(dir, "corrupt.ndjson"); await writeFile(corrupt, "{not-json}\n"); await chmod(corrupt, 0o600);
  const corruptStore = await createNdjsonProbeRecordStore({ path: corrupt });
  await assert.rejects(async () => { for await (const _ of corruptStore.readAll()) { /* drain */ } }, (error: unknown) => error instanceof ProbeEvidenceError && error.code === "EVIDENCE_CORRUPT");
});

test("corrects existing mode and rejects a group-writable or symlinked parent before open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-record-")); const path = join(dir, "records.ndjson");
  await writeFile(path, ""); await chmod(path, 0o644);
  const store = await createNdjsonProbeRecordStore({ path });
  const redact = createProbeRedactor(secret);
  await store.append(redact.callback({ probeId: "a", rawCallback: "b", openId: null, msgId: null, at: "2024-01-01T00:00:00.000Z", stage: "callback_rejected", callbackKind: "invalid", callbackSource: "wechat", signatureValid: false }));
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const unsafe = join(dir, "unsafe"); await mkdir(unsafe, { mode: 0o700 }); await chmod(unsafe, 0o722);
  await assert.rejects(() => createNdjsonProbeRecordStore({ path: join(unsafe, "records.ndjson") }));
});

test("post-open inode verification rejects a replacement supplied by the file adapter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-record-")); const path = join(dir, "records.ndjson"); const replacement = join(dir, "replacement.ndjson");
  await writeFile(path, ""); await writeFile(replacement, ""); const original = await lstat(path);
  const store = await createNdjsonProbeRecordStore({ path, operations: { lstat(candidate) { return candidate === path ? Promise.resolve(original) : lstat(candidate); }, open(_candidate, flags, mode) { return open(replacement, flags, mode); }, readFile } });
  const redact = createProbeRedactor(secret);
  await assert.rejects(() => store.append(redact.callback({ probeId: "a", rawCallback: "b", openId: null, msgId: null, at: "2024-01-01T00:00:00.000Z", stage: "callback_rejected", callbackKind: "invalid", callbackSource: "wechat", signatureValid: false })), /record storage rejected/);
});

test("canonicalization rejects hostile objects and malformed optional evidence synchronously", () => {
  const good = createProbeRedactor(secret).callback({ probeId: "a", rawCallback: "b", openId: null, msgId: null, at: "2024-01-01T00:00:00.000Z", stage: "callback_rejected", callbackKind: "invalid", callbackSource: "wechat", signatureValid: false });
  const inherited = Object.create(good) as Record<string, unknown>; assert.throws(() => canonicalizeRecord(inherited));
  const getter = { ...good }; Object.defineProperty(getter, "failureCode", { enumerable: true, get() { throw new Error("RAW_FAILURE_SENTINEL"); } }); assert.throws(() => canonicalizeRecord(getter));
  const toJson = { ...good, toJSON() { return "RAW_TOJSON"; } }; assert.throws(() => canonicalizeRecord(toJson));
  const symbol = { ...good, [Symbol("RAW_SYMBOL")]: "x" }; assert.throws(() => canonicalizeRecord(symbol));
  const proxy = new Proxy({ ...good }, { get(target, key, receiver) { if (key === "failureCode") return "RAW_ARTICLE_SENTINEL"; return Reflect.get(target, key, receiver); } });
  assert.equal(JSON.stringify(canonicalizeRecord(proxy)).includes("RAW_ARTICLE_SENTINEL"), false);
  assert.throws(() => canonicalizeRecord({ ...good, failureCode: "RAW failure sentinel" })); assert.throws(() => canonicalizeRecord({ ...good, bodySha256: "not-a-hash" })); assert.throws(() => canonicalizeRecord({ ...good, ackLatencyMs: -1 }));
});

test("new-file create races fail closed rather than replacing an attacker-created target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-record-")); const path = join(dir, "race.ndjson");
  const store = await createNdjsonProbeRecordStore({ path, operations: { lstat, readFile, async open() { const error = Object.assign(new Error("exists"), { code: "EEXIST" }); throw error; } } });
  const record = createProbeRedactor(secret).callback({ probeId: "a", rawCallback: "b", openId: null, msgId: null, at: "2024-01-01T00:00:00.000Z", stage: "callback_rejected", callbackKind: "invalid", callbackSource: "wechat", signatureValid: false });
  await assert.rejects(() => store.append(record));
});

test("readAll rejects non-exact mode and sanitizes close failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-record-")); const path = join(dir, "records.ndjson"); const record = createProbeRedactor(secret).callback({ probeId: "a", rawCallback: "b", openId: null, msgId: null, at: "2024-01-01T00:00:00.000Z", stage: "callback_rejected", callbackKind: "invalid", callbackSource: "wechat", signatureValid: false });
  await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 }); await chmod(path, 0o700); const wrongMode = await createNdjsonProbeRecordStore({ path });
  await assert.rejects(async () => { for await (const _ of wrongMode.readAll()) { /* drain */ } }, (error: unknown) => error instanceof ProbeEvidenceError && error.code === "EVIDENCE_CORRUPT");
  await chmod(path, 0o4600); if (((await lstat(path)).mode & 0o7777) === 0o4600) await assert.rejects(async () => { for await (const _ of wrongMode.readAll()) { /* drain */ } }, (error: unknown) => error instanceof ProbeEvidenceError && error.code === "EVIDENCE_CORRUPT");
  await chmod(path, 0o600); const closeStore = await createNdjsonProbeRecordStore({ path, operations: { lstat, readFile, async open(candidate, flags, mode) { const handle = await open(candidate, flags, mode); Object.defineProperty(handle, "close", { value: async () => { throw new Error("RAW_CLOSE_SENTINEL"); } }); return handle; } } });
  await assert.rejects(async () => { for await (const _ of closeStore.readAll()) { /* drain */ } }, (error: unknown) => error instanceof ProbeEvidenceError && !error.message.includes("RAW_CLOSE_SENTINEL"));
});

test("proxy reflection failures become generic validation failures", async () => {
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("RAW_PROXY_ERROR_SENTINEL"); } });
  assert.throws(() => canonicalizeRecord(hostile), (error: unknown) => error instanceof Error && error.message === "invalid redacted record");
  const dir = await mkdtemp(join(tmpdir(), "probe-record-")); const store = await createNdjsonProbeRecordStore({ path: join(dir, "records.ndjson") });
  await assert.rejects(() => store.append(hostile as never), (error: unknown) => error instanceof Error && error.message === "invalid redacted record");
});

test("round-trips every closed Task 8 feedback code and rejects raw substitutes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-record-")); const store = await createNdjsonProbeRecordStore({ path: join(dir, "records.ndjson") }); const base = createProbeRedactor(secret).callback({ probeId: "a", rawCallback: "b", openId: null, msgId: null, at: "2024-01-01T00:00:00.000Z", stage: "feedback_rejected", callbackKind: "invalid", callbackSource: "wechat", signatureValid: false });
  const codes = ["WX_FEEDBACK_WINDOW_CLOSED", "WX_FEEDBACK_PROBE_CONFLICT", "WX_FEEDBACK_URL_REJECTED", "WX_FEEDBACK_TOKEN_REJECTED", "WX_FEEDBACK_REDIRECT_REJECTED", "WX_FEEDBACK_RESPONSE_LIMIT", "WX_FEEDBACK_RESPONSE_INVALID", "WX_FEEDBACK_TIMEOUT", "WX_FEEDBACK_NETWORK_FAILED", "WX_FEEDBACK_HTTP_FAILED", "WX_FEEDBACK_PLATFORM_REJECTED"] as const;
  for (const failureCode of codes) await store.append({ ...base, stage: "feedback_rejected", feedbackResult: "rejected", failureCode });
  const rows = []; for await (const row of store.readAll()) rows.push(row); assert.deepEqual(rows.map((row) => row.failureCode), codes); assert.throws(() => canonicalizeRecord({ ...base, failureCode: "RAW_ARTICLE_SENTINEL" }));
});
