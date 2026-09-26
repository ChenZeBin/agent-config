import { createCipheriv, createHash } from "node:crypto";

/**
 * Deliberately independent implementation used to build protocol fixtures.
 * Do not import the production crypto module here: these vectors must be able
 * to detect a mistake in its byte layout or padding implementation.
 */
export const FIXTURE_TOKEN = "fixture-token";
export const FIXTURE_APP_ID = "wx-fixture-app-id";
export const FIXTURE_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString("base64").slice(0, -1);
export const FIXTURE_PREFIX = Buffer.from("0123456789abcdef", "utf8");

export interface FixtureCryptoConfig {
  readonly token: string;
  readonly appId: string;
  readonly encodingAesKey: string;
}

export const FIXTURE_CONFIG: FixtureCryptoConfig = {
  token: FIXTURE_TOKEN,
  appId: FIXTURE_APP_ID,
  encodingAesKey: FIXTURE_KEY,
};

function fixtureKey(config: FixtureCryptoConfig): Buffer {
  return Buffer.from(`${config.encodingAesKey}=`, "base64");
}

export function fixturePaddingLength(xml: string, config: FixtureCryptoConfig = FIXTURE_CONFIG): number {
  const length = FIXTURE_PREFIX.length + 4 + Buffer.byteLength(xml, "utf8") + Buffer.byteLength(config.appId, "utf8");
  const remainder = length % 32;
  return remainder === 0 ? 32 : 32 - remainder;
}

export function xmlWithFixturePadding(padding: number, config: FixtureCryptoConfig = FIXTURE_CONFIG): string {
  if (!Number.isInteger(padding) || padding < 1 || padding > 32) {
    throw new Error("fixture padding must be in 1..32");
  }
  const open = "<xml>";
  const close = "</xml>";
  const fixedLength = FIXTURE_PREFIX.length + 4 + Buffer.byteLength(config.appId, "utf8") + Buffer.byteLength(open + close, "utf8");
  const desiredRemainder = (32 - padding) % 32;
  const fillerLength = (desiredRemainder - (fixedLength % 32) + 32) % 32;
  const xml = `${open}${"x".repeat(fillerLength)}${close}`;
  if (fixturePaddingLength(xml, config) !== padding) {
    throw new Error("fixture padding calculation failed");
  }
  return xml;
}

export function encryptFixturePayload(
  xml: string,
  config: FixtureCryptoConfig = FIXTURE_CONFIG,
  prefix: Buffer = FIXTURE_PREFIX,
): string {
  if (prefix.length !== 16) {
    throw new Error("fixture prefix must be 16 bytes");
  }
  const xmlBytes = Buffer.from(xml, "utf8");
  const appIdBytes = Buffer.from(config.appId, "utf8");
  const layout = Buffer.alloc(prefix.length + 4 + xmlBytes.length + appIdBytes.length);
  prefix.copy(layout, 0);
  layout.writeUInt32BE(xmlBytes.length, prefix.length);
  xmlBytes.copy(layout, prefix.length + 4);
  appIdBytes.copy(layout, prefix.length + 4 + xmlBytes.length);
  return encryptFixturePadded(pad32(layout), config);
}

export function encryptFixturePadded(padded: Buffer, config: FixtureCryptoConfig = FIXTURE_CONFIG): string {
  if (padded.length === 0 || padded.length % 32 !== 0) {
    throw new Error("fixture payload must be a non-empty 32-byte multiple");
  }
  return encryptFixtureAesBlocks(padded, config);
}

/** Encrypt arbitrary full AES blocks to produce malformed-protocol fixtures. */
export function encryptFixtureAesBlocks(blocks: Buffer, config: FixtureCryptoConfig = FIXTURE_CONFIG): string {
  if (blocks.length === 0 || blocks.length % 16 !== 0) {
    throw new Error("fixture ciphertext input must be a non-empty AES block multiple");
  }
  const key = fixtureKey(config);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(blocks), cipher.final()]).toString("base64");
}

export function fixtureSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return createHash("sha1").update([token, timestamp, nonce, encrypt].sort().join("")).digest("hex");
}

export function alterFinalPlaintextByte(ciphertext: string): string {
  const encrypted = Buffer.from(ciphertext, "base64");
  if (encrypted.length < 32) {
    throw new Error("fixture ciphertext must have two blocks");
  }
  const altered = Buffer.from(encrypted);
  const precedingBlockLastByte = altered.length - 17;
  const value = altered[precedingBlockLastByte];
  if (value === undefined) {
    throw new Error("fixture ciphertext index missing");
  }
  altered[precedingBlockLastByte] = value ^ 1;
  return altered.toString("base64");
}

function pad32(input: Buffer): Buffer {
  const remainder = input.length % 32;
  const paddingLength = remainder === 0 ? 32 : 32 - remainder;
  return Buffer.concat([input, Buffer.alloc(paddingLength, paddingLength)]);
}
