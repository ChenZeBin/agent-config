import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { canonicalizeArticleUrl } from "../../src/article/url-policy.js";
import { createSafeWeChatFetch } from "../../src/wiki/safe-wechat-fetch.js";

test("returns decoded HTML through a pinned client and refuses all image/other hosts", async () => {
  const requests: string[] = [];
  const html = Buffer.from("<html>safe</html>");
  const fetchImpl = createSafeWeChatFetch({
    client: {
      async request(url) {
        requests.push(url.href);
        const stream = new PassThrough();
        stream.end(gzipSync(html));
        return {
          statusCode: 200,
          headers: { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" },
          stream,
          peerAddress: { address: "8.8.8.8", family: 4 as const },
        };
      },
    },
  });
  const response = await fetchImpl("https://mp.weixin.qq.com/s/example", { redirect: "manual" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), html.toString());
  assert.equal(response.headers.get("content-encoding"), null);
  assert.deepEqual(requests, [canonicalizeArticleUrl("https://mp.weixin.qq.com/s/example").href]);
  await assert.rejects(fetchImpl("https://mmbiz.qpic.cn/example.png", { redirect: "manual" }), /SAFE_FETCH_URL_REJECTED/);
  await assert.rejects(fetchImpl("http://mp.weixin.qq.com/s/example", { redirect: "manual" }), /SAFE_FETCH_URL_REJECTED/);
});

test("enforces a decoded body limit and requires manual redirect mode", async () => {
  const fetchImpl = createSafeWeChatFetch({
    maxDecodedBytes: 4,
    client: {
      async request() {
        const stream = new PassThrough();
        stream.end("12345");
        return { statusCode: 200, headers: {}, stream, peerAddress: { address: "8.8.8.8", family: 4 as const } };
      },
    },
  });
  await assert.rejects(fetchImpl("https://mp.weixin.qq.com/s/example", { redirect: "manual" }), /SAFE_FETCH_BODY_LIMIT/);
  await assert.rejects(fetchImpl("https://mp.weixin.qq.com/s/example"), /SAFE_FETCH_OPTIONS_REJECTED/);
});
