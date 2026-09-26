import type { ProbeEventStore } from "../probe/event-store.js";
import type { AcceptedProbeJob, ProbeSchedulerPort } from "../wechat/callback-service.js";

export interface SerialWikiScheduler extends ProbeSchedulerPort {
  enqueue(job: AcceptedProbeJob): boolean;
  stopAccepting(): void;
  whenIdle(): Promise<void>;
  readonly health: { readonly accepting: boolean; readonly active: number; readonly queued: number };
}

export function createSerialWikiScheduler(options: {
  readonly run: (job: AcceptedProbeJob) => Promise<void>;
  readonly events: ProbeEventStore;
  readonly now: () => string;
  readonly capacity?: number;
}): SerialWikiScheduler {
  const capacity = options.capacity ?? 16;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1024) throw new Error("invalid queue capacity");
  const queue: AcceptedProbeJob[] = [];
  const idleWaiters = new Set<() => void>();
  let accepting = true;
  let active = false;

  function signalIdle(): void {
    if (active || queue.length !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function pump(): void {
    if (active) return;
    const job = queue.shift();
    if (job === undefined) { signalIdle(); return; }
    active = true;
    void options.run(job).then(
      () => { options.events.setTerminal(job.probeId, "completed", options.now()); },
      () => { options.events.setTerminal(job.probeId, "failed", options.now()); },
    ).finally(() => {
      active = false;
      queueMicrotask(pump);
    });
  }

  return {
    get health() { return Object.freeze({ accepting, active: active ? 1 : 0, queued: queue.length }); },
    enqueue(job) {
      if (!accepting) return false;
      if (queue.length + (active ? 1 : 0) >= capacity) {
        options.events.create(job.probeId, {
          probeHmac: job.probeHmac,
          eventTraceHmac: job.eventTraceHmac,
          receiptHmac: job.receiptHmac,
          senderHmac: job.senderHmac,
          at: options.now(),
        });
        options.events.setTerminal(job.probeId, "failed", options.now());
        return false;
      }
      options.events.create(job.probeId, {
        probeHmac: job.probeHmac,
        eventTraceHmac: job.eventTraceHmac,
        receiptHmac: job.receiptHmac,
        senderHmac: job.senderHmac,
        at: options.now(),
      });
      queue.push(job);
      queueMicrotask(pump);
      return true;
    },
    stopAccepting() { accepting = false; },
    whenIdle() {
      if (!active && queue.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.add(resolve));
    },
  };
}
