import { XMLParser, XMLValidator } from "fast-xml-parser";

import type { LinkMessage, ParsedInboundMessage, TextMessage } from "./contracts.js";

const MAX_CALLBACK_XML_BYTES = 256 * 1024;
const REQUIRED_LINK_FIELDS = [
  "ToUserName",
  "FromUserName",
  "CreateTime",
  "MsgType",
  "Title",
  "Description",
  "Url",
  "MsgId",
] as const;
const DOCUMENTED_LINK_FIELDS = [...REQUIRED_LINK_FIELDS, "MsgDataId", "Idx"] as const;
const REQUIRED_TEXT_FIELDS = [
  "ToUserName",
  "FromUserName",
  "CreateTime",
  "MsgType",
  "Content",
  "MsgId",
] as const;
const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
  quot: '"',
};

const parser = new XMLParser({
  preserveOrder: true,
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "#cdata",
  trimValues: false,
});

type OrderedXmlNode = Record<string, unknown>;

function invalidXml(): never {
  throw new Error("Invalid callback XML");
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function scanXmlInput(xml: string): void {
  if (Buffer.byteLength(xml, "utf8") > MAX_CALLBACK_XML_BYTES) {
    invalidXml();
  }

  let index = 0;
  while (index < xml.length) {
    if (xml.startsWith("<![CDATA[", index)) {
      const end = xml.indexOf("]]>", index + 9);
      if (end === -1) {
        invalidXml();
      }
      scanLiteralCharacters(xml, index + 9, end);
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<!--", index)) {
      const end = xml.indexOf("-->", index + 4);
      if (end === -1) {
        invalidXml();
      }
      scanLiteralCharacters(xml, index + 4, end);
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<?", index)) {
      const end = xml.indexOf("?>", index + 2);
      if (end === -1) {
        invalidXml();
      }
      scanLiteralCharacters(xml, index + 2, end);
      index = end + 2;
      continue;
    }
    if (xml.startsWith("<!DOCTYPE", index) || xml.startsWith("<!doctype", index) || xml.startsWith("<!ENTITY", index) || xml.startsWith("<!entity", index)) {
      invalidXml();
    }

    if (xml[index] === "&") {
      index = scanReference(xml, index);
      continue;
    }
    index = scanXmlCodePoint(xml, index);
  }
}

function scanLiteralCharacters(xml: string, start: number, end: number): void {
  let index = start;
  while (index < end) {
    index = scanXmlCodePoint(xml, index);
  }
}

function scanXmlCodePoint(xml: string, index: number): number {
  const first = xml.charCodeAt(index);
  let codePoint: number;
  let width = 1;
  if (first >= 0xd800 && first <= 0xdbff) {
    const second = xml.charCodeAt(index + 1);
    if (second < 0xdc00 || second > 0xdfff) {
      invalidXml();
    }
    codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
    width = 2;
  } else if (first >= 0xdc00 && first <= 0xdfff) {
    invalidXml();
  } else {
    codePoint = first;
  }
  if (!isValidXmlCodePoint(BigInt(codePoint))) {
    invalidXml();
  }
  return index + width;
}

function scanReference(xml: string, index: number): number {
  for (const entity of Object.keys(PREDEFINED_ENTITIES)) {
    const reference = `&${entity};`;
    if (xml.startsWith(reference, index)) {
      return index + reference.length;
    }
  }
  if (xml[index + 1] !== "#") {
    return invalidXml();
  }

  let cursor = index + 2;
  const hexadecimal = xml[cursor] === "x";
  if (hexadecimal) {
    cursor += 1;
  }
  const digitsStart = cursor;
  while (cursor < xml.length && (hexadecimal ? isHexDigit(xml[cursor] ?? "") : isDecimalDigit(xml[cursor] ?? ""))) {
    cursor += 1;
  }
  if (cursor === digitsStart || xml[cursor] !== ";") {
    return invalidXml();
  }

  let codePoint: bigint;
  try {
    codePoint = BigInt(hexadecimal ? `0x${xml.slice(digitsStart, cursor)}` : xml.slice(digitsStart, cursor));
  } catch {
    return invalidXml();
  }
  if (!isValidXmlCodePoint(codePoint)) {
    return invalidXml();
  }
  return cursor + 1;
}

function isDecimalDigit(value: string): boolean {
  return value >= "0" && value <= "9";
}

function isHexDigit(value: string): boolean {
  return isDecimalDigit(value) || (value >= "a" && value <= "f") || (value >= "A" && value <= "F");
}

function parseOrderedDocument(xml: string): Map<string, string[]> {
  scanXmlInput(xml);
  if (XMLValidator.validate(xml) !== true) {
    invalidXml();
  }

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    invalidXml();
  }

  if (!Array.isArray(parsed) || parsed.length !== 1) {
    invalidXml();
  }
  const root = parsed[0];
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    invalidXml();
  }
  const rootNode = root as OrderedXmlNode;
  if (Object.keys(rootNode).length !== 1 || !hasOwn(rootNode, "xml")) {
    invalidXml();
  }
  const children = rootNode.xml;
  if (!Array.isArray(children)) {
    invalidXml();
  }

  const fields = new Map<string, string[]>();
  for (const child of children) {
    if (isWhitespaceTextNode(child)) {
      continue;
    }
    const [name, value] = singleElementEntry(child);
    fields.set(name, [...(fields.get(name) ?? []), readFlatText(value)]);
  }
  return fields;
}

function isWhitespaceTextNode(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as OrderedXmlNode);
  return entries.length === 1 && entries[0]?.[0] === "#text" && typeof entries[0][1] === "string" && /^[\t\n\r ]*$/.test(entries[0][1]);
}

