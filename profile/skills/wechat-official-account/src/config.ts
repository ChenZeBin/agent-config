import { homedir } from "node:os";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";

export interface AppConfig {
  readonly token: string;
  readonly appId: string;
  readonly encodingAesKey: string;
  readonly publicBaseUrl: URL;
  readonly hmacKey: string;
  readonly authorizedSenderHmac: string | null;
  readonly pairingMode: boolean;
  readonly repoRoot: string;
  readonly callbackRecordPath: string;
  readonly codexBin: string;
  readonly dnsServer: string;
  readonly port: number;
}

type Env = Readonly<Record<string, string | undefined>>;
const HMAC = /^h1:[A-Za-z0-9_-]{43}$/;

function invalid(): never { throw new Error("CONFIG_INVALID"); }
function required(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const token = required(env, "WECHAT_TOKEN");
  const appId = required(env, "WECHAT_APP_ID");
  const encodingAesKey = required(env, "WECHAT_ENCODING_AES_KEY");
  const publicValue = required(env, "PUBLIC_BASE_URL");
  const hmacKey = required(env, "WEBHOOK_HMAC_KEY");
  const mode = env.WECHAT_MODE ?? "run";
  if (mode !== "run" && mode !== "pair") invalid();
  const pairingMode = mode === "pair";
  const authorizedSenderHmac = pairingMode ? null : required(env, "WECHAT_ALLOWED_SENDER_HMAC");
  const repoValue = required(env, "MY_WIKI_REPO");
  const codexBin = env.CODEX_BIN ?? resolve(homedir(), ".local/bin/codex");
  const dnsServer = env.WECHAT_DNS_SERVER ?? "1.1.1.1";
  const portValue = env.PORT ?? "8787";
  if (!/^[A-Za-z0-9]{3,32}$/.test(token)) invalid();
  if (!/^wx[A-Za-z0-9_-]{4,64}$/.test(appId)) invalid();
  if (!/^[A-Za-z0-9_-]{43}$/.test(encodingAesKey)) invalid();
  if (Buffer.byteLength(hmacKey, "utf8") < 32 || Buffer.byteLength(hmacKey, "utf8") > 1024) invalid();
  if (authorizedSenderHmac !== null && !HMAC.test(authorizedSenderHmac)) invalid();
  if (!isAbsolute(repoValue) || !isAbsolute(codexBin) || isIP(dnsServer) === 0 || dnsServer.includes("%")) invalid();
  if (!/^(?:0|[1-9]\d{0,4})$/.test(portValue)) invalid();
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) invalid();
  let publicBaseUrl: URL;
  try { publicBaseUrl = new URL(publicValue); } catch { invalid(); }
  if (publicBaseUrl.protocol !== "https:" || publicBaseUrl.username !== "" || publicBaseUrl.password !== "" || publicBaseUrl.search !== "" || publicBaseUrl.hash !== "" || publicBaseUrl.pathname !== "/") invalid();
  const repoRoot = resolve(repoValue);
  return Object.freeze({
    token,
    appId,
    encodingAesKey,
    publicBaseUrl,
    hmacKey,
    authorizedSenderHmac,
    pairingMode,
    repoRoot,
    callbackRecordPath: join(repoRoot, "staging", "private", "wechat-callback.ndjson"),
    codexBin,
    dnsServer,
    port,
  });
}
