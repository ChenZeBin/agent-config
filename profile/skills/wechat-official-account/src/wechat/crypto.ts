import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface WeChatCryptoConfig {
  readonly token: string;
  readonly appId: string;
  readonly encodingAesKey: string;
}

export type DecryptFailure =
  | "invalid_base64"
  | "invalid_ciphertext"
  | "invalid_padding"
  | "invalid_length"
  | "appid_mismatch";

export interface EncryptedReply {
  readonly encrypt: string;
  readonly msgSignature: string;
  readonly timestamp: string;
  readonly nonce: string;
}

/** A deliberately non-diagnostic error: callback failures must not disclose secrets. */
export class WeChatCryptoError extends Error {
  readonly failure: DecryptFailure;

  constructor(failure: DecryptFailure) {
    super("WeChat crypto payload rejected");
    this.name = "WeChatCryptoError";
    this.failure = failure;
  }
}

const AES_BLOCK_BYTES = 16;
const WECHAT_PADDING_BLOCK_BYTES = 32;
const RANDOM_PREFIX_BYTES = 16;
const LENGTH_BYTES = 4;
const ENCODING_AES_KEY = /^[A-Za-z0-9+/]{43}$/;

function fail(failure: DecryptFailure): never {
  throw new WeChatCryptoError(failure);
}

function requireString(value: unknown): string {
  if (typeof value !== "string") {
    return fail("invalid_length");
  }
  return value;
}

function encodeUtf8(value: unknown): Buffer {
  const text = requireString(value);
  const encoded = Buffer.from(text, "utf8");
  // Buffer replaces isolated UTF-16 surrogates; reject those rather than
  // silently encrypting a different XML/AppID byte sequence.
  if (encoded.toString("utf8") !== text) {
    return fail("invalid_length");
  }
  return encoded;
}

function decodeEncodingAesKey(config: WeChatCryptoConfig): Buffer {
  const encodingAesKey = requireString(config?.encodingAesKey);
  if (!ENCODING_AES_KEY.test(encodingAesKey)) {
    return fail("invalid_base64");
  }

  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32 || key.toString("base64").slice(0, -1) !== encodingAesKey) {
    return fail("invalid_base64");
  }
  return key;
}

function decodeCiphertext(ciphertext: unknown): Buffer {
  const encoded = requireString(ciphertext);
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return fail("invalid_base64");
  }

  const encrypted = Buffer.from(encoded, "base64");
  if (encrypted.toString("base64") !== encoded) {
    return fail("invalid_base64");
  }
  // WeChat's custom PKCS#7 variant pads the complete record to 32 bytes.
  // This is stronger than the AES-CBC 16-byte block requirement.
  if (encrypted.length === 0 || encrypted.length % WECHAT_PADDING_BLOCK_BYTES !== 0) {
    return fail("invalid_ciphertext");
  }
  return encrypted;
}

function decryptAesCbc(encrypted: Buffer, key: Buffer): Buffer {
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, AES_BLOCK_BYTES));
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    return fail("invalid_ciphertext");
  }
}

function removeWechatPadding(padded: Buffer): Buffer {
  const paddingLength = padded[padded.length - 1];
  if (
    paddingLength === undefined ||
    paddingLength < 1 ||
    paddingLength > WECHAT_PADDING_BLOCK_BYTES ||
    paddingLength > padded.length
  ) {
    return fail("invalid_padding");
  }
  for (let index = padded.length - paddingLength; index < padded.length; index += 1) {
    if (padded[index] !== paddingLength) {
      return fail("invalid_padding");
    }
  }
  return padded.subarray(0, padded.length - paddingLength);
}

function constantTimeBufferEqual(actual: Buffer, expected: Buffer): boolean {
  const comparisonLength = Math.max(actual.length, expected.length);
  const actualPadded = Buffer.alloc(comparisonLength);
  const expectedPadded = Buffer.alloc(comparisonLength);
  actual.copy(actualPadded);
  expected.copy(expectedPadded);
  const equalBytes = timingSafeEqual(actualPadded, expectedPadded);
  return actual.length === expected.length && equalBytes;
}

function decodeUtf8Strict(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("invalid_length");
  }
}

