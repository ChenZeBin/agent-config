import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { canonicalizeArticleUrl } from "../article/url-policy.js";
import { parseEncryptedEnvelopeXml, parsePlainCallbackXml } from "./callback-xml.js";
import type { WeChatCallbackQuery } from "./contracts.js";
import { decryptWeChatPayload, encryptWeChatPayload, serializeEncryptedReplyXml } from "./crypto.js";
import { passiveResultText, serializePassiveTextReply } from "./passive-reply.js";
import { verifySha1Signature } from "./signature.js";

export type { WeChatCallbackQuery } from "./contracts.js";

export interface AcceptedProbeJob {
  readonly probeId: string;
  readonly probeHmac: string;
  readonly callbackTraceHmac: string;
  readonly receiptHmac: string;
  readonly senderHmac: string;
  readonly urlHmac: string;
  readonly eventTraceHmac: string;
  readonly rawUrl: string;
  readonly callbackReceivedAt: string;
  readonly callbackReceivedMonoMs: number;
}

export type CallbackSource = "wechat" | "admin_replay";

export interface CallbackObservation {
  readonly callbackTraceHmac: string;
  readonly probeHmac: string | null;
  readonly receiptHmac: string | null;
  readonly senderHmac: string | null;
  readonly callbackReceivedAt: string;
  readonly ackLatencyMs: number;
  readonly statusCode: number;
  readonly signatureValid: boolean;
  readonly callbackKind: "link" | "text_link" | "unsupported" | "invalid";
  readonly callbackSource: CallbackSource;
  readonly duplicateCallback: boolean;
  readonly linkUrlParsed: boolean | null;
}

export interface CallbackObservationPort { record(input: CallbackObservation): void; }
export interface ReplayCapturePort {
  capture(input: { readonly mode: "plaintext" | "aes"; readonly query: WeChatCallbackQuery; readonly rawXml: string; readonly receiptHmac: string }): void;
}
export interface FingerprintPort { hmac(value: string | Uint8Array, domain?: string): string; }
export interface CallbackPlan {
  readonly statusCode: 200 | 401 | 413;
  readonly contentType: "text/plain; charset=utf-8" | "application/xml; charset=utf-8";
  readonly body: string;
  readonly probeId: string | null;
  readonly duplicate: boolean;
  readonly afterAck: ((responseCompletedMonoMs: number) => void) | null;
}
export interface ProbeSchedulerPort { enqueue(job: AcceptedProbeJob): boolean | void; }
export interface CallbackService {
  planGet(query: WeChatCallbackQuery, receipt?: CallbackReceipt): CallbackPlan;
  planPost(query: WeChatCallbackQuery, rawXml: string, source?: CallbackSource, receipt?: CallbackReceipt): CallbackPlan;
  planRejected(statusCode: 401 | 413, receipt: CallbackReceipt, source?: CallbackSource): CallbackPlan;
}
export interface ProbeClock { wallNow(): Date; monotonicNowMs(): number; }
export interface CallbackReceipt {
  readonly callbackReceivedAt: string;
  readonly callbackReceivedMonoMs: number;
}

interface DedupeValue {
  readonly probeId: string;
  readonly expiresAtMonoMs: number;
  state: "unclaimed" | "enqueuing" | "enqueued";
}

type Config = {
  readonly token: string;
  readonly appId: string;
  readonly encodingAesKey: string | null;
  readonly publicBaseUrl: URL;
  /** undefined is test/backward-compatible open mode; null is safe pairing-only mode. */
  readonly authorizedSenderHmac?: string | null;
};

const TEXT: CallbackPlan["contentType"] = "text/plain; charset=utf-8";
const XML: CallbackPlan["contentType"] = "application/xml; charset=utf-8";

