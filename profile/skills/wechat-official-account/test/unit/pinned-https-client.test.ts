import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createNodeHttpsTransport, createPinnedHttpsClient } from "../../src/article/pinned-https-client.js";
import { canonicalizeArticleUrl } from "../../src/article/url-policy.js";
import type { CanonicalArticleUrl, NodeHttpsRequestFactory, PinnedHttpsTransport, ResolvedAddress } from "../../src/article/contracts.js";
import { FakeDns } from "../helpers/fake-dns.js";
import { FakeHttpsTransport } from "../helpers/fake-https-transport.js";

const article = canonicalizeArticleUrl("https://mp.weixin.qq.com/s?mid=1");
const abort = new AbortController();
const requestOptions = { signal: abort.signal, connectTimeoutMs: 100, headersTimeoutMs: 100 };

// @ts-expect-error CanonicalArticleUrl must not be constructible as a structural object.
const structurallyForgedUrl: CanonicalArticleUrl = { host: "mp.weixin.qq.com", href: "https://mp.weixin.qq.com/s" };
void structurallyForgedUrl;

test("reasserts canonical URL values before either public entry point crosses a trust boundary", async () => {
  const forged = {
    host: "example.test",
    href: "https://example.test/private",
  } as unknown as CanonicalArticleUrl;
  const resolver = new FakeDns(new Map([["example.test", [{ address: "8.8.8.8", family: 4 }]]]));
  const transport = new FakeHttpsTransport();

  await assert.rejects(
    createPinnedHttpsClient({ resolver, transport }).request(forged, requestOptions),
    { message: "PINNED_HTTPS_URL_REJECTED" },
  );
  assert.deepEqual(resolver.calls, []);
  assert.deepEqual(transport.calls, []);

  let factoryCalls = 0;
  const factory: NodeHttpsRequestFactory = { request() { factoryCalls += 1; return new FakeRequest() as never; } };
  await assert.rejects(
    createNodeHttpsTransport(factory).request({ url: forged, address: { address: "8.8.8.8", family: 4 }, ...requestOptions }),
    { message: "PINNED_HTTPS_URL_REJECTED" },
  );
  assert.equal(factoryCalls, 0);
});

test("checks all DNS answers before trying addresses and retries a pinned address", async () => {
  const resolver = new FakeDns(new Map([["mp.weixin.qq.com", [
    { address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 },
  ]]]));
  const transport = new FakeHttpsTransport(new Set(["8.8.8.8"]));
  const client = createPinnedHttpsClient({ resolver, transport });

  await client.request(article, requestOptions);
  assert.deepEqual(resolver.calls, ["mp.weixin.qq.com"]);
  assert.deepEqual(transport.calls.map((call) => call.address.address), ["8.8.8.8", "2606:4700:4700:0:0:0:0:1111"]);
});

test("rejects a mixed public and blocked DNS answer set before connecting", async () => {
  const resolver = new FakeDns(new Map([["mp.weixin.qq.com", [
    { address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 },
  ]]]));
  const transport = new FakeHttpsTransport();
  await assert.rejects(createPinnedHttpsClient({ resolver, transport }).request(article, requestOptions), /public/i);
  assert.equal(transport.calls.length, 0);
});

class FakeRequest extends EventEmitter {
  destroyed = false;
  end(): void {}
  destroy(error?: Error): this { this.destroyed = true; if (error) this.emit("error", error); return this; }
}

test("pins lookup and preserves original TLS host options", async () => {
  let captured: Parameters<NodeHttpsRequestFactory["request"]>[0] | undefined;
  const request = new FakeRequest();
  const factory: NodeHttpsRequestFactory = {
    request(options, onResponse) {
      captured = options;
      queueMicrotask(() => {
        const socket = new EventEmitter() as EventEmitter & { remoteAddress?: string; destroy(): void };
        socket.remoteAddress = "8.8.8.8";
        socket.destroy = () => undefined;
        request.emit("socket", socket);
        socket.emit("secureConnect");
        onResponse(Object.assign(new PassThrough(), { statusCode: 200, headers: {} }) as never);
      });
      return request as never;
    },
  };
  const transport = createNodeHttpsTransport(factory);
  const response = await transport.request({ url: article, address: { address: "8.8.8.8", family: 4 }, ...requestOptions });
  assert.equal(response.peerAddress.address, "8.8.8.8");
  assert.equal(captured?.hostname, "mp.weixin.qq.com");
  assert.equal(captured?.servername, "mp.weixin.qq.com");
  assert.deepEqual(captured?.headers, {
    Host: "mp.weixin.qq.com",
    Accept: "text/html,application/xhtml+xml",
    "Accept-Encoding": "gzip, br",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  });
  assert.equal("Cookie" in (captured?.headers ?? {}), false);
  assert.equal("Referer" in (captured?.headers ?? {}), false);
  assert.equal(captured?.agent, false);
  assert.equal(captured?.rejectUnauthorized, true);
  assert.equal(captured?.family, 4);
  assert.equal((captured as (typeof captured & { autoSelectFamily?: boolean }) | undefined)?.autoSelectFamily, false);
  const lookup = captured?.lookup;
  assert.ok(lookup);
  await new Promise<void>((resolve, reject) => lookup("different.test", { all: false }, (error, address, family) => {
    if (error) reject(error); else { assert.equal(address, "8.8.8.8"); assert.equal(family, 4); resolve(); }
  }));
  await new Promise<void>((resolve, reject) => lookup("different.test", { all: true }, (error, address, family) => {
    if (error) reject(error); else {
      assert.deepEqual(address, [{ address: "8.8.8.8", family: 4 }]);
      assert.equal(family, undefined);
      resolve();
    }
  }));
});

