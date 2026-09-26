import type { WeChatCallbackQuery } from "../wechat/contracts.js";
import type { ReplayCapturePort } from "../wechat/callback-service.js";
export interface ReplayCapture { readonly receiptHmac: string; readonly mode: "plaintext" | "aes"; readonly query: WeChatCallbackQuery; readonly rawXml: string; }
export interface ReplayBuffer extends ReplayCapturePort { list(): readonly Pick<ReplayCapture, "receiptHmac" | "mode">[]; take(receiptHmac: string): ReplayCapture | null; }
export function createReplayBuffer(options: { readonly monotonicNowMs: () => number }): ReplayBuffer {
  const captures = new Map<string, { capture: ReplayCapture; expires: number }>(); const ttl = 24 * 60 * 60 * 1000;
  function purge() { const now = options.monotonicNowMs(); for (const [key, value] of captures) if (value.expires <= now) captures.delete(key); }
  return { capture(capture) { purge(); captures.delete(capture.receiptHmac); while (captures.size >= 5) captures.delete(captures.keys().next().value as string); captures.set(capture.receiptHmac, { capture: Object.freeze({ ...capture, query: Object.freeze({ ...capture.query }) }), expires: options.monotonicNowMs() + ttl }); }, list() { purge(); return [...captures.values()].map(({ capture }) => Object.freeze({ receiptHmac: capture.receiptHmac, mode: capture.mode })); }, take(receiptHmac) { purge(); return captures.get(receiptHmac)?.capture ?? null; } };
}
