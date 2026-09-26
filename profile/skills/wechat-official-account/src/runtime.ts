import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";

import { createCallbackServer } from "./http/server.js";
import type { RedactedProbeRecord } from "./probe/contracts.js";
import { createEventStore } from "./probe/event-store.js";
import { createProbeFingerprint } from "./probe/redaction.js";
import { createCallbackService, type CallbackObservation, type CallbackObservationPort, type ProbeClock } from "./wechat/callback-service.js";
import { createSerialWikiScheduler, type SerialWikiScheduler } from "./wiki/serial-scheduler.js";

export interface WechatWikiRuntime {
  start(port: number, host?: string): Promise<void>;
  stop(): Promise<void>;
  whenIdle(): Promise<void>;
  readonly publicAddress: AddressInfo;
  readonly scheduler: SerialWikiScheduler;
}

const systemClock: ProbeClock = Object.freeze({ wallNow: () => new Date(), monotonicNowMs: () => performance.now() });

export function createWechatWikiRuntime(options: {
  readonly config: {
    readonly token: string;
    readonly appId: string;
    readonly encodingAesKey: string;
    readonly publicBaseUrl: URL;
    readonly authorizedSenderHmac: string | null;
  };
  readonly hmacKey: string;
  readonly worker: { run(job: import("./wechat/callback-service.js").AcceptedProbeJob): Promise<void> };
  readonly callbackObservation: CallbackObservationPort;
  readonly eventObservation: { record(record: RedactedProbeRecord): void };
  readonly clock?: ProbeClock;
  readonly capacity?: number;
  readonly newProbeId?: () => string;
}): WechatWikiRuntime {
  const clock = options.clock ?? systemClock;
  const events = createEventStore();
  const scheduler = createSerialWikiScheduler({
    run: (job) => options.worker.run(job),
    events,
    now: () => clock.wallNow().toISOString(),
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
  });
  const service = createCallbackService({
    config: { ...options.config },
    clock,
    scheduler,
    fingerprint: createProbeFingerprint(options.hmacKey),
    observation: options.callbackObservation,
    replayCapture: { capture() {} },
    ...(options.newProbeId === undefined ? {} : { newProbeId: options.newProbeId }),
  });
  const server = createCallbackServer({ service, clock, events, observation: options.eventObservation });
  let stopPromise: Promise<void> | null = null;

  return Object.freeze({
    scheduler,
    get publicAddress(): AddressInfo {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("SERVER_NOT_LISTENING");
      return address;
    },
    start(port: number, host?: string) {
      if (server.listening) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const listening = (): void => { server.off("error", failed); resolve(); };
        const failed = (): void => { server.off("listening", listening); reject(new Error("SERVER_START_FAILED")); };
        server.once("listening", listening);
        server.once("error", failed);
        if (host === undefined) server.listen(port); else server.listen(port, host);
      });
    },
    whenIdle() { return scheduler.whenIdle(); },
    stop() {
      if (stopPromise !== null) return stopPromise;
      stopPromise = (async () => {
        scheduler.stopAccepting();
        await new Promise<void>((resolve) => {
          if (!server.listening) { resolve(); return; }
          server.close(() => resolve());
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        await scheduler.whenIdle();
      })();
      return stopPromise;
    },
  });
}

export type { CallbackObservation };
