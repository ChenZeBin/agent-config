import { createHash, timingSafeEqual } from "node:crypto";

const SHA1_HEX = /^[0-9a-f]{40}$/;

export function verifySha1Signature(parts: readonly string[], supplied: string): boolean {
  if (typeof supplied !== "string" || !SHA1_HEX.test(supplied)) {
    return false;
  }

  const calculated = createHash("sha1").update([...parts].sort().join("")).digest();
  const suppliedDigest = Buffer.from(supplied, "hex");
  return timingSafeEqual(calculated, suppliedDigest);
}