function makeSignature(token: unknown, timestamp: unknown, nonce: unknown, encrypt: string): string {
  const parts = [requireString(token), requireString(timestamp), requireString(nonce), encrypt];
  return createHash("sha1").update(parts.sort().join("")).digest("hex");
}

function addWechatPadding(input: Buffer): Buffer {
  const remainder = input.length % WECHAT_PADDING_BLOCK_BYTES;
  const paddingLength = remainder === 0 ? WECHAT_PADDING_BLOCK_BYTES : WECHAT_PADDING_BLOCK_BYTES - remainder;
  return Buffer.concat([input, Buffer.alloc(paddingLength, paddingLength)]);
}

function encryptAesCbc(padded: Buffer, key: Buffer): Buffer {
  try {
    const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, AES_BLOCK_BYTES));
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]);
  } catch {
    return fail("invalid_ciphertext");
  }
}

export function decryptWeChatPayload(ciphertext: string, config: WeChatCryptoConfig): string {
  const key = decodeEncodingAesKey(config);
  const plaintext = removeWechatPadding(decryptAesCbc(decodeCiphertext(ciphertext), key));
  const minimumLayoutLength = RANDOM_PREFIX_BYTES + LENGTH_BYTES;
  if (plaintext.length < minimumLayoutLength) {
    return fail("invalid_length");
  }

  const xmlLength = plaintext.readUInt32BE(RANDOM_PREFIX_BYTES);
  const xmlStart = RANDOM_PREFIX_BYTES + LENGTH_BYTES;
  if (xmlLength > plaintext.length - xmlStart) {
    return fail("invalid_length");
  }
  const xmlEnd = xmlStart + xmlLength;
  const xmlBytes = plaintext.subarray(xmlStart, xmlEnd);
  const embeddedAppId = plaintext.subarray(xmlEnd);
  const configuredAppId = encodeUtf8(config?.appId);
  if (!constantTimeBufferEqual(embeddedAppId, configuredAppId)) {
    return fail("appid_mismatch");
  }
  return decodeUtf8Strict(xmlBytes);
}

export function encryptWeChatPayload(
  plaintextXml: string,
  timestamp: string,
  nonce: string,
  config: WeChatCryptoConfig,
  random16: Buffer = randomBytes(RANDOM_PREFIX_BYTES),
): EncryptedReply {
  const key = decodeEncodingAesKey(config);
  const xmlBytes = encodeUtf8(plaintextXml);
  const appIdBytes = encodeUtf8(config?.appId);
  if (!Buffer.isBuffer(random16) || random16.length !== RANDOM_PREFIX_BYTES || xmlBytes.length > 0xffff_ffff) {
    return fail("invalid_length");
  }

  const layoutLength = RANDOM_PREFIX_BYTES + LENGTH_BYTES + xmlBytes.length + appIdBytes.length;
  if (!Number.isSafeInteger(layoutLength) || layoutLength > 0x7fff_ffff) {
    return fail("invalid_length");
  }
  let layout: Buffer;
  try {
    layout = Buffer.allocUnsafe(layoutLength);
  } catch {
    return fail("invalid_length");
  }
  random16.copy(layout, 0);
  layout.writeUInt32BE(xmlBytes.length, RANDOM_PREFIX_BYTES);
  xmlBytes.copy(layout, RANDOM_PREFIX_BYTES + LENGTH_BYTES);
  appIdBytes.copy(layout, RANDOM_PREFIX_BYTES + LENGTH_BYTES + xmlBytes.length);

  const encrypt = encryptAesCbc(addWechatPadding(layout), key).toString("base64");
  return {
    encrypt,
    msgSignature: makeSignature(config?.token, timestamp, nonce, encrypt),
    timestamp,
    nonce,
  };
}

function escapeXmlText(value: unknown): string {
  return requireString(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;")
    .replaceAll('"', "&quot;");
}

function cdata(value: unknown): string {
  return `<![CDATA[${requireString(value).replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

/** Serialize the exact four-field safe-mode response envelope. */
export function serializeEncryptedReplyXml(reply: EncryptedReply): string {
  return `<xml><Encrypt>${cdata(reply?.encrypt)}</Encrypt><MsgSignature>${cdata(reply?.msgSignature)}</MsgSignature><TimeStamp>${escapeXmlText(reply?.timestamp)}</TimeStamp><Nonce>${escapeXmlText(reply?.nonce)}</Nonce></xml>`;
}
