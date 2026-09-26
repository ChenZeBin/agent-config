import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { parseEncryptedEnvelopeXml, parsePlainCallbackXml } from "../../src/wechat/callback-xml.js";

const fixturePath = resolve("test/fixtures/wechat-link-plain.xml");

async function validLinkXml(): Promise<string> {
  return readFile(fixturePath, "utf8");
}

test("parses the documented flat link message while preserving the 64-bit MsgId", async () => {
  const parsed = parsePlainCallbackXml(await validLinkXml());

  assert.deepEqual(parsed, {
    kind: "link",
    message: {
      toUserName: "gh_example_account",
      fromUserName: "openid_example_sender",
      createTime: 1712345678,
      msgType: "link",
      title: "Example article",
      description: "Example description",
      url: "https://mp.weixin.qq.com/s/example?source=probe&scene=1",
      msgId: "9223372036854775807",
      msgDataId: "msg-data-example",
      idx: 7,
    },
  });
});

test("rejects an XML declaration because the strict adapter accepts only an xml root", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>${await validLinkXml()}`;
  assert.throws(() => parsePlainCallbackXml(xml));
});

test("decodes numeric character references in ordinary XML text", async () => {
  const parsed = parsePlainCallbackXml(
    (await validLinkXml()).replace(
      "<Title><![CDATA[Example article]]></Title>",
      "<Title>&#x45;xample&#32;article</Title>",
    ),
  );

  assert.equal(parsed.kind, "link");
  assert.equal(parsed.message.title, "Example article");
});

test("decodes predefined entities once and preserves CDATA literally", async () => {
  const valid = await validLinkXml();
  const decodedOnce = parsePlainCallbackXml(
    valid.replace("<Title><![CDATA[Example article]]></Title>", "<Title>&amp;lt;</Title>"),
  );
  const cdataLiteral = parsePlainCallbackXml(
    valid.replace(
      "<Title><![CDATA[Example article]]></Title>",
      "<Title><![CDATA[&untrusted; &#65; <!DOCTYPE literal <!ENTITY literal>]]></Title>",
    ),
  );

  assert.equal(decodedOnce.kind, "link");
  assert.equal(decodedOnce.message.title, "&lt;");
  assert.equal(cdataLiteral.kind, "link");
  assert.equal(cdataLiteral.message.title, "&untrusted; &#65; <!DOCTYPE literal <!ENTITY literal>");
});

test("preserves field whitespace and treats a padded MsgType as unsupported", async () => {
  const valid = await validLinkXml();
  const preserved = parsePlainCallbackXml(
    valid
      .replace("<Title><![CDATA[Example article]]></Title>", "<Title>  title retained  </Title>")
      .replace("<Description><![CDATA[Example description]]></Description>", "<Description>  description retained  </Description>"),
  );
  const unsupported = parsePlainCallbackXml(valid.replace("<![CDATA[link]]>", " link "));

  assert.equal(preserved.kind, "link");
  assert.equal(preserved.message.title, "  title retained  ");
  assert.equal(preserved.message.description, "  description retained  ");
  assert.deepEqual(unsupported, { kind: "unsupported", msgType: " link " });
});

test("allows an unsupported message with duplicate link-only fields", () => {
  assert.deepEqual(
    parsePlainCallbackXml("<xml><MsgType>text</MsgType><Url>one</Url><Url>two</Url></xml>"),
    { kind: "unsupported", msgType: "text" },
  );
});

test("parses a complete documented text message without interpreting its content", () => {
  const parsed = parsePlainCallbackXml(`
    <xml>
      <ToUserName><![CDATA[gh_example_account]]></ToUserName>
      <FromUserName><![CDATA[openid_example_sender]]></FromUserName>
      <CreateTime>1712345678</CreateTime>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[https://mp.weixin.qq.com/s/copied-article]]></Content>
      <MsgId>9223372036854775806</MsgId>
    </xml>
  `);

  assert.deepEqual(parsed, {
    kind: "text",
    message: {
      toUserName: "gh_example_account",
      fromUserName: "openid_example_sender",
      createTime: 1712345678,
      msgType: "text",
      content: "https://mp.weixin.qq.com/s/copied-article",
      msgId: "9223372036854775806",
    },
  });
});

test("keeps incomplete text unsupported but rejects ambiguous complete text", () => {
  assert.deepEqual(
    parsePlainCallbackXml("<xml><MsgType>text</MsgType><Content>search words</Content></xml>"),
    { kind: "unsupported", msgType: "text" },
  );
  const complete = "<xml><ToUserName>to</ToUserName><FromUserName>from</FromUserName><CreateTime>1</CreateTime><MsgType>text</MsgType><Content>one</Content><MsgId>2</MsgId></xml>";
  assert.throws(() => parsePlainCallbackXml(complete.replace("</Content>", "</Content><Content>two</Content>")));
  assert.throws(() => parsePlainCallbackXml(complete.replace("<MsgId>2</MsgId>", "<MsgId>02</MsgId>")));
});

test("accepts exactly 256 KiB of UTF-8 callback XML and rejects the next byte", () => {
  const prefix = "<xml><MsgType>text</MsgType><Padding>";
  const suffix = "</Padding></xml>";
  const paddingLength = 256 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  const atLimit = `${prefix}${"\u00e9".repeat(Math.floor(paddingLength / 2))}${"x".repeat(paddingLength % 2)}${suffix}`;
  const overLimit = `${atLimit}x`;

  assert.equal(Buffer.byteLength(atLimit), 256 * 1024);
  assert.deepEqual(parsePlainCallbackXml(atLimit), { kind: "unsupported", msgType: "text" });
  assert.throws(() => parsePlainCallbackXml(overLimit));
});

test("returns unsupported messages without requiring link-only fields", () => {
  const parsed = parsePlainCallbackXml(`
    <xml>
      <ToUserName>gh_example_account</ToUserName>
      <FromUserName>openid_example_sender</FromUserName>
      <CreateTime>1712345678</CreateTime>
      <MsgType>text</MsgType>
    </xml>
  `);

  assert.deepEqual(parsed, { kind: "unsupported", msgType: "text" });
});

test("parses a strict encrypted callback envelope", () => {
  assert.deepEqual(
    parseEncryptedEnvelopeXml("<xml><Encrypt><![CDATA[ciphertext-example]]></Encrypt></xml>"),
    { encrypt: "ciphertext-example" },
  );
});

test("rejects malformed, hostile, and ambiguous XML", async (t) => {
  const valid = await validLinkXml();
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["missing Url", valid.replace(/\s*<Url>[\s\S]*?<\/Url>/, "")],
    ["missing MsgId", valid.replace(/\s*<MsgId>[\s\S]*?<\/MsgId>/, "")],
    ["non-decimal CreateTime", valid.replace("1712345678", "17.123")],
    ["duplicate Url", valid.replace("</Url>", "</Url><Url>https://mp.weixin.qq.com/s/other</Url>")],
    ["duplicate MsgType", valid.replace("</MsgType>", "</MsgType><MsgType>text</MsgType>")],
    ["attribute on root", valid.replace("<xml>", '<xml source="untrusted">')],
    ["attribute on child", valid.replace("<Title>", '<Title source="untrusted">')],
    ["nested child", valid.replace("<Title>", "<Title><Nested>").replace("</Title>", "</Nested></Title>")],
    ["DOCTYPE", valid.replace("<xml>", "<!DOCTYPE xml><xml>")],
    ["entity declaration", valid.replace("<xml>", '<!ENTITY injected "value"><xml>')],
    ["external entity", valid.replace("<xml>", '<!DOCTYPE xml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><xml>')],
    [
      "non-predefined named entity",
      valid.replace("<Title><![CDATA[Example article]]></Title>", "<Title>&untrusted;</Title>"),
    ],
    ["empty decimal character reference", valid.replace("<Title><![CDATA[Example article]]></Title>", "<Title>&#;</Title>")],
    ["empty hexadecimal character reference", valid.replace("<Title><![CDATA[Example article]]></Title>", "<Title>&#x;</Title>")],
    ["invalid numeric character reference", valid.replace("<Title><![CDATA[Example article]]></Title>", "<Title>&#xD800;</Title>")],
    ["literal U+0001", valid.replace("Example article", "\u0001")],
    ["literal U+FFFE", valid.replace("Example article", "\ufffe")],
    ["literal U+FFFF", valid.replace("Example article", "\uffff")],
    ["unpaired high surrogate", valid.replace("Example article", "\ud800")],
    ["whitespace around CreateTime", valid.replace("1712345678", " 1712345678 ")],
    ["whitespace around MsgId", valid.replace("9223372036854775807", " 9223372036854775807 ")],
    ["whitespace around Idx", valid.replace("<Idx>7</Idx>", "<Idx> 7 </Idx>")],
    ["oversized input", `<xml><MsgType>text</MsgType><Padding>${"x".repeat(256 * 1024)}</Padding></xml>`],
    ["malformed XML", "<xml><MsgType>text</xml>"],
  ];

  for (const [name, xml] of cases) {
    await t.test(name, () => {
      assert.throws(() => parsePlainCallbackXml(xml));
    });
  }
});

test("rejects an invalid encrypted envelope shape", () => {
  assert.throws(() => parseEncryptedEnvelopeXml("<xml><Encrypt>one</Encrypt><Encrypt>two</Encrypt></xml>"));
  assert.throws(() => parseEncryptedEnvelopeXml("<xml><Encrypt><Nested>one</Nested></Encrypt></xml>"));
});
