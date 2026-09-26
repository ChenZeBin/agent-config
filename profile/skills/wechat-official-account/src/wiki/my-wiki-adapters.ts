import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { CompileQueuePort } from "./wiki-compiler.js";
import type { MyWikiIngestPort } from "./wiki-worker.js";

type ScanResult = Awaited<ReturnType<CompileQueuePort["scan"]>>;
type ClaimResult = Awaited<ReturnType<CompileQueuePort["claim"]>>;

export async function createMyWikiIngestPort(repoRoot: string, fetchImpl?: (input: string | URL, init?: { readonly method?: string; readonly redirect?: string; readonly signal?: AbortSignal; readonly headers?: HeadersInit }) => Promise<Response>): Promise<MyWikiIngestPort> {
  const root = resolve(repoRoot);
  const moduleUrl = pathToFileURL(join(root, ".agents", "skills", "wechat-ingest", "scripts", "wechat_auto_capture.mjs"));
  const loaded: unknown = await import(moduleUrl.href);
  const ingestUrl = (loaded as { ingestUrl?: unknown }).ingestUrl;
  if (typeof ingestUrl !== "function") throw new Error("MY_WIKI_INGEST_UNAVAILABLE");
  return async (url, requestedRoot) => {
    if (resolve(requestedRoot) !== root) throw new Error("WIKI_REPO_MISMATCH");
    const result: unknown = await ingestUrl({ url, repo: root, ...(fetchImpl === undefined ? {} : { fetchImpl }) });
    if (result === null || typeof result !== "object") throw new Error("MY_WIKI_INGEST_INVALID");
    const value = result as Record<string, unknown>;
    if (typeof value.raw_bundle !== "string" || typeof value.bundle_checksum !== "string" || typeof value.content_checksum !== "string") throw new Error("MY_WIKI_INGEST_INVALID");
    return { raw_bundle: value.raw_bundle, bundle_checksum: value.bundle_checksum, content_checksum: value.content_checksum };
  };
}

export async function createCompileQueuePort(repoRoot: string): Promise<CompileQueuePort> {
  const root = resolve(repoRoot);
  const moduleUrl = pathToFileURL(join(root, ".agents", "skills", "article-ingest", "scripts", "article_compile_queue.mjs"));
  const loaded: unknown = await import(moduleUrl.href);
  const api = loaded as Record<string, unknown>;
  if (typeof api.scanCompileQueue !== "function" || typeof api.claimNextBundle !== "function" || typeof api.releaseCompileLock !== "function") throw new Error("MY_WIKI_QUEUE_UNAVAILABLE");
  const scan = api.scanCompileQueue as (repo: string) => Promise<unknown>;
  const claim = api.claimNextBundle as (repo: string) => Promise<unknown>;
  const release = api.releaseCompileLock as (repo: string, claimId: string) => Promise<unknown>;
  return {
    async scan() { return await scan(root) as ScanResult; },
    async claim() { return await claim(root) as ClaimResult; },
    async release(claimId) { await release(root, claimId); },
  };
}
