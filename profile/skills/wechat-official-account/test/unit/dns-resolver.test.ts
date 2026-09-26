import assert from "node:assert/strict";
import test from "node:test";

import { createDnsAddressResolver } from "../../src/article/dns-resolver.js";

test("combines and deduplicates recursive IPv4 and IPv6 answers", async () => {
  const resolver = createDnsAddressResolver({
    async resolve4() { return ["8.8.8.8", "8.8.8.8"]; },
    async resolve6() { return ["2606:4700:4700::1111"]; },
  });

  assert.deepEqual(await resolver.resolveAll("mp.weixin.qq.com"), [
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
});

test("uses one successful address family and closes dual DNS failures", async () => {
  const ipv6Only = createDnsAddressResolver({
    async resolve4() { throw new Error("raw resolver detail"); },
    async resolve6() { return ["2606:4700:4700::1111"]; },
  });
  assert.deepEqual(await ipv6Only.resolveAll("mp.weixin.qq.com"), [
    { address: "2606:4700:4700::1111", family: 6 },
  ]);

  const failed = createDnsAddressResolver({
    async resolve4() { throw new Error("secret v4 detail"); },
    async resolve6() { throw new Error("secret v6 detail"); },
  });
  await assert.rejects(() => failed.resolveAll("mp.weixin.qq.com"), /^Error: DNS_RESOLUTION_FAILED$/);
});
