import { createHmac } from "node:crypto";
import type { RedactedProbeRecord } from "./contracts.js";
import type { CallbackObservation, FingerprintPort } from "../wechat/callback-service.js";

const hmac = (key: string, domain: string, value: string | Uint8Array): string => `h1:${createHmac("sha256", key).update(domain).update("\0").update(value).digest("base64url")}`;
export interface ProbeRedactor { hmac(domain: string, value: string | Uint8Array): string; callback(input: { readonly probeId: string | null; readonly rawCallback: string; readonly openId: string | null; readonly msgId: string | null; readonly url?: string; readonly at: string; readonly stage: RedactedProbeRecord["stage"]; readonly callbackKind: "link" | "text_link" | "unsupported" | "invalid"; readonly callbackSource: "wechat" | "admin_replay"; readonly signatureValid: boolean }): RedactedProbeRecord; observation(input: CallbackObservation): RedactedProbeRecord; }
export function createProbeRedactor(key: string): ProbeRedactor {
  const fingerprint = (domain: string, value: string | Uint8Array) => hmac(key, domain, value);
  return {
    hmac: fingerprint,
    callback(input) {
      return Object.freeze({ schemaVersion: 1, probeHmac: input.probeId === null ? null : fingerprint("probe", input.probeId), callbackTraceHmac: fingerprint("callback-trace", input.rawCallback), at: input.at, stage: input.stage, receiptHmac: input.msgId === null ? null : fingerprint("receipt", input.msgId), senderHmac: input.openId === null ? null : fingerprint("sender", input.openId), ...(input.url === undefined ? {} : { urlHmac: fingerprint("url", input.url) }), signatureValid: input.signatureValid, callbackKind: input.callbackKind, callbackSource: input.callbackSource });
    },
    observation(input) {
      return Object.freeze({ schemaVersion: 1, probeHmac: input.probeHmac, callbackTraceHmac: input.callbackTraceHmac, at: input.callbackReceivedAt, stage: input.callbackKind === "invalid" ? "callback_rejected" : input.callbackKind === "unsupported" ? "callback_ignored" : "accepted", receiptHmac: input.receiptHmac, senderHmac: input.senderHmac, signatureValid: input.signatureValid, callbackKind: input.callbackKind, callbackSource: input.callbackSource, duplicateCallback: input.duplicateCallback, ...(input.linkUrlParsed === null ? {} : { linkUrlParsed: input.linkUrlParsed }), ackLatencyMs: input.ackLatencyMs, httpStatus: input.statusCode });
    },
  };
}
/** The callback service receives this narrow port; every call site supplies a stable domain. */
export function createProbeFingerprint(key: string): FingerprintPort { const redactor = createProbeRedactor(key); return Object.freeze({ hmac(value: string | Uint8Array, domain = "callback") { return redactor.hmac(domain, value); } }); }
