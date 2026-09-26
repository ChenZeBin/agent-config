import https from "node:https";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { assertAllAddressesPublic, normalizeAddress } from "./address-policy.js";
import { reassertCanonicalArticleUrl } from "./url-policy.js";
import type {
  AddressResolver,
  CanonicalArticleUrl,
  NodeHttpsRequestFactory,
  PinnedHttpsTransport,
  PinnedResponse,
  ResolvedAddress,
} from "./contracts.js";

const DEFAULT_FACTORY: NodeHttpsRequestFactory = https;
const PUBLIC_ARTICLE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EADDRNOTAVAIL",
  "EADDRINUSE",
  "ENOBUFS",
  "ERR_SOCKET_CLOSED",
]);

function stableError(code: string): Error {
  return new Error(code);
}

function normalizedCandidate(address: ResolvedAddress): ResolvedAddress {
  const normalized = normalizeAddress(address.address);
  if (normalized.family !== address.family) {
    throw stableError("PINNED_HTTPS_INVALID_ADDRESS");
  }
  return normalized;
}

function sameAddress(left: string, right: ResolvedAddress): boolean {
  try {
    const normalized = normalizeAddress(left);
    return normalized.address === right.address && normalized.family === right.family;
  } catch {
    return false;
  }
}

function sameResolvedAddress(left: ResolvedAddress, right: ResolvedAddress): boolean {
  try {
    const normalized = normalizedCandidate(left);
    return normalized.address === right.address && normalized.family === right.family;
  } catch {
    return false;
  }
}

function destroyResponseStream(response: PinnedResponse): void {
  const stream = response.stream as NodeJS.ReadableStream & { destroy?: () => unknown };
  if (typeof stream.destroy === "function") {
    try {
      stream.destroy();
    } catch {
      // The peer mismatch remains the stable failure even if a test seam throws while closing.
    }
  }
}

function classifyTransportError(
  error: unknown,
  phase: "pre-secure" | "post-secure" | "factory",
): Error {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) {
    return stableError("PINNED_HTTPS_NETWORK_FAILED");
  }
  const isTlsFailure = typeof code === "string" && (
    /^(?:ERR_(?:TLS|SSL|OSSL|CERT)_|TLS_|SSL_|CERT_|CRL_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_)/.test(code) ||
    /^(?:INVALID_CA|PATH_LENGTH_EXCEEDED|INVALID_PURPOSE|HOSTNAME_MISMATCH|EPROTO)$/.test(code)
  );
  return stableError(
    isTlsFailure || phase === "pre-secure"
      ? "PINNED_HTTPS_TLS_FAILED"
      : "PINNED_HTTPS_NETWORK_FAILED",
  );
}

export function createPinnedHttpsClient(options: {
  readonly resolver: AddressResolver;
  readonly transport: PinnedHttpsTransport;
}): {
  request(
    url: CanonicalArticleUrl,
    options: { readonly signal: AbortSignal; readonly connectTimeoutMs: number; readonly headersTimeoutMs: number },
  ): Promise<PinnedResponse>;
} {
  return {
    async request(url, requestOptions): Promise<PinnedResponse> {
      const canonicalUrl = reassertCanonicalArticleUrl(url);
      if (requestOptions.signal.aborted) {
        throw stableError("PINNED_HTTPS_ABORTED");
      }
      const answers = await options.resolver.resolveAll(canonicalUrl.host);
      assertAllAddressesPublic(answers);
      const candidates = [...new Map(answers.map((answer) => {
        const normalized = normalizedCandidate(answer);
        return [`${normalized.family}:${normalized.address}`, normalized] as const;
      })).values()];

      let lastError: unknown = stableError("PINNED_HTTPS_CONNECT_FAILED");
      for (const address of candidates) {
        if (requestOptions.signal.aborted) {
          throw stableError("PINNED_HTTPS_ABORTED");
        }
        try {
          const response = await options.transport.request({ url: canonicalUrl, address, ...requestOptions });
          if (!sameResolvedAddress(response.peerAddress, address)) {
            destroyResponseStream(response);
            throw stableError("PINNED_HTTPS_PEER_MISMATCH");
          }
          return response;
        } catch (error) {
          if (error instanceof Error && error.message === "PINNED_HTTPS_PEER_MISMATCH") {
            throw error;
          }
          lastError = error;
        }
      }
      throw lastError;
    },
  };
}

