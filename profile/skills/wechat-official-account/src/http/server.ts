import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { createCallbackRoute, endRouteFailure } from "./callback-route.js";
import type { CallbackService, ProbeClock } from "../wechat/callback-service.js";
import type { ReplayBuffer } from "../probe/replay-buffer.js";
import { createEventRoute } from "./event-route.js";
import type { ProbeEventStore } from "../probe/event-store.js";
import type { RedactedProbeRecord } from "../probe/contracts.js";

export interface CallbackServerOptions {
  readonly service: CallbackService;
  readonly clock: ProbeClock;
  readonly events?: ProbeEventStore;
  readonly observation?: { record(record: RedactedProbeRecord): void };
}

/** Creates the deliberately narrow public WeChat callback server. */
export function createCallbackServer(options: CallbackServerOptions): Server {
  const route = createCallbackRoute(options);
  const eventRoute = options.events === undefined || options.observation === undefined
    ? null
    : createEventRoute({ events: options.events, observation: options.observation, now: () => options.clock.wallNow().toISOString() });
  return createServer((request, response) => {
    let pathname: string | null = null;
    try { pathname = new URL(request.url ?? "/", "http://callback.invalid").pathname; } catch { /* callback route emits one closed generic failure */ }
    if (eventRoute !== null && pathname?.startsWith("/probe/events/") === true) {
      eventRoute(request, response);
      return;
    }
    void route(request, response).catch(() => {
      try {
        endRouteFailure(response);
      } catch {
        try {
          response.destroy();
          response.socket?.destroy();
        } catch {
          // The request is already beyond any recoverable response state.
        }
      }
    });
  });
}

function closeRequest(request: IncomingMessage, response: ServerResponse, status: number): void { if (response.writableEnded) return; request.resume(); response.shouldKeepAlive = false; response.statusCode = status; response.setHeader("connection", "close"); response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify({ status: status === 401 ? "unauthorized" : "invalid" })); }
function authorized(request: IncomingMessage, expectedDigest: Buffer): boolean {
  const values = request.rawHeaders.filter((_, index, all) => index % 2 === 0 && all[index]?.toLowerCase() === "x-probe-admin-token");
  const value = request.headers["x-probe-admin-token"];
  if (values.length !== 1 || typeof value !== "string" || value.length === 0) return false;
  return timingSafeEqual(createHash("sha256").update(value).digest(), expectedDigest);
}
/** A separate loopback-only control surface. It never serializes captured payloads. */
export function createProbeAdminServer(options: { readonly token: string; readonly replay: ReplayBuffer; readonly service: CallbackService; readonly clock: ProbeClock }): Server {
  const digest = createHash("sha256").update(options.token).digest();
  async function body(request: IncomingMessage): Promise<boolean> { const length = request.headers["content-length"]; if (length !== undefined && (typeof length !== "string" || !/^\d+$/.test(length) || Number(length) > 8192)) { request.resume(); return false; } let total = 0; try { for await (const part of request) { total += Buffer.isBuffer(part) ? part.length : Buffer.byteLength(String(part)); if (total > 8192) { request.resume(); return false; } } return true; } catch { return false; } }
  return createServer((request, response) => { void (async () => {
    if (!authorized(request, digest)) { closeRequest(request, response, 401); return; }
    if (!await body(request)) { closeRequest(request, response, 400); return; }
    const url = new URL(request.url ?? "/", "http://admin.invalid");
    if (request.method === "GET" && url.pathname === "/probe/admin/replays") { response.setHeader("content-type", "application/json; charset=utf-8"); response.setHeader("cache-control", "no-store"); response.end(JSON.stringify({ captures: options.replay.list() })); return; }
    const match = request.method === "POST" ? /^\/probe\/admin\/replays\/(h1:[A-Za-z0-9_-]{43})$/.exec(url.pathname) : null;
    if (match === null) { closeRequest(request, response, 404); return; }
    const capture = options.replay.take(match[1] ?? ""); if (capture === null) { response.statusCode = 404; response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify({ status: "missing" })); return; }
    let plan: ReturnType<CallbackService["planPost"]>; try { plan = options.service.planPost(capture.query, capture.rawXml, "admin_replay"); } catch { response.statusCode = 500; response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify({ status: "failed" })); return; }
    response.once("finish", () => setImmediate(() => { try { plan.afterAck?.(options.clock.monotonicNowMs()); } catch { /* response has completed */ } })); response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify({ status: "replayed", receiptHmac: capture.receiptHmac, mode: capture.mode }));
  })().catch(() => closeRequest(request, response, 400)); });
}
export function startProbeAdminServer(options: { readonly port: number; readonly token: string; readonly replay: ReplayBuffer; readonly service: CallbackService; readonly clock: ProbeClock }): Server { const server = createProbeAdminServer(options); server.listen(options.port, "127.0.0.1"); return server; }
