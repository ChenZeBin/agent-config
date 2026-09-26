import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createServer } from "node:http";
import { createEventStore } from "../../src/probe/event-store.js";
import { createEventRoute } from "../../src/http/event-route.js";

test("renders only fixed event copy with strict token syntax and observes opens after finish", async (t) => {
  const events = createEventStore(); const token = "a".repeat(32); events.create(token, { probeHmac: "h1:probe", eventTraceHmac: "h1:event", receiptHmac: "h1:receipt", senderHmac: "h1:sender", at: "2024-01-01T00:00:00.000Z" });
  const server = createServer(createEventRoute({ events, observation: { record() {} } })); t.after(() => server.close()); server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/probe/events/${token}?ignored=RAW_QUERY_SENTINEL`); const body = await response.text();
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); assert.match(body, /my-wiki 知识更新/); assert.equal(body.includes(token), false);
  assert.equal((await fetch(`http://127.0.0.1:${port}/probe/events/%61${token.slice(1)}`)).status, 404);
  await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(events.reopens, 1);
});