function sameOpaqueValue(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

function randomProbeId(): string {
  // 24 bytes is 192 bits and base64url avoids path escaping.
  return randomBytes(24).toString("base64url");
}

function validFields(query: WeChatCallbackQuery): query is WeChatCallbackQuery & { timestamp: string; nonce: string } {
  return query.timestamp !== null && query.nonce !== null;
}

function plainSignatureValid(config: Config, query: WeChatCallbackQuery): boolean {
  return validFields(query) && query.signature !== null && verifySha1Signature([config.token, query.timestamp, query.nonce], query.signature);
}

function aesSignatureValid(config: Config, query: WeChatCallbackQuery, encrypt: string): boolean {
  return validFields(query) && query.msgSignature !== null && verifySha1Signature([config.token, query.timestamp, query.nonce, encrypt], query.msgSignature);
}

function canParseAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function copiedArticleUrl(value: string): string | null {
  if (value.length === 0 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const canonical = canonicalizeArticleUrl(value);
    const path = new URL(canonical.href).pathname;
    return path === "/s" || path.startsWith("/s/") ? value : null;
  } catch {
    return null;
  }
}

export function createCallbackService(options: {
  readonly config: Config;
  readonly clock: ProbeClock;
  readonly scheduler: ProbeSchedulerPort;
  readonly fingerprint: FingerprintPort;
  readonly observation: CallbackObservationPort;
  readonly replayCapture: ReplayCapturePort;
  readonly newProbeId?: () => string;
}): CallbackService {
  const dedupe = new Map<string, DedupeValue>();
  const newProbeId = options.newProbeId ?? randomProbeId;

  function getDedupe(key: string, nowMonoMs: number): DedupeValue | null {
    for (const [candidate, value] of dedupe) {
      if (value.expiresAtMonoMs <= nowMonoMs) dedupe.delete(candidate);
    }
    return dedupe.get(key) ?? null;
  }

  function planGet(query: WeChatCallbackQuery, receipt: CallbackReceipt = readReceipt()): CallbackPlan {
    if (query.echoStr === null || !validFields(query)) return invalidGetPlan(receipt);
    if (query.encryptType === "aes") {
      if (options.config.encodingAesKey === null || !aesSignatureValid(options.config, query, query.echoStr)) return invalidGetPlan(receipt);
      try {
        return { statusCode: 200, contentType: TEXT, body: decryptWeChatPayload(query.echoStr, { ...options.config, encodingAesKey: options.config.encodingAesKey }), probeId: null, duplicate: false, afterAck: null };
      } catch {
        return invalidGetPlan(receipt);
      }
    }
    if (!plainSignatureValid(options.config, query)) return invalidGetPlan(receipt);
    return { statusCode: 200, contentType: TEXT, body: query.echoStr, probeId: null, duplicate: false, afterAck: null };
  }

  function planPost(query: WeChatCallbackQuery, rawXml: string, source: CallbackSource = "wechat", receipt: CallbackReceipt = readReceipt()): CallbackPlan {
    const { callbackReceivedAt, callbackReceivedMonoMs } = receipt;
    const callbackTraceHmac = options.fingerprint.hmac(rawXml, "callback-trace");
    const mode = query.encryptType === "aes" ? "aes" : "plaintext";
    let signatureValid = false;
    let decryptedXml = rawXml;

    if (mode === "aes") {
      // Authentication intentionally comes before parsing the envelope or decrypting it.
      signatureValid = query.msgSignature !== null && validFields(query) && (() => {
        try {
          return aesSignatureValid(options.config, query, parseEncryptedEnvelopeXml(rawXml).encrypt);
        } catch { return false; }
      })();
      if (!signatureValid || options.config.encodingAesKey === null) {
        return postFailure({ callbackTraceHmac, callbackReceivedAt, callbackReceivedMonoMs, signatureValid, source, mode, query, rawXml });
      }
      try {
        const encrypt = parseEncryptedEnvelopeXml(rawXml).encrypt;
        decryptedXml = decryptWeChatPayload(encrypt, { ...options.config, encodingAesKey: options.config.encodingAesKey });
      } catch {
        return postFailure({ callbackTraceHmac, callbackReceivedAt, callbackReceivedMonoMs, signatureValid, source, mode, query, rawXml });
      }
    } else {
      signatureValid = plainSignatureValid(options.config, query);
      if (!signatureValid) return postFailure({ callbackTraceHmac, callbackReceivedAt, callbackReceivedMonoMs, signatureValid, source, mode, query, rawXml });
    }

    let parsed: ReturnType<typeof parsePlainCallbackXml>;
    try { parsed = parsePlainCallbackXml(decryptedXml); }
    catch { return postFailure({ callbackTraceHmac, callbackReceivedAt, callbackReceivedMonoMs, signatureValid, source, mode, query, rawXml }); }

    const textUrl = parsed.kind === "text" ? copiedArticleUrl(parsed.message.content) : null;
    if (parsed.kind === "unsupported" || (parsed.kind === "text" && textUrl === null)) {
      return postPlan({ statusCode: 200, contentType: TEXT, body: "success", probeId: null, duplicate: false }, {
        callbackTraceHmac, receiptHmac: null, senderHmac: null, probeHmac: null, callbackReceivedAt, callbackReceivedMonoMs,
        signatureValid, callbackKind: "unsupported", source, duplicate: false, linkUrlParsed: null, mode, query, rawXml, job: null,
      });
    }

    const { message } = parsed;
    const senderHmac = options.fingerprint.hmac(message.fromUserName, "sender");
    if (options.config.authorizedSenderHmac !== undefined && (options.config.authorizedSenderHmac === null || !sameOpaqueValue(senderHmac, options.config.authorizedSenderHmac))) {
      return postPlan({ statusCode: 200, contentType: TEXT, body: "success", probeId: null, duplicate: false }, {
        callbackTraceHmac, receiptHmac: null, senderHmac, probeHmac: null, callbackReceivedAt, callbackReceivedMonoMs,
        signatureValid, callbackKind: "unsupported", source, duplicate: false, linkUrlParsed: null, mode, query, rawXml, job: null,
      });
    }
    const rawUrl = parsed.kind === "link" ? parsed.message.url : textUrl!;
    const callbackKind: CallbackObservation["callbackKind"] = parsed.kind === "link" ? "link" : "text_link";
    const receiptHmac = options.fingerprint.hmac(`${options.config.appId}\0${message.msgId}`, "receipt");
    const existing = getDedupe(receiptHmac, callbackReceivedMonoMs);
    const probeId = existing?.probeId ?? newProbeId();
    const reservation = existing ?? { probeId, expiresAtMonoMs: callbackReceivedMonoMs + 24 * 60 * 60 * 1000, state: "unclaimed" as const };
    if (existing === null) dedupe.set(receiptHmac, reservation);
    const probeHmac = options.fingerprint.hmac(probeId, "probe");
    const urlHmac = options.fingerprint.hmac(rawUrl, "url"); const eventTraceHmac = options.fingerprint.hmac(probeId, "event-reopen");
    const resultUrl = new URL(`/probe/events/${probeId}`, options.config.publicBaseUrl.origin).href;
    const plainReply = serializePassiveTextReply({ toUserName: message.fromUserName, fromUserName: message.toUserName, createTime: Math.floor(options.clock.wallNow().getTime() / 1000), content: passiveResultText(resultUrl) });
    let body = plainReply;
    let contentType: CallbackPlan["contentType"] = XML;
    if (mode === "aes") {
      try {
        body = serializeEncryptedReplyXml(encryptWeChatPayload(plainReply, query.timestamp!, query.nonce!, { ...options.config, encodingAesKey: options.config.encodingAesKey! }));
      } catch {
        return postFailure({ callbackTraceHmac, callbackReceivedAt, callbackReceivedMonoMs, signatureValid, source, mode, query, rawXml, receiptHmac, senderHmac });
      }
    }
    const duplicate = existing !== null;
    const linkUrlParsed = parsed.kind === "text" || canParseAbsoluteUrl(rawUrl);
    // A reservation is intentionally not marked enqueued here. The first
    // response may disconnect before finish; a WeChat retry must then claim
    // this same probe and enqueue it exactly once after its own ACK.
    const job: AcceptedProbeJob = {
      probeId, probeHmac, callbackTraceHmac, receiptHmac, senderHmac, urlHmac, eventTraceHmac,
      rawUrl,
      callbackReceivedAt, callbackReceivedMonoMs,
    };
    return postPlan({ statusCode: 200, contentType, body, probeId, duplicate }, {
      callbackTraceHmac, receiptHmac, senderHmac, probeHmac, callbackReceivedAt, callbackReceivedMonoMs,
      signatureValid, callbackKind, source, duplicate, linkUrlParsed, mode, query, rawXml, job,
      claimJob: () => {
        if (reservation.state !== "unclaimed") return false;
        reservation.state = "enqueuing";
        return true;
      },
      commitJob: () => { reservation.state = "enqueued"; },
      releaseJob: () => { reservation.state = "unclaimed"; },
    });
  }

  function postFailure(input: {
    callbackTraceHmac: string; callbackReceivedAt: string; callbackReceivedMonoMs: number; signatureValid: boolean; source: CallbackSource;
    mode: "plaintext" | "aes"; query: WeChatCallbackQuery; rawXml: string; receiptHmac?: string; senderHmac?: string;
  }): CallbackPlan {
    return postPlan({ statusCode: 401, contentType: TEXT, body: "", probeId: null, duplicate: false }, {
      callbackTraceHmac: input.callbackTraceHmac, receiptHmac: input.receiptHmac ?? null, senderHmac: input.senderHmac ?? null, probeHmac: null,
      callbackReceivedAt: input.callbackReceivedAt, callbackReceivedMonoMs: input.callbackReceivedMonoMs, signatureValid: input.signatureValid,
      callbackKind: "invalid", source: input.source, duplicate: false, linkUrlParsed: null, mode: input.mode, query: input.query, rawXml: input.rawXml, job: null,
    });
  }

  function planRejected(statusCode: 401 | 413, receipt: CallbackReceipt, source: CallbackSource = "wechat"): CallbackPlan {
    const callbackTraceHmac = options.fingerprint.hmac(`callback-rejected\0${receipt.callbackReceivedAt}\0${receipt.callbackReceivedMonoMs}`, "callback-rejected");
    return postPlan({ statusCode, contentType: TEXT, body: "", probeId: null, duplicate: false }, {
      callbackTraceHmac, receiptHmac: null, senderHmac: null, probeHmac: null,
      callbackReceivedAt: receipt.callbackReceivedAt, callbackReceivedMonoMs: receipt.callbackReceivedMonoMs,
      signatureValid: false, callbackKind: "invalid", source, duplicate: false, linkUrlParsed: null,
      mode: "plaintext", query: emptyQuery(), rawXml: "", job: null,
    });
  }

  function invalidGetPlan(receipt: CallbackReceipt): CallbackPlan {
    // Query data is deliberately not fingerprinted. This is a domain-separated,
    // synthetic rejection solely proving that a bad verification attempt occurred.
    const callbackTraceHmac = options.fingerprint.hmac(`invalid-handshake\0${receipt.callbackReceivedAt}\0${receipt.callbackReceivedMonoMs}`, "invalid-handshake");
    return postPlan({ statusCode: 401, contentType: TEXT, body: "", probeId: null, duplicate: false }, {
      callbackTraceHmac, receiptHmac: null, senderHmac: null, probeHmac: null,
      callbackReceivedAt: receipt.callbackReceivedAt, callbackReceivedMonoMs: receipt.callbackReceivedMonoMs,
      signatureValid: false, callbackKind: "invalid", source: "wechat", duplicate: false, linkUrlParsed: null,
      mode: "plaintext", query: emptyQuery(), rawXml: "", job: null,
    });
  }

  function postPlan(plan: Omit<CallbackPlan, "afterAck">, input: {
    callbackTraceHmac: string; receiptHmac: string | null; senderHmac: string | null; probeHmac: string | null;
    callbackReceivedAt: string; callbackReceivedMonoMs: number; signatureValid: boolean; callbackKind: CallbackObservation["callbackKind"];
    source: CallbackSource; duplicate: boolean; linkUrlParsed: boolean | null; mode: "plaintext" | "aes"; query: WeChatCallbackQuery; rawXml: string; job: AcceptedProbeJob | null; claimJob?: () => boolean; commitJob?: () => void; releaseJob?: () => void;
  }): CallbackPlan {
    return {
      ...plan,
      afterAck(responseCompletedMonoMs) {
        const observation: CallbackObservation = {
          callbackTraceHmac: input.callbackTraceHmac, probeHmac: input.probeHmac, receiptHmac: input.receiptHmac, senderHmac: input.senderHmac,
          callbackReceivedAt: input.callbackReceivedAt, ackLatencyMs: Math.max(0, responseCompletedMonoMs - input.callbackReceivedMonoMs), statusCode: plan.statusCode,
          signatureValid: input.signatureValid, callbackKind: input.callbackKind, callbackSource: input.source, duplicateCallback: input.duplicate, linkUrlParsed: input.linkUrlParsed,
        };
        try { options.observation.record(observation); } catch { /* an ACK may never be revoked */ }
        if (input.signatureValid && input.source === "wechat" && input.receiptHmac !== null) {
          try { options.replayCapture.capture({ mode: input.mode, query: input.query, rawXml: input.rawXml, receiptHmac: input.receiptHmac }); } catch { /* best effort only */ }
        }
        if (input.source === "wechat" && input.job !== null && (input.claimJob?.() ?? true)) {
          try {
            const accepted = options.scheduler.enqueue(input.job);
            if (accepted === false) input.releaseJob?.(); else input.commitJob?.();
          } catch {
            input.releaseJob?.();
          }
        }
      },
    };
  }

  function readReceipt(): CallbackReceipt {
    return { callbackReceivedAt: options.clock.wallNow().toISOString(), callbackReceivedMonoMs: options.clock.monotonicNowMs() };
  }

  return { planGet, planPost, planRejected };
}

function emptyQuery(): WeChatCallbackQuery {
  return { signature: null, msgSignature: null, timestamp: null, nonce: null, echoStr: null, encryptType: null };
}
