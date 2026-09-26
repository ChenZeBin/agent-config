import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeArticleUrl } from "../../src/article/url-policy.js";

test("canonicalizes a valid article URL and removes tracking without changing identity", () => {
  const url = canonicalizeArticleUrl(
    "https://mp.weixin.qq.com/s?utm_source=news&sn=signature&__biz=biz&from=timeline&mid=12&idx=1&scene=1&srcid=abc&z=2&a=1#ignored",
  );

  assert.deepEqual(url, {
    href: "https://mp.weixin.qq.com/s?__biz=biz&a=1&idx=1&mid=12&sn=signature&z=2",
    host: "mp.weixin.qq.com",
  });
});

test("sorts remaining query pairs stably", () => {
  assert.equal(
    canonicalizeArticleUrl("https://mp.weixin.qq.com/s?b=1&a=first&a=second").href,
    "https://mp.weixin.qq.com/s?a=first&a=second&b=1",
  );
});

test("allows an implicit or explicit HTTPS port 443", () => {
  assert.equal(canonicalizeArticleUrl("https://mp.weixin.qq.com/s").href, "https://mp.weixin.qq.com/s");
  assert.equal(canonicalizeArticleUrl("https://mp.weixin.qq.com:443/s").href, "https://mp.weixin.qq.com/s");
});

test("only accepts an ASCII authority with a literal port 443", () => {
  for (const input of [
    "https://mp.weixin.qq.com:0443/s",
    "https://mp.weixin.qq.com./s",
    "https://mp.weixin%E3%80%82qq.com/s",
    "https://mp.weixin%2eqq.com/s",
  ]) {
    assert.throws(() => canonicalizeArticleUrl(input), /exact ASCII/i, input);
  }
  assert.equal(canonicalizeArticleUrl("https://MP.WEIXIN.QQ.COM/s").href, "https://mp.weixin.qq.com/s");
});

test("rejects non-canonical endpoints and credentials", () => {
  for (const input of [
    "http://mp.weixin.qq.com/s",
    "https://mp.weixin.qq.com:444/s",
    "https://user:password" + "@mp.weixin.qq.com/s",
    "https://sub.mp.weixin.qq.com/s",
    "https://mp.weixin.qq.com.example.test/s",
    "https://127.0.0.1/s",
    "https://ｍp.weixin.qq.com/s",
  ]) {
    assert.throws(() => canonicalizeArticleUrl(input), /article URL/i);
  }
});

test("rejects malformed percent escapes and URLs longer than 4096 characters", () => {
  assert.throws(() => canonicalizeArticleUrl("https://mp.weixin.qq.com/s?x=%"), /percent/i);
  assert.throws(() => canonicalizeArticleUrl("https://mp.weixin.qq.com/s?x=%ZZ"), /percent/i);
  assert.throws(() => canonicalizeArticleUrl(`https://mp.weixin.qq.com/s?x=${"a".repeat(4096)}`), /4096/);
});
