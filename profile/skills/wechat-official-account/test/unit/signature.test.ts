import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { verifySha1Signature } from "../../src/wechat/signature.js";

test("verifies the sorted SHA-1 digest without changing the supplied parts", () => {
  const parts = ["token", "1712345678", "nonce"];
  const expected = createHash("sha1").update([...parts].sort().join("")).digest("hex");

  assert.equal(verifySha1Signature(parts, expected), true);
  assert.equal(verifySha1Signature([...parts].reverse(), expected), true);
  assert.deepEqual(parts, ["token", "1712345678", "nonce"]);
});

test("rejects invalid, uppercase, empty, and missing SHA-1 signatures", () => {
  const expected = createHash("sha1").update(["token", "1712345678", "nonce"].sort().join("")).digest("hex");

  assert.equal(verifySha1Signature(["token", "1712345678", "nonce"], "0".repeat(40)), false);
  assert.equal(verifySha1Signature(["token", "1712345678", "nonce"], expected.toUpperCase()), false);
  assert.equal(verifySha1Signature(["token", "1712345678", "nonce"], ""), false);
  assert.equal(verifySha1Signature(["token", "1712345678", "nonce"], undefined as unknown as string), false);
});

test("compares equal-length SHA-1 digests", () => {
  const parts = ["token", "1712345678", "nonce"];
  const expected = createHash("sha1").update([...parts].sort().join("")).digest("hex");
  const different = `${expected.slice(0, -1)}${expected.endsWith("0") ? "1" : "0"}`;

  assert.equal(expected.length, 40);
  assert.equal(different.length, 40);
  assert.equal(verifySha1Signature(parts, expected), true);
  assert.equal(verifySha1Signature(parts, different), false);
});