test("classifies request and socket errors without exposing their messages", async () => {
  const cases = [
    { source: "request", code: "ECONNRESET", expected: "PINNED_HTTPS_NETWORK_FAILED" },
    { source: "socket", code: "ECONNREFUSED", expected: "PINNED_HTTPS_NETWORK_FAILED" },
    { source: "request", code: "ERR_TLS_CERT_ALTNAME_INVALID", expected: "PINNED_HTTPS_TLS_FAILED" },
    { source: "socket", code: "CERT_HAS_EXPIRED", expected: "PINNED_HTTPS_TLS_FAILED" },
    { source: "request", code: "UNABLE_TO_DECRYPT_CERT_SIGNATURE", expected: "PINNED_HTTPS_TLS_FAILED" },
    { source: "socket", code: "INVALID_CA", expected: "PINNED_HTTPS_TLS_FAILED" },
    { source: "request", code: "CRL_HAS_EXPIRED", expected: "PINNED_HTTPS_TLS_FAILED" },
    { source: "socket", code: "KEYUSAGE_NO_CERTSIGN", expected: "PINNED_HTTPS_TLS_FAILED" },
    { source: "request", code: "UNHANDLED_CRITICAL_EXTENSION", expected: "PINNED_HTTPS_TLS_FAILED" },
    { source: "socket", code: "EE_KEY_TOO_SMALL", expected: "PINNED_HTTPS_TLS_FAILED" },
    { source: "request", code: "EMAIL_MISMATCH", expected: "PINNED_HTTPS_TLS_FAILED" },
    { source: "socket", code: "IP_ADDRESS_MISMATCH", expected: "PINNED_HTTPS_TLS_FAILED" },
    { source: "request", code: "OCSP_VERIFY_FAILED", expected: "PINNED_HTTPS_TLS_FAILED" },
  ] as const;

  for (const { source, code, expected } of cases) {
    const request = new FakeRequest();
    const factory: NodeHttpsRequestFactory = { request() {
      queueMicrotask(() => {
        const secretError = Object.assign(new Error("secret upstream diagnostics"), { code });
        if (source === "request") {
          request.emit("error", secretError);
          return;
        }
        const socket = new EventEmitter() as EventEmitter & { remoteAddress?: string; destroy(): void };
        socket.remoteAddress = "8.8.8.8";
        socket.destroy = () => undefined;
        request.emit("socket", socket);
        socket.emit("error", secretError);
      });
      return request as never;
    } };
    await assert.rejects(
      createNodeHttpsTransport(factory).request({ url: article, address: { address: "8.8.8.8", family: 4 }, ...requestOptions }),
      (error: unknown) => error instanceof Error && error.message === expected,
      `${source}:${code}`,
    );
    assert.equal(request.destroyed, true);
  }
});

test("uses handshake phase for unknown failures and treats factory throws as network failures", async () => {
  const preSecure = new FakeRequest();
  const preSecureFactory: NodeHttpsRequestFactory = { request() {
    queueMicrotask(() => preSecure.emit(
      "error",
      Object.assign(new Error("secret pre-secure detail"), { code: "UNKNOWN_X509_FAILURE" }),
    ));
    return preSecure as never;
  } };
  await assert.rejects(
    createNodeHttpsTransport(preSecureFactory).request({ url: article, address: { address: "8.8.8.8", family: 4 }, ...requestOptions }),
    (error: unknown) => error instanceof Error && error.message === "PINNED_HTTPS_TLS_FAILED",
  );

  const postSecure = new FakeRequest();
  const postSecureFactory: NodeHttpsRequestFactory = { request() {
    queueMicrotask(() => {
      const socket = new EventEmitter() as EventEmitter & { remoteAddress?: string; destroy(): void };
      socket.remoteAddress = "8.8.8.8";
      socket.destroy = () => undefined;
      postSecure.emit("socket", socket);
      socket.emit("secureConnect");
      socket.emit("error", Object.assign(new Error("secret post-secure detail"), { code: "UNKNOWN_IO_FAILURE" }));
    });
    return postSecure as never;
  } };
  await assert.rejects(
    createNodeHttpsTransport(postSecureFactory).request({ url: article, address: { address: "8.8.8.8", family: 4 }, ...requestOptions }),
    (error: unknown) => error instanceof Error && error.message === "PINNED_HTTPS_NETWORK_FAILED",
  );

  const throwingFactory: NodeHttpsRequestFactory = { request() {
    throw Object.assign(new Error("secret factory detail"), { code: "UNKNOWN_FACTORY_FAILURE" });
  } };
  await assert.rejects(
    createNodeHttpsTransport(throwingFactory).request({ url: article, address: { address: "8.8.8.8", family: 4 }, ...requestOptions }),
    (error: unknown) => error instanceof Error && error.message === "PINNED_HTTPS_NETWORK_FAILED",
  );
});