export function createNodeHttpsTransport(factory: NodeHttpsRequestFactory = DEFAULT_FACTORY): PinnedHttpsTransport {
  return {
    request(input): Promise<PinnedResponse> {
      let canonicalUrl: CanonicalArticleUrl;
      try {
        canonicalUrl = reassertCanonicalArticleUrl(input.url);
      } catch {
        return Promise.reject(stableError("PINNED_HTTPS_URL_REJECTED"));
      }
      const address = normalizedCandidate(input.address);
      if (input.signal.aborted) {
        return Promise.reject(stableError("PINNED_HTTPS_ABORTED"));
      }
      const url = new URL(canonicalUrl.href);
      return new Promise<PinnedResponse>((resolve, reject) => {
        let settled = false;
        let socket: (Socket | TLSSocket) | undefined;
        let connectTimer: NodeJS.Timeout | undefined;
        let headersTimer: NodeJS.Timeout | undefined;
        let secure = false;
        let request: import("node:http").ClientRequest | undefined;

        const onRequestError = (error: unknown): void => finish(classifyTransportError(
          error,
          secure ? "post-secure" : "pre-secure",
        ));
        const onRequestClose = (): void => finish(stableError("PINNED_HTTPS_NETWORK_FAILED"));
        const onSocketError = (error: unknown): void => finish(classifyTransportError(
          error,
          secure ? "post-secure" : "pre-secure",
        ));
        const onSecureConnect = (): void => {
          secure = true;
          if (!sameAddress(socket?.remoteAddress ?? "", address)) {
            finish(stableError("PINNED_HTTPS_PEER_MISMATCH"));
            return;
          }
          if (connectTimer !== undefined) {
            clearTimeout(connectTimer);
            connectTimer = undefined;
          }
          headersTimer = setTimeout(() => finish(stableError("PINNED_HTTPS_HEADERS_TIMEOUT")), input.headersTimeoutMs);
        };

        const clearTimers = (): void => {
          if (connectTimer !== undefined) clearTimeout(connectTimer);
          if (headersTimer !== undefined) clearTimeout(headersTimer);
          connectTimer = undefined;
          headersTimer = undefined;
        };
        const finish = (error?: Error, response?: PinnedResponse): void => {
          if (settled) return;
          settled = true;
          clearTimers();
          input.signal.removeEventListener("abort", onAbort);
          socket?.removeListener("secureConnect", onSecureConnect);
          socket?.removeListener("error", onSocketError);
          request?.removeListener("socket", onSocket);
          request?.removeListener("error", onRequestError);
          request?.removeListener("close", onRequestClose);
          if (error !== undefined) {
            socket?.destroy();
            request?.destroy();
            reject(error);
          } else if (response !== undefined) {
            resolve(response);
          }
        };
        const onAbort = (): void => finish(stableError("PINNED_HTTPS_ABORTED"));
        const onSocket = (connectedSocket: Socket | TLSSocket): void => {
          socket = connectedSocket;
          connectedSocket.once("secureConnect", onSecureConnect);
          connectedSocket.once("error", onSocketError);
        };

        input.signal.addEventListener("abort", onAbort, { once: true });
        connectTimer = setTimeout(() => finish(stableError("PINNED_HTTPS_CONNECT_TIMEOUT")), input.connectTimeoutMs);
        try {
          const nodeOptions: import("node:https").RequestOptions & { readonly autoSelectFamily: false } = {
            protocol: "https:",
            hostname: canonicalUrl.host,
            port: 443,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers: {
              Host: canonicalUrl.host,
              Accept: "text/html,application/xhtml+xml",
              "Accept-Encoding": "gzip, br",
              "User-Agent": PUBLIC_ARTICLE_USER_AGENT,
            },
            servername: canonicalUrl.host,
            agent: false,
            family: address.family,
            autoSelectFamily: false,
            rejectUnauthorized: true,
            lookup: (_hostname, lookupOptions, callback) => {
              if (lookupOptions.all) {
                callback(null, [{ address: address.address, family: address.family }]);
                return;
              }
              callback(null, address.address, address.family);
            },
          };
          request = factory.request(nodeOptions, (response) => {
            if (!secure) {
              finish(stableError("PINNED_HTTPS_TLS_FAILED"));
              return;
            }
            if (headersTimer !== undefined) {
              clearTimeout(headersTimer);
              headersTimer = undefined;
            }
            finish(undefined, {
              statusCode: response.statusCode ?? 0,
              headers: response.headers,
              stream: response,
              peerAddress: address,
            });
          });
          if (settled) {
            request.destroy();
            return;
          }
          request.once("socket", onSocket);
          request.once("error", onRequestError);
          request.once("close", onRequestClose);
          request.end();
        } catch (error) {
          finish(classifyTransportError(error, "factory"));
        }
      });
    },
  };
}
