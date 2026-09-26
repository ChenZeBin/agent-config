import type { ProbeEventView, RedactedProbeRecord } from "./contracts.js";

const TOKEN = /^[A-Za-z0-9_-]{32}$/;
type Meta = Pick<RedactedProbeRecord, "probeHmac" | "receiptHmac" | "senderHmac" | "at"> & { readonly eventTraceHmac: string };
interface Entry { view: ProbeEventView; meta: Meta; }
export interface ProbeEventStore { create(token: string, meta: Meta): ProbeEventView; setTerminal(token: string, outcome: "completed" | "failed", at: string): ProbeEventView | null; lookup(token: string): ProbeEventView | null; markReopened(token: string, at: string): RedactedProbeRecord | null; readonly reopens: number; }
export function createEventStore(): ProbeEventStore {
  const entries = new Map<string, Entry>(); let reopens = 0;
  return {
    get reopens() { return reopens; },
    create(token, meta) { if (!TOKEN.test(token)) throw new Error("invalid event token"); const existing = entries.get(token); if (existing !== undefined) return existing.view; const view = Object.freeze({ probeId: token, state: "processing" as const, updatedAt: meta.at }); entries.set(token, { view, meta: Object.freeze({ ...meta }) }); return view; },
    setTerminal(token, outcome, at) { const entry = entries.get(token); if (entry === undefined) return null; const view = Object.freeze({ probeId: token, state: outcome, updatedAt: at }); entry.view = view; return view; },
    lookup(token) { if (!TOKEN.test(token)) return null; return entries.get(token)?.view ?? null; },
    markReopened(token, at) { if (!TOKEN.test(token)) return null; const entry = entries.get(token); if (entry === undefined) return null; reopens += 1; return Object.freeze({ schemaVersion: 1, probeHmac: entry.meta.probeHmac, callbackTraceHmac: entry.meta.eventTraceHmac, at, stage: "reopened", receiptHmac: entry.meta.receiptHmac, senderHmac: entry.meta.senderHmac }); },
  };
}
