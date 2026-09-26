import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import type { CanonicalArticleUrl, PinnedResponse } from "../article/contracts.js";
import { canonicalizeArticleUrl } from "../article/url-policy.js";

export interface PinnedArticleClient {
  request(url: CanonicalArticleUrl, options: { readonly signal: AbortSignal; readonly connectTimeoutMs: number; readonly headersTimeoutMs: number }): Promise<PinnedResponse>;
}

type SafeFetchInit = {
  readonly method?: string;
  readonly redirect?: string;
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
};

function stable(code: string): Error { return new Error(code); }
function headerValue(value: string | readonly string[] | undefined): string | null {
  if (value === undefined) return null;
  return typeof value === "string" ? value : value.join(", ");
}

async function decodedBody(response: PinnedResponse, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const source = response.stream as Readable;
  const encoding = (headerValue(response.headers["content-encoding"]) ?? "identity").trim().toLowerCase();
  let readable: Readable = source;
  if (encoding === "gzip" || encoding === "x-gzip") readable = source.pipe(createGunzip());
  else if (encoding === "br") readable = source.pipe(createBrotliDecompress());
  else if (encoding === "deflate") readable = source.pipe(createInflate());
  else if (encoding !== "" && encoding !== "identity") { source.destroy(); throw stable("SAFE_FETCH_ENCODING_REJECTED"); }
  const abort = (): void => { source.destroy(); if (readable !== source) readable.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of readable) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > maxBytes) { abort(); throw stable("SAFE_FETCH_BODY_LIMIT"); }
      chunks.push(bytes);
    }
    if (signal.aborted) throw stable("SAFE_FETCH_ABORTED");
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SAFE_FETCH_")) throw error;
    throw stable(signal.aborted ? "SAFE_FETCH_ABORTED" : "SAFE_FETCH_DECODE_FAILED");
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function createSafeWeChatFetch(options: {
  readonly client: PinnedArticleClient;
  readonly maxDecodedBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly headersTimeoutMs?: number;
}): (input: string | URL, init?: SafeFetchInit) => Promise<Response> {
  const maxDecodedBytes = options.maxDecodedBytes ?? 20 * 1024 * 1024;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const headersTimeoutMs = options.headersTimeoutMs ?? 10_000;
  return async (input, init = {}) => {
    if (init.redirect !== "manual" || (init.method !== undefined && init.method !== "GET")) throw stable("SAFE_FETCH_OPTIONS_REJECTED");
    let url: CanonicalArticleUrl;
    try { url = canonicalizeArticleUrl(String(input)); } catch { throw stable("SAFE_FETCH_URL_REJECTED"); }
    const controller = init.signal === undefined ? new AbortController() : null;
    const signal = init.signal ?? controller!.signal;
    if (signal.aborted) throw stable("SAFE_FETCH_ABORTED");
    const response = await options.client.request(url, { signal, connectTimeoutMs, headersTimeoutMs });
    const body = await decodedBody(response, maxDecodedBytes, signal);
    if (!Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode > 599) throw stable("SAFE_FETCH_STATUS_REJECTED");
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      const normalized = headerValue(value);
      if (normalized !== null && name.toLowerCase() !== "content-encoding" && name.toLowerCase() !== "content-length") headers.set(name, normalized);
    }
    const exact = new Uint8Array(body.byteLength);
    exact.set(body);
    return new Response(exact.buffer, { status: response.statusCode, headers });
  };
}
