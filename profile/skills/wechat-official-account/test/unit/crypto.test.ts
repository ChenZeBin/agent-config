import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXTURE_CONFIG,
  FIXTURE_KEY,
  alterFinalPlaintextByte,
  encryptFixtureAesBlocks,
  encryptFixturePadded,
  encryptFixturePayload,
  fixturePaddingLength,
  fixtureSignature,
  xmlWithFixturePadding,
} from "../helpers/wechat-fixture-crypto.js";
import {
  WeChatCryptoError,
  decryptWeChatPayload,
  encryptWeChatPayload,
  serializeEncryptedReplyXml,
} from "../../src/wechat/crypto.js";

function expectFailure(action: () => unknown, failure: WeChatCryptoError["failure"]): void {
  assert.throws(action, (error: unknown) => {
    if (!(error instanceof WeChatCryptoError)) {
      return false;
    }
    assert.equal(error.failure, failure);
    assert.equal(error.message.includes(FIXTURE_KEY), false);
    assert.equal(JSON.stringify(error).includes(FIXTURE_KEY), false);
    return true;
  });
}

test("decrypts independent AES fixtures for Unicode XML and every PKCS#7 padding boundary", () => {
  const unicodeXml = "<xml><Content>你好，🌏</Content></xml>";
  assert.equal(decryptWeChatPayload(encryptFixturePayload(unicodeXml), FIXTURE_CONFIG), unicodeXml);

  for (const padding of [1, 16, 32]) {
    const xml = xmlWithFixturePadding(padding);
    assert.equal(fixturePaddingLength(xml), padding);
    assert.equal(decryptWeChatPayload(encryptFixturePayload(xml), FIXTURE_CONFIG), xml);
  }
});

test("encrypts the official layout with a deterministic test-only random prefix and accurate signature", () => {
  const plaintext = "<xml><Content>你好，🌏</Content></xml>";
  const timestamp = "1712345678";
  const nonce = "nonce<&>'\"";
  const random16 = Buffer.from("fedcba9876543210", "utf8");
  const reply = encryptWeChatPayload(plaintext, timestamp, nonce, FIXTURE_CONFIG, random16);
  const expectedEncrypt = encryptFixturePayload(plaintext, FIXTURE_CONFIG, random16);

  assert.equal(reply.encrypt, expectedEncrypt);
  assert.equal(reply.timestamp, timestamp);
  assert.equal(reply.nonce, nonce);
  assert.equal(reply.msgSignature, fixtureSignature(FIXTURE_CONFIG.token, timestamp, nonce, expectedEncrypt));
  assert.equal(reply.encrypt.includes(FIXTURE_KEY), false);
});

test("rejects malformed Base64 and ciphertexts that are not AES blocks without leaking the key", () => {
  expectFailure(() => decryptWeChatPayload("not base64!", FIXTURE_CONFIG), "invalid_base64");
  expectFailure(() => decryptWeChatPayload(Buffer.alloc(15).toString("base64"), FIXTURE_CONFIG), "invalid_ciphertext");
  expectFailure(
    () => encryptWeChatPayload("<xml/>", "1", "n", { ...FIXTURE_CONFIG, encodingAesKey: "not-a-valid-key" }),
    "invalid_base64",
  );
  expectFailure(() => encryptWeChatPayload("<xml/>", "1", "n", FIXTURE_CONFIG, Buffer.alloc(15)), "invalid_length");
});

test("rejects a 48-byte AES ciphertext even when its inner layout and 16-byte padding look valid", () => {
  // This raw frame is intentionally built outside production crypto. It has a
  // valid CBC layout and PKCS#7(16), but WeChat requires the entire encrypted
  // record to be a multiple of its 32-byte padding block.
  const rawFrameConfig = { ...FIXTURE_CONFIG, appId: "wx-test" };
  const xmlBytes = Buffer.from("12345", "utf8");
  const appIdBytes = Buffer.from(rawFrameConfig.appId, "utf8");
  const frame = Buffer.alloc(16 + 4 + xmlBytes.length + appIdBytes.length + 16);
  Buffer.from("0123456789abcdef", "utf8").copy(frame, 0);
  frame.writeUInt32BE(xmlBytes.length, 16);
  xmlBytes.copy(frame, 20);
  appIdBytes.copy(frame, 20 + xmlBytes.length);
  frame.fill(16, frame.length - 16);
  const ciphertext = encryptFixtureAesBlocks(frame, rawFrameConfig);

  assert.equal(Buffer.from(ciphertext, "base64").length, 48);
  expectFailure(() => decryptWeChatPayload(ciphertext, rawFrameConfig), "invalid_ciphertext");
});

test("rejects a changed final PKCS#7 byte before decoding the message", () => {
  const ciphertext = encryptFixturePayload(xmlWithFixturePadding(1));
  expectFailure(() => decryptWeChatPayload(alterFinalPlaintextByte(ciphertext), FIXTURE_CONFIG), "invalid_padding");
});

test("rejects a declared XML length outside the unpadded byte layout", () => {
  const malformed = Buffer.alloc(64);
  malformed.writeUInt32BE(0xffff_ffff, 16);
  const padded = Buffer.concat([malformed, Buffer.alloc(32, 32)]);

  expectFailure(() => decryptWeChatPayload(encryptFixturePadded(padded), FIXTURE_CONFIG), "invalid_length");
});

test("uses a constant-time AppID comparison and reports mismatches through the unified error", () => {
  const otherAppConfig = { ...FIXTURE_CONFIG, appId: "wx-other-app-id" };
  const ciphertext = encryptFixturePayload("<xml><Content>x</Content></xml>", otherAppConfig);
  expectFailure(() => decryptWeChatPayload(ciphertext, FIXTURE_CONFIG), "appid_mismatch");
});

test("rejects malformed UTF-8 XML bytes after validating the encrypted byte layout", () => {
  const appIdBytes = Buffer.from(FIXTURE_CONFIG.appId, "utf8");
  const layout = Buffer.alloc(16 + 4 + 2 + appIdBytes.length);
  layout.writeUInt32BE(2, 16);
  layout[20] = 0xc3;
  layout[21] = 0x28;
  appIdBytes.copy(layout, 22);
  const paddingLength = 32 - (layout.length % 32);
  const ciphertext = encryptFixturePadded(Buffer.concat([layout, Buffer.alloc(paddingLength, paddingLength)]));

  expectFailure(() => decryptWeChatPayload(ciphertext, FIXTURE_CONFIG), "invalid_length");
});

test("serializes an encrypted reply with exactly four safe XML fields", () => {
  const xml = serializeEncryptedReplyXml({
    encrypt: "ciphertext-base64==",
    msgSignature: "0123abcdef",
    timestamp: "1712345678<&>'\"",
    nonce: "nonce<&>'\"",
  });

  assert.equal(
    xml,
    "<xml><Encrypt><![CDATA[ciphertext-base64==]]></Encrypt><MsgSignature><![CDATA[0123abcdef]]></MsgSignature><TimeStamp>1712345678&lt;&amp;&gt;&apos;&quot;</TimeStamp><Nonce>nonce&lt;&amp;&gt;&apos;&quot;</Nonce></xml>",
  );
  assert.deepEqual([...xml.matchAll(/<(Encrypt|MsgSignature|TimeStamp|Nonce)>/g)].map((match) => match[1]), [
    "Encrypt",
    "MsgSignature",
    "TimeStamp",
    "Nonce",
  ]);
});
