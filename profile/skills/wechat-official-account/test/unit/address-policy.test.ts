import assert from "node:assert/strict";
import test from "node:test";
import { assertAllAddressesPublic } from "../../src/article/address-policy.js";
import type { ResolvedAddress } from "../../src/article/contracts.js";

const addresses = (address: string, family: 4 | 6): readonly ResolvedAddress[] => [{ address, family }];

test("permits public IPv4 and IPv6 global-unicast answers", () => {
  assert.doesNotThrow(() => assertAllAddressesPublic(addresses("8.8.8.8", 4)));
  assert.doesNotThrow(() => assertAllAddressesPublic(addresses("2606:4700:4700::1111", 6)));
});

test("normalizes IPv4-mapped answers before checking their declared family", () => {
  assert.doesNotThrow(() => assertAllAddressesPublic(addresses("::ffff:8.8.8.8", 4)));
  assert.throws(() => assertAllAddressesPublic(addresses("::ffff:8.8.8.8", 6)), /public/i);
});

test("rejects scoped and bracketed address syntax before applying a public-range decision", () => {
  assert.throws(() => assertAllAddressesPublic(addresses("2001:4860:4860::8888%eth0", 6)), /canonical/i);
  assert.throws(() => assertAllAddressesPublic(addresses("[8.8.8.8]", 4)), /canonical/i);
});

test("rejects every non-public IP range including IPv4-mapped private addresses", () => {
  for (const [address, family] of [
    ["127.0.0.1", 4], ["10.0.0.1", 4], ["172.16.0.1", 4], ["192.168.1.1", 4],
    ["169.254.1.1", 4], ["100.64.0.1", 4], ["224.0.0.1", 4], ["0.0.0.0", 4],
    ["192.0.2.1", 4], ["198.18.0.1", 4], ["240.0.0.1", 4], ["255.255.255.255", 4],
    ["::1", 6], ["fc00::1", 6], ["fe80::1", 6], ["ff00::1", 6], ["::", 6],
    ["2001:db8::1", 6], ["::ffff:192.168.1.1", 6],
  ] satisfies ReadonlyArray<readonly [string, 4 | 6]>) {
    assert.throws(() => assertAllAddressesPublic(addresses(address, family)), /public/i, address);
  }
});

test("rejects empty DNS answers and a set contaminated by one blocked address", () => {
  assert.throws(() => assertAllAddressesPublic([]), /empty/i);
  assert.throws(
    () => assertAllAddressesPublic([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]),
    /public/i,
  );
});
