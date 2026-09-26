export type ProbeStage = "callback_rejected" | "callback_ignored" | "accepted" | "fetching" | "extracted" | "fetch_failed" | "feedback_sent" | "feedback_rejected" | "reopened";

export interface RedactedProbeRecord {
  readonly schemaVersion: 1;
  readonly probeHmac: string | null;
  readonly callbackTraceHmac: string;
  readonly at: string;
  readonly stage: ProbeStage;
  readonly receiptHmac: string | null;
  readonly senderHmac: string | null;
  readonly urlHmac?: string;
  readonly host?: "mp.weixin.qq.com";
  readonly signatureValid?: boolean;
  readonly callbackKind?: "link" | "text_link" | "unsupported" | "invalid";
  readonly callbackSource?: "wechat" | "admin_replay";
  readonly duplicateCallback?: boolean;
  readonly linkUrlParsed?: boolean;
  readonly ackLatencyMs?: number;
  readonly httpStatus?: number;
  readonly bodyCodePoints?: number;
  readonly bodySha256?: string;
  readonly failureCode?: string;
  readonly feedbackChannel?: "passive_link" | "customer_service";
  readonly feedbackResult?: "sent" | "rejected" | "unsupported";
}
export interface ProbeEventView { readonly probeId: string; readonly state: "processing" | "completed" | "failed"; readonly updatedAt: string; }
export interface ProbeRecordStore { append(record: RedactedProbeRecord): Promise<void>; readAll(): AsyncIterable<RedactedProbeRecord>; }
/** `eligibleUntil` is a trusted callback-receipt timestamp plus the fixed 48h WeChat window. */
export interface CompletionFeedbackInput { readonly probeId: string; readonly recipientOpenId: string; readonly outcome: "completed" | "failed"; readonly reopenUrl: string; readonly eligibleUntil: string; }
export type CompletionFeedbackRejectionCode = "WX_FEEDBACK_WINDOW_CLOSED" | "WX_FEEDBACK_PROBE_CONFLICT" | "WX_FEEDBACK_URL_REJECTED" | "WX_FEEDBACK_TOKEN_REJECTED" | "WX_FEEDBACK_REDIRECT_REJECTED" | "WX_FEEDBACK_RESPONSE_LIMIT" | "WX_FEEDBACK_RESPONSE_INVALID" | "WX_FEEDBACK_TIMEOUT" | "WX_FEEDBACK_NETWORK_FAILED" | "WX_FEEDBACK_HTTP_FAILED" | "WX_FEEDBACK_PLATFORM_REJECTED";
export interface CompletionFeedbackPort { send(input: CompletionFeedbackInput): Promise<{ readonly kind: "sent"; readonly channel: "passive_link" | "customer_service" } | { readonly kind: "unsupported"; readonly code: CompletionFeedbackRejectionCode } | { readonly kind: "rejected"; readonly code: CompletionFeedbackRejectionCode }>; }
