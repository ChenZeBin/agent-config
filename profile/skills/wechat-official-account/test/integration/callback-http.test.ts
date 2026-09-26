import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import test from "node:test";

import { createCallbackService } from "../../src/wechat/callback-service.js";
import { createCallbackServer } from "../../src/http/server.js";
import { createEventStore } from "../../src/probe/event-store.js";
import { FIXTURE_CONFIG } from "../helpers/wechat-fixture-crypto.js";

const fixturePath = resolve("test/fixtures/wechat-link-plain.xml");
const timestamp = "1712345678";
const nonce = "http-nonce";
const signature = createHash("sha1").update([FIXTURE_CONFIG.token, timestamp, nonce].sort().join("")).digest("hex");

test("HTTP finishes its ACK before observation, replay capture, or scheduler work", async (t) => {
  let mono = 20;
  let wall = new Date("2024-04-05T06:07:08.000Z");
  const enqueued: unknown[] = [];
  let responseFinished = false;
  const observation = new (class extends EventTarget { last: { ackLatencyMs: number; callbackReceivedAt: string } | null = null; record(value: { ackLatencyMs: number; callbackReceivedAt: string }) { this.last = value; this.dispatchEvent(new Event("recorded")); } })();
  const replay = { capture() { throw new Error("capture failure must not alter ACK"); } };
  const service = createCallbackService({
    config: { ...FIXTURE_CONFIG, publicBaseUrl: new URL("https://probe.example/") },
    clock: { wallNow: () => new Date(wall), monotonicNowMs: () => mono++ },
    scheduler: { enqueue(job) { assert.equal(responseFinished, true, "worker must not start before response finish"); enqueued.push(job); } },
    fingerprint: { hmac(value) { return createHmac("sha256", "http-key").update(value).digest("hex"); } },
    observation,
    replayCapture: replay,
    newProbeId: () => "http-probe",
  });
  const server = createCallbackServer({ service, clock: { wallNow: () => new Date(wall), monotonicNowMs: () => mono++ } });
  server.on("request", (_request, response) => { response.once("finish", () => { responseFinished = true; }); });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const rawXml = await readFile(fixturePath, "utf8");
  const observationRecorded = once(observation, "recorded");
  const response = await new Promise<import("node:http").IncomingMessage>((resolveResponse, reject) => {
    const client = request(`http://127.0.0.1:${port}/wechat?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`, { method: "POST" }, resolveResponse);
    client.once("error", reject);
    client.end(rawXml);
  });
  const responseEnded = once(response, "end");
  response.resume();
  await responseEnded;
  await observationRecorded;
  assert.equal(enqueued.length, 1);
  assert.equal((observation.last?.ackLatencyMs ?? -1) >= 0, true);
  assert.equal(observation.last?.callbackReceivedAt, "2024-04-05T06:07:08.000Z");
  wall = new Date("2020-01-01T00:00:00.000Z");

  const oversized = await fetch(`http://127.0.0.1:${port}/wechat`, { method: "POST", body: "x".repeat(256 * 1024 + 1) });
  assert.equal(oversized.status, 413);
  const method = await fetch(`http://127.0.0.1:${port}/wechat`, { method: "PUT" });
  assert.equal(method.status, 405);
});

