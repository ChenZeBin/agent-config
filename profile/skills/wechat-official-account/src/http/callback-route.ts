import type { IncomingMessage, ServerResponse } from "node:http";

import type { CallbackPlan, CallbackReceipt, CallbackService, ProbeClock } from "../wechat/callback-service.js";
import type { WeChatCallbackQuery } from "../wechat/contracts.js";

export const MAX_CALLBACK_BODY_BYTES = 256 * 1024;

function valueOnce(values: URLSearchParams, name: string): string | null | undefined {
  const found = values.getAll(name);
  if (found.length > 1) return undefined;
  return found[0] ?? null;
}

/** Returns null for a query that is ambiguous or contains invalid protocol switches. */
function rawQueryIsStrictUtf8(rawQuery: string): boolean {
  const bytes: number[] = [];
  for (let index = 0; index < rawQuery.length; index += 1) {
    if (rawQuery[index] === "%") {
      const escape = rawQuery.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(escape)) return false;
      bytes.push(Number.parseInt(escape, 16));
      index += 2;
      continue;
    }
    const character = rawQuery[index] ?? "";
    bytes.push(...Buffer.from(character, "utf8"));
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    return true;
  } catch {
    return false;
  }
}

export function normalizeWeChatCallbackQuery(url: URL, rawQuery: string = url.search.slice(1)): WeChatCallbackQuery | null {
  if (!rawQueryIsStrictUtf8(rawQuery)) return null;
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (seen.has(key)) return null;
    seen.add(key);
  }
  const signature = valueOnce(url.searchParams, "signature");
  const msgSignature = valueOnce(url.searchParams, "msg_signature");
  const timestamp = valueOnce(url.searchParams, "timestamp");
  const nonce = valueOnce(url.searchParams, "nonce");
  const echoStr = valueOnce(url.searchParams, "echostr");
  const encrypt = valueOnce(url.searchParams, "encrypt_type");
  if ([signature, msgSignature, timestamp, nonce, echoStr, encrypt].some((value) => value === undefined)) return null;
  if (encrypt !== null && encrypt !== "aes") return null;
  return { signature: signature ?? null, msgSignature: msgSignature ?? null, timestamp: timestamp ?? null, nonce: nonce ?? null, echoStr: echoStr ?? null, encryptType: encrypt === "aes" ? "aes" : null };
}

type BodyResult = { readonly kind: "ok"; readonly rawXml: string } | { readonly kind: "too_large" | "invalid_utf8" };

async function readCallbackBody(request: IncomingMessage): Promise<BodyResult> {
  let total = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const item of request) {
      const chunk = Buffer.isBuffer(item) ? item : Buffer.from(item as string);
      total += chunk.length;
      if (total > MAX_CALLBACK_BODY_BYTES) {
        request.resume();
        return { kind: "too_large" };
      }
      chunks.push(chunk);
    }
  } catch {
    return { kind: "invalid_utf8" };
  }
  try {
    return { kind: "ok", rawXml: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { kind: "invalid_utf8" };
  }
}

function endPlan(response: ServerResponse, plan: CallbackPlan, clock: ProbeClock): void {
  response.statusCode = plan.statusCode;
  response.setHeader("content-type", plan.contentType);
  // The listener is deliberately registered before end. No port is reachable
  // before finish and setImmediate creates a hard ACK boundary.
  response.once("finish", () => {
    setImmediate(() => {
      try { plan.afterAck?.(clock.monotonicNowMs()); } catch { /* response already completed */ }
    });
  });
  response.end(plan.body);
}

function closeAfterPreBodyTermination(request: IncomingMessage, response: ServerResponse): void {
  // Do not wait for an attacker-controlled declared body to arrive. Draining
  // lets Node release buffered input while Connection: close prevents this
  // incomplete request from pinning a keep-alive socket.
  request.resume();
  response.shouldKeepAlive = false;
  response.setHeader("connection", "close");
}

function endPreBodyPlan(request: IncomingMessage, response: ServerResponse, plan: CallbackPlan, clock: ProbeClock): void {
  closeAfterPreBodyTermination(request, response);
  endPlan(response, plan, clock);
}

function endPreBodyImmediate(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  closeAfterPreBodyTermination(request, response);
  endImmediate(response, statusCode, body, headers);
}

function endImmediate(response: ServerResponse, statusCode: number, body: string, headers: Record<string, string> = {}): void {
  response.statusCode = statusCode;
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}

export function endRouteFailure(response: ServerResponse): void {
  if (response.writableEnded) return;
  if (!response.headersSent) {
    endImmediate(response, 500, "internal server error");
    return;
  }
  response.end();
}

export function createCallbackRoute(options: { readonly service: CallbackService; readonly clock: ProbeClock }) {
  return async function callbackRoute(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Capture this before query parsing or body reads. It is the sole receipt
    // clock passed into callback planning, so ACK latency covers the full body.
    const receipt: CallbackReceipt = {
      callbackReceivedAt: options.clock.wallNow().toISOString(),
      callbackReceivedMonoMs: options.clock.monotonicNowMs(),
    };
    const url = new URL(request.url ?? "/", "http://callback.invalid");
    if (url.pathname !== "/wechat") {
      endPreBodyImmediate(request, response, 404, "not found");
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      endPreBodyImmediate(request, response, 405, "method not allowed", { allow: "GET, POST" });
      return;
    }
    const rawRequestUrl = request.url ?? "";
    const questionMark = rawRequestUrl.indexOf("?");
    const rawQuery = questionMark === -1 ? "" : rawRequestUrl.slice(questionMark + 1);
    const query = normalizeWeChatCallbackQuery(url, rawQuery);
    if (query === null) {
      if (request.method === "GET") {
        endPreBodyPlan(request, response, options.service.planGet({ signature: null, msgSignature: null, timestamp: null, nonce: null, echoStr: null, encryptType: null }, receipt), options.clock);
        return;
      }
      endPreBodyPlan(request, response, options.service.planRejected(401, receipt), options.clock);
      return;
    }
    if (request.method === "GET") {
      endPlan(response, options.service.planGet(query, receipt), options.clock);
      return;
    }
    const declaredLength = request.headers["content-length"];
    if (typeof declaredLength === "string" && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_CALLBACK_BODY_BYTES) {
      // Do not invoke the service: an oversized body must never be parsed.
      endPreBodyPlan(request, response, options.service.planRejected(413, receipt), options.clock);
      return;
    }
    const body = await readCallbackBody(request);
    if (body.kind !== "ok") {
      if (body.kind === "too_large") {
        closeAfterPreBodyTermination(request, response);
      }
      endPlan(response, options.service.planRejected(body.kind === "too_large" ? 413 : 401, receipt), options.clock);
      return;
    }
    endPlan(response, options.service.planPost(query, body.rawXml, "wechat", receipt), options.clock);
  };
}