function singleElementEntry(value: unknown): readonly [string, unknown] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidXml();
  }
  const element = value as OrderedXmlNode;
  const entries = Object.entries(element);
  if (entries.length !== 1) {
    return invalidXml();
  }
  const [name, children] = entries[0] ?? invalidXml();
  if (name === ":@" || name.startsWith("#")) {
    return invalidXml();
  }
  return [name, children];
}

function readFlatText(value: unknown): string {
  if (!Array.isArray(value)) {
    return invalidXml();
  }

  let text = "";
  for (const part of value) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) {
      return invalidXml();
    }
    const entries = Object.entries(part as OrderedXmlNode);
    if (entries.length !== 1) {
      return invalidXml();
    }
    const [name, contents] = entries[0] ?? invalidXml();
    if (name === "#text" && typeof contents === "string") {
      text += decodeXmlReferences(contents);
      continue;
    }
    if (name === "#cdata") {
      text += readCdata(contents);
      continue;
    }
    return invalidXml();
  }
  return text;
}

function readCdata(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 1) {
    return invalidXml();
  }
  const node = value[0];
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return invalidXml();
  }
  const entries = Object.entries(node as OrderedXmlNode);
  if (entries.length !== 1 || entries[0]?.[0] !== "#text" || typeof entries[0][1] !== "string") {
    return invalidXml();
  }
  return entries[0][1];
}

function decodeXmlReferences(value: string): string {
  return value.replace(/&(amp|lt|gt|apos|quot);|&#([0-9]+);|&#x([0-9A-Fa-f]+);/g, (_match, named, decimal, hex) => {
    if (typeof named === "string") {
      return PREDEFINED_ENTITIES[named] ?? invalidXml();
    }
    const source = typeof decimal === "string" ? decimal : hex;
    if (typeof source !== "string") {
      return invalidXml();
    }
    let codePoint: bigint;
    try {
      codePoint = BigInt(typeof decimal === "string" ? source : `0x${source}`);
    } catch {
      return invalidXml();
    }
    if (!isValidXmlCodePoint(codePoint)) {
      return invalidXml();
    }
    return String.fromCodePoint(Number(codePoint));
  });
}

function isValidXmlCodePoint(codePoint: bigint): boolean {
  return (
    codePoint === 0x9n ||
    codePoint === 0xan ||
    codePoint === 0xdn ||
    (codePoint >= 0x20n && codePoint <= 0xd7ffn) ||
    (codePoint >= 0xe000n && codePoint <= 0xfffdn) ||
    (codePoint >= 0x10000n && codePoint <= 0x10ffffn)
  );
}

function requiredField(fields: ReadonlyMap<string, readonly string[]>, name: string): string {
  const values = fields.get(name);
  if (values === undefined || values.length !== 1) {
    return invalidXml();
  }
  return values[0] ?? invalidXml();
}

function optionalField(fields: ReadonlyMap<string, readonly string[]>, name: string): string | null {
  const values = fields.get(name);
  if (values === undefined) {
    return null;
  }
  if (values.length !== 1) {
    return invalidXml();
  }
  return values[0] ?? invalidXml();
}

function parseDecimal(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    return invalidXml();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return invalidXml();
  }
  return parsed;
}

function assertNoDuplicateDocumentedFields(fields: ReadonlyMap<string, readonly string[]>): void {
  for (const name of DOCUMENTED_LINK_FIELDS) {
    const values = fields.get(name);
    if (values !== undefined && values.length !== 1) {
      invalidXml();
    }
  }
}

export function parsePlainCallbackXml(xml: string): ParsedInboundMessage {
  const fields = parseOrderedDocument(xml);
  const msgType = requiredField(fields, "MsgType");
  if (msgType === "text") {
    if (!REQUIRED_TEXT_FIELDS.every((field) => fields.has(field))) {
      return { kind: "unsupported", msgType };
    }
    for (const field of REQUIRED_TEXT_FIELDS) requiredField(fields, field);
    const msgId = requiredField(fields, "MsgId");
    if (!/^(?:0|[1-9]\d*)$/.test(msgId)) invalidXml();
    const message: TextMessage = {
      toUserName: requiredField(fields, "ToUserName"),
      fromUserName: requiredField(fields, "FromUserName"),
      createTime: parseDecimal(requiredField(fields, "CreateTime")),
      msgType: "text",
      content: requiredField(fields, "Content"),
      msgId,
    };
    return { kind: "text", message };
  }
  if (msgType !== "link") {
    return { kind: "unsupported", msgType };
  }
  assertNoDuplicateDocumentedFields(fields);

  for (const field of REQUIRED_LINK_FIELDS) {
    requiredField(fields, field);
  }
  const createTime = parseDecimal(requiredField(fields, "CreateTime"));
  const msgId = requiredField(fields, "MsgId");
  if (!/^(?:0|[1-9]\d*)$/.test(msgId)) {
    invalidXml();
  }
  const idxValue = optionalField(fields, "Idx");
  const message: LinkMessage = {
    toUserName: requiredField(fields, "ToUserName"),
    fromUserName: requiredField(fields, "FromUserName"),
    createTime,
    msgType: "link",
    title: requiredField(fields, "Title"),
    description: requiredField(fields, "Description"),
    url: requiredField(fields, "Url"),
    msgId,
    msgDataId: optionalField(fields, "MsgDataId"),
    idx: idxValue === null ? null : parseDecimal(idxValue),
  };
  return { kind: "link", message };
}

export function parseEncryptedEnvelopeXml(xml: string): { readonly encrypt: string } {
  const fields = parseOrderedDocument(xml);
  return { encrypt: requiredField(fields, "Encrypt") };
}
