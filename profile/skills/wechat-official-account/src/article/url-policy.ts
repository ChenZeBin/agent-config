import type { CanonicalArticleUrl } from "./contracts.js";

const ARTICLE_HOST = "mp.weixin.qq.com" as const;
const MAX_URL_LENGTH = 4096;

function assertStrictPercentEncoding(input: string): void {
  for (let index = input.indexOf("%"); index !== -1; index = input.indexOf("%", index + 1)) {
    const first = input[index + 1];
    const second = input[index + 2];
    if (first === undefined || second === undefined || !/^[0-9a-f]{2}$/i.test(`${first}${second}`)) {
      throw new Error("article URL has malformed percent encoding");
    }
  }
}

function isTrackingKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.startsWith("utm_") || normalized === "from" || normalized === "scene" || normalized === "srcid";
}

export function canonicalizeArticleUrl(input: string): CanonicalArticleUrl {
  if (input.length === 0 || input.length > MAX_URL_LENGTH) {
    throw new Error("article URL must be at most 4096 characters");
  }
  assertStrictPercentEncoding(input);

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("article URL is invalid");
  }
  const rawAuthority = /^https:\/\/([^/?#]*)/.exec(input)?.[1];
  const acceptedAuthority = rawAuthority?.toLowerCase();
  if (acceptedAuthority !== ARTICLE_HOST && acceptedAuthority !== `${ARTICLE_HOST}:443`) {
    throw new Error("article URL must use the exact ASCII mp.weixin.qq.com host and port 443");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== ARTICLE_HOST ||
    (parsed.port !== "" && parsed.port !== "443") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("article URL must use https://mp.weixin.qq.com:443 without credentials");
  }

  const retained = [...parsed.searchParams.entries()]
    .map(([key, value], index) => ({ key, value, index }))
    .filter(({ key }) => !isTrackingKey(key))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : left.index - right.index));
  parsed.search = "";
  parsed.hash = "";
  for (const { key, value } of retained) {
    parsed.searchParams.append(key, value);
  }

  return Object.freeze({ href: parsed.href, host: ARTICLE_HOST }) as CanonicalArticleUrl;
}

export function reassertCanonicalArticleUrl(input: unknown): CanonicalArticleUrl {
  try {
    if (input === null || typeof input !== "object") {
      throw new Error("invalid value");
    }
    const candidate = input as { readonly href?: unknown; readonly host?: unknown };
    if (typeof candidate.href !== "string" || candidate.host !== ARTICLE_HOST) {
      throw new Error("invalid fields");
    }
    const canonical = canonicalizeArticleUrl(candidate.href);
    if (canonical.href !== candidate.href || canonical.host !== candidate.host) {
      throw new Error("non-canonical value");
    }
    return canonical;
  } catch {
    throw new Error("PINNED_HTTPS_URL_REJECTED");
  }
}