test("rejects a transport response whose claimed peer differs from the selected pin", async () => {
  const resolver = new FakeDns(new Map([["mp.weixin.qq.com", [{ address: "8.8.8.8", family: 4 }]]]));
  const stream = new PassThrough();
  const transport: PinnedHttpsTransport = { async request() {
    return { statusCode: 200, headers: {}, stream, peerAddress: { address: "1.1.1.1", family: 4 } };
  } };

  await assert.rejects(
    createPinnedHttpsClient({ resolver, transport }).request(article, requestOptions),
    { message: "PINNED_HTTPS_PEER_MISMATCH" },
  );
  assert.equal(stream.destroyed, true);
});

test("destroys a connection whose TLS peer does not match its pinned address", async () => {
  const request = new FakeRequest();
  const factory: NodeHttpsRequestFactory = { request(_options, _onResponse) {
    queueMicrotask(() => {
      const socket = new EventEmitter() as EventEmitter & { remoteAddress?: string; destroy(): void };
      socket.remoteAddress = "1.1.1.1";
      socket.destroy = () => undefined;
      request.emit("socket", socket);
      socket.emit("secureConnect");
    });
    return request as never;
  } };
  await assert.rejects(
    createNodeHttpsTransport(factory).request({ url: article, address: { address: "8.8.8.8", family: 4 }, ...requestOptions }),
    /PINNED_HTTPS_PEER_MISMATCH/,
  );
  assert.equal(request.destroyed, true);
});

test("uses independent connect and headers timeout budgets", async () => {
  const neverConnect = new FakeRequest();
  const connectFactory: NodeHttpsRequestFactory = { request() { return neverConnect as never; } };
  await assert.rejects(
    createNodeHttpsTransport(connectFactory).request({ url: article, address: { address: "8.8.8.8", family: 4 }, signal: abort.signal, connectTimeoutMs: 5, headersTimeoutMs: 100 }),
    /PINNED_HTTPS_CONNECT_TIMEOUT/,
  );
  assert.equal(neverConnect.destroyed, true);

  const noHeaders = new FakeRequest();
  const headersFactory: NodeHttpsRequestFactory = { request() {
    queueMicrotask(() => {
      const socket = new EventEmitter() as EventEmitter & { remoteAddress?: string; destroy(): void };
      socket.remoteAddress = "8.8.8.8";
      socket.destroy = () => undefined;
      noHeaders.emit("socket", socket);
      socket.emit("secureConnect");
    });
    return noHeaders as never;
  } };
  await assert.rejects(
    createNodeHttpsTransport(headersFactory).request({ url: article, address: { address: "8.8.8.8", family: 4 }, signal: abort.signal, connectTimeoutMs: 100, headersTimeoutMs: 5 }),
    /PINNED_HTTPS_HEADERS_TIMEOUT/,
  );
  assert.equal(noHeaders.destroyed, true);
});

test("rejects and closes deterministically for abort, TLS failure, and response before TLS", async () => {
  const pending = new FakeRequest();
  const controller = new AbortController();
  const pendingPromise = createNodeHttpsTransport({ request() { return pending as never; } }).request({
    url: article, address: { address: "8.8.8.8", family: 4 }, signal: controller.signal, connectTimeoutMs: 100, headersTimeoutMs: 100,
  });
  controller.abort();
  await assert.rejects(pendingPromise, /PINNED_HTTPS_ABORTED/);
  assert.equal(pending.destroyed, true);

  const tlsRequest = new FakeRequest();
  const tlsFactory: NodeHttpsRequestFactory = { request() {
    queueMicrotask(() => {
      const socket = new EventEmitter() as EventEmitter & { remoteAddress?: string; destroy(): void };
      socket.remoteAddress = "8.8.8.8";
      socket.destroy = () => undefined;
      tlsRequest.emit("socket", socket);
      socket.emit("error", Object.assign(new Error("certificate failure"), { code: "ERR_SSL_PROTOCOL_ERROR" }));
    });
    return tlsRequest as never;
  } };
  await assert.rejects(
    createNodeHttpsTransport(tlsFactory).request({ url: article, address: { address: "8.8.8.8", family: 4 }, ...requestOptions }),
    /PINNED_HTTPS_TLS_FAILED/,
  );
  assert.equal(tlsRequest.destroyed, true);

  const earlyResponse = new FakeRequest();
  const earlyFactory: NodeHttpsRequestFactory = { request(_options, onResponse) {
    onResponse(Object.assign(new PassThrough(), { statusCode: 200, headers: {} }) as never);
    return earlyResponse as never;
  } };
  await assert.rejects(
    createNodeHttpsTransport(earlyFactory).request({ url: article, address: { address: "8.8.8.8", family: 4 }, ...requestOptions }),
    /PINNED_HTTPS_TLS_FAILED/,
  );
  assert.equal(earlyResponse.destroyed, true);
});
