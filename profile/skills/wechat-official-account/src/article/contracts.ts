import type { RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";

declare const canonicalArticleUrlBrand: unique symbol;

export interface CanonicalArticleUrl {
  readonly href: string;
  readonly host: "mp.weixin.qq.com";
  readonly [canonicalArticleUrlBrand]: true;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface AddressResolver {
  resolveAll(host: string): Promise<readonly ResolvedAddress[]>;
}

export interface PinnedResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly stream: NodeJS.ReadableStream;
  readonly peerAddress: ResolvedAddress;
}

export interface PinnedHttpsTransport {
  request(input: {
    readonly url: CanonicalArticleUrl;
    readonly address: ResolvedAddress;
    readonly signal: AbortSignal;
    readonly connectTimeoutMs: number;
    readonly headersTimeoutMs: number;
  }): Promise<PinnedResponse>;
}

export interface NodeHttpsRequestFactory {
  request(options: RequestOptions, onResponse: (response: IncomingMessage) => void): ClientRequest;
}
