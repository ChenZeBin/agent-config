import { PassThrough } from "node:stream";
import type { CanonicalArticleUrl, PinnedHttpsTransport, PinnedResponse, ResolvedAddress } from "../../src/article/contracts.js";

export class FakeHttpsTransport implements PinnedHttpsTransport {
  readonly calls: Array<{ readonly url: CanonicalArticleUrl; readonly address: ResolvedAddress }> = [];

  constructor(private readonly failureAddresses = new Set<string>()) {}

  async request(input: Parameters<PinnedHttpsTransport["request"]>[0]): Promise<PinnedResponse> {
    this.calls.push({ url: input.url, address: input.address });
    if (this.failureAddresses.has(input.address.address)) {
      throw new Error("PINNED_HTTPS_CONNECT_FAILED");
    }
    return { statusCode: 200, headers: {}, stream: new PassThrough(), peerAddress: input.address };
  }
}