test("route receipt starts before a delayed body and rejects raw query and UTF-8 safely", async (t) => {
  const observations: Array<{ ackLatencyMs: number; callbackKind: string; signatureValid: boolean }> = [];
  const jobs: unknown[] = [];
  const service = createCallbackService({
    config: { ...FIXTURE_CONFIG, publicBaseUrl: new URL("https://probe.example/") },
    clock: { wallNow: () => new Date("2024-04-05T06:07:08.000Z"), monotonicNowMs: () => performance.now() },
    scheduler: { enqueue(job) { jobs.push(job); } },
    fingerprint: { hmac(value) { return createHmac("sha256", "http-key").update(value).digest("hex"); } },
    observation: { record(value) { observations.push(value); } },
    replayCapture: { capture() { throw new Error("must not capture rejects"); } },
    newProbeId: () => "delayed-probe",
  });
  const server = createCallbackServer({ service, clock: { wallNow: () => new Date("2024-04-05T06:07:08.000Z"), monotonicNowMs: () => performance.now() } });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const rawXml = await readFile(fixturePath, "utf8");
  await new Promise<void>((resolveRequest, reject) => {
    const client = request(`http://127.0.0.1:${port}/wechat?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`, { method: "POST" }, (response) => { response.resume(); response.once("end", resolveRequest); });
    client.once("error", reject);
    client.write(rawXml.slice(0, 30));
    setTimeout(() => client.end(rawXml.slice(30)), 200);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((observations[0]?.ackLatencyMs ?? -1) >= 180, true);

  const invalidUtf8 = await fetch(`http://127.0.0.1:${port}/wechat?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`, { method: "POST", body: new Uint8Array([0xff, 0xfe]) });
  assert.equal(invalidUtf8.status, 401);
  const badPercent = await fetch(`http://127.0.0.1:${port}/wechat?signature=%zz`, { method: "POST", body: "x" });
  assert.equal(badPercent.status, 401);
  const uppercaseAlias = await fetch(`http://127.0.0.1:${port}/wechat?Signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`, { method: "POST", body: "x" });
  assert.equal(uppercaseAlias.status, 401);
  const preflightLimit = await fetch(`http://127.0.0.1:${port}/wechat`, { method: "POST", headers: { "content-length": String(256 * 1024 + 1) }, body: "x".repeat(256 * 1024 + 1) });
  assert.equal(preflightLimit.status, 413);
  const prefix = "<xml><MsgType>text</MsgType><Padding>";
  const suffix = "</Padding></xml>";
  const exactBody = `${prefix}${"x".repeat(256 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`;
  const exactLimit = await fetch(`http://127.0.0.1:${port}/wechat?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`, { method: "POST", body: exactBody });
  assert.equal(exactLimit.status, 200);
  const chunkedLimit = await new Promise<number>((resolveResponse, reject) => {
    const client = request(`http://127.0.0.1:${port}/wechat?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`, { method: "POST" }, (response) => { response.resume(); response.once("end", () => resolveResponse(response.statusCode ?? 0)); });
    client.once("error", reject);
    client.write("x".repeat(128 * 1024));
    client.end("x".repeat(128 * 1024 + 1));
  });
  assert.equal(chunkedLimit, 413);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observations.filter((value) => value.callbackKind === "invalid" && !value.signatureValid).length >= 3, true);
  assert.equal(jobs.length, 1);
});

test("ACK-time planner failures become a safe 500 without an unhandled rejection", async (t) => {
  const throwingService = {
    planGet() { throw new Error("planner failure"); },
    planPost() { throw new Error("planner failure"); },
    planRejected() { throw new Error("planner failure"); },
  };
  const server = createCallbackServer({
    service: throwingService,
    clock: { wallNow: () => new Date(), monotonicNowMs: () => performance.now() },
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/wechat?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=hello`);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), "internal server error");
});

test("an invalid GET produces its synthetic observation only after finish", async (t) => {
  const observed: unknown[] = []; let finished = false;
  const service = createCallbackService({ config: { ...FIXTURE_CONFIG, publicBaseUrl: new URL("https://probe.example/") }, clock: { wallNow: () => new Date("2024-01-01T00:00:00.000Z"), monotonicNowMs: () => performance.now() }, scheduler: { enqueue() {} }, fingerprint: { hmac(value) { return createHmac("sha256", "synthetic").update(value).digest("hex"); } }, observation: { record(value) { assert.equal(finished, true); observed.push(value); } }, replayCapture: { capture() {} } });
  const server = createCallbackServer({ service, clock: { wallNow: () => new Date("2024-01-01T00:00:00.000Z"), monotonicNowMs: () => performance.now() } }); server.on("request", (_request, response) => response.once("finish", () => { finished = true; })); t.after(() => server.close()); server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/wechat?signature=bad&timestamp=1&nonce=2&echostr=RAW_ECHO_SENTINEL`); assert.equal(response.status, 401); await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(observed.length, 1); assert.equal(finished, true); assert.equal(JSON.stringify(observed).includes("RAW_ECHO_SENTINEL"), false);
});

test("pre-body rejections answer immediately and close an incomplete keep-alive socket", async (t) => {
  const service = createCallbackService({
    config: { ...FIXTURE_CONFIG, publicBaseUrl: new URL("https://probe.example/") },
    clock: { wallNow: () => new Date(), monotonicNowMs: () => performance.now() },
    scheduler: { enqueue() {} },
    fingerprint: { hmac(value) { return createHmac("sha256", "socket-key").update(value).digest("hex"); } },
    observation: { record() {} },
    replayCapture: { capture() {} },
  });
  const server = createCallbackServer({ service, clock: { wallNow: () => new Date(), monotonicNowMs: () => performance.now() } });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  async function partialRequest(method: string, target: string): Promise<string> {
    return new Promise<string>((resolveResult, reject) => {
      const socket = connect(port, "127.0.0.1");
      let response = "";
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error("server left pre-body rejection socket open")); }, 500);
      socket.on("connect", () => socket.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\nContent-Length: 1048576\r\n\r\nx`));
      socket.on("data", (chunk: Buffer) => { response += chunk.toString("utf8"); });
      socket.on("close", () => { clearTimeout(timeout); resolveResult(response); });
      socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
    });
  }

  const invalidQuery = await partialRequest("POST", "/wechat?signature=%zz");
  assert.match(invalidQuery, /HTTP\/1\.1 401/);
  assert.match(invalidQuery, /connection: close/i);
  const preflightLimit = await partialRequest("POST", `/wechat?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`);
  assert.match(preflightLimit, /HTTP\/1\.1 413/);
  assert.match(preflightLimit, /connection: close/i);
  const missingRoute = await partialRequest("POST", "/missing");
  assert.match(missingRoute, /HTTP\/1\.1 404/);
  assert.match(missingRoute, /connection: close/i);
  const badMethod = await partialRequest("PUT", "/wechat");
  assert.match(badMethod, /HTTP\/1\.1 405/);
  assert.match(badMethod, /connection: close/i);
});

test("malformed raw request targets receive a closed failure response without crashing the server", async (t) => {
  const service = {
    planGet() { return { statusCode: 401 as const, contentType: "text/plain; charset=utf-8" as const, body: "", probeId: null, duplicate: false, afterAck: null }; },
    planPost() { return { statusCode: 401 as const, contentType: "text/plain; charset=utf-8" as const, body: "", probeId: null, duplicate: false, afterAck: null }; },
    planRejected() { return { statusCode: 401 as const, contentType: "text/plain; charset=utf-8" as const, body: "", probeId: null, duplicate: false, afterAck: null }; },
  };
  const server = createCallbackServer({ service, clock: { wallNow: () => new Date(), monotonicNowMs: () => performance.now() }, events: createEventStore(), observation: { record() {} } });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const response = await new Promise<string>((resolveResponse, reject) => {
    const socket = connect(port, "127.0.0.1");
    let body = "";
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error("malformed target was not closed")); }, 500);
    socket.on("connect", () => socket.write("GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
    socket.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    socket.on("close", () => { clearTimeout(timeout); resolveResponse(body); });
    socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
  });
  assert.match(response, /HTTP\/1\.1 500/);
});
