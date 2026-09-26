import assert from "node:assert/strict";
import test from "node:test";

import type { AcceptedProbeJob } from "../../src/wechat/callback-service.js";
import { createEventStore } from "../../src/probe/event-store.js";
import { createSerialWikiScheduler } from "../../src/wiki/serial-scheduler.js";

function job(id: string): AcceptedProbeJob {
  return {
    probeId: id.repeat(32).slice(0, 32),
    probeHmac: "h1:" + "a".repeat(43),
    callbackTraceHmac: "h1:" + "b".repeat(43),
    receiptHmac: "h1:" + "c".repeat(43),
    senderHmac: "h1:" + "d".repeat(43),
    urlHmac: "h1:" + "e".repeat(43),
    eventTraceHmac: "h1:" + "f".repeat(43),
    rawUrl: "https://mp.weixin.qq.com/s/example",
    callbackReceivedAt: "2026-08-30T00:00:00.000Z",
    callbackReceivedMonoMs: 1,
  };
}

test("runs Wiki jobs one at a time, bounds the queue, and exposes an idle barrier", async () => {
  const events = createEventStore();
  const releases: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const scheduler = createSerialWikiScheduler({
    capacity: 2,
    events,
    now: () => "2026-08-30T00:00:01.000Z",
    run: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    },
  });

  const first = job("a");
  const second = job("b");
  assert.equal(scheduler.enqueue(first), true);
  assert.equal(scheduler.enqueue(second), true);
  const overflow = job("c");
  assert.equal(scheduler.enqueue(overflow), false);
  assert.equal(events.lookup(overflow.probeId)?.state, "failed");
  assert.equal(events.lookup(first.probeId)?.state, "processing");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(scheduler.health.active, 1);
  releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(events.lookup(first.probeId)?.state, "completed");
  assert.equal(scheduler.health.active, 1);
  releases.shift()?.();
  await scheduler.whenIdle();
  assert.equal(peak, 1);
  assert.deepEqual(scheduler.health, { accepting: true, active: 0, queued: 0 });

  scheduler.stopAccepting();
  assert.equal(scheduler.enqueue(job("d")), false);
  assert.equal(scheduler.health.accepting, false);
});

test("marks a failed worker terminal without leaking its error", async () => {
  const events = createEventStore();
  const scheduler = createSerialWikiScheduler({
    events,
    now: () => "2026-08-30T00:00:01.000Z",
    run: async () => { throw new Error("RAW_URL_SENTINEL"); },
  });
  const input = job("z");
  assert.equal(scheduler.enqueue(input), true);
  await scheduler.whenIdle();
  assert.equal(events.lookup(input.probeId)?.state, "failed");
});
