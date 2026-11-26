import { X509Certificate } from "node:crypto";

import { HttpError } from "../http.ts";
import type { CoreEnv } from "../types.ts";
import { APPLE_ROOT_G3_PEM } from "./apple-root-g3.ts";

export interface StoreReceipts {
  verifyApple(signedTransaction: string): Promise<{ productId: string; originalTransactionId: string; expiresAt: string | null; consumable: boolean; sandbox?: boolean; superseded?: boolean }>;
  verifyGoogle(purchaseToken: string, productId: string, subscription: boolean): Promise<{ productId: string; originalTransactionId: string; expiresAt: string | null; consumable: boolean; sandbox?: boolean; linkedPurchaseToken?: string }>;
  googleLinkedToken(purchaseToken: string): Promise<string | undefined>;
  decodeAppleNotification(body: string): Promise<{ notificationType: string; originalTransactionId: string; productId: string; expiresAt: string | null; sandbox?: boolean }>;
  decodeGoogleNotification(body: unknown, authorization: string | null): Promise<{ notificationType: string; purchaseToken: string; productId: string; expiresAt: string | null }>;
}

type Json = string | number | boolean | null | Array<Json> | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isJsonObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

const notConfigured = (message: string): HttpError => new HttpError(503, "NOT_CONFIGURED", message);

const bytesOf = (input: string): Uint8Array => {
  const pad = input.replaceAll('-', "+").replaceAll('_', "/");
  const padded = pad + "=".repeat((4 - (pad.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {out[i] = bin.charCodeAt(i);}
  return out;
};

const jsonOf = (bytes: Uint8Array): JsonObject => {
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isJsonObject(body)) {throw new HttpError(400, "VALIDATION_ERROR", "invalid store payload");}
  return body;
};

const invalidSignature = (): HttpError => new HttpError(400, "VALIDATION_ERROR", "invalid webhook signature");

const invalidPurchase = (): HttpError => new HttpError(400, "VALIDATION_ERROR", "purchase is not valid");

const LIVE_SUBSCRIPTION = new Set(["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD"]);

const exactBytes = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
};

const spkiBytes = (key: string): Uint8Array => {
  const trimmed = key.includes("BEGIN")
    ? key.replaceAll(/-----BEGIN [^-]+-----/g, "").replaceAll(/-----END [^-]+-----/g, "").replaceAll(/\s+/g, "")
    : key.replaceAll(/\s+/g, "");
  return bytesOf(trimmed);
};

const importVerifyKey = async (material: string, alg: string, onFail: () => HttpError): Promise<CryptoKey> => {
  const algorithm = alg === "ES256"
    ? { name: "ECDSA", namedCurve: "P-256" }
    : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  try {
    return await crypto.subtle.importKey("spki", exactBytes(spkiBytes(material)), algorithm, false, ["verify"]);
  } catch {
    throw onFail();
  }
};

const jwsParts = (token: string): [string, string, string] | null => {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {return null;}
  return [parts[0], parts[1], parts[2]];
};

const verifyJws = async (
  token: string,
  material: string,
  onKeyFail: () => HttpError = () => notConfigured("store verify key is not configured"),
): Promise<JsonObject> => {
  const parts = jwsParts(token.trim());
  if (!parts) {throw invalidSignature();}
  let header: JsonObject;
  try {
    header = jsonOf(bytesOf(parts[0]));
  } catch {
    throw invalidSignature();
  }
  const alg = typeof header.alg === "string" ? header.alg : "";
  if (alg !== "ES256" && alg !== "RS256") {throw invalidSignature();}
  const key = await importVerifyKey(material, alg, onKeyFail);
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" },
      key,
      exactBytes(bytesOf(parts[2])),
      data,
    );
  } catch {
    ok = false;
  }
  if (!ok) {throw invalidSignature();}
  try {
    return jsonOf(bytesOf(parts[1]));
  } catch {
    throw invalidSignature();
  }
};

const x5cList = (token: string): Array<string> => {
  const parts = jwsParts(token.trim());
  if (!parts) {throw invalidSignature();}
  let header: JsonObject;
  try {
    header = jsonOf(bytesOf(parts[0]));
  } catch {
    throw invalidSignature();
  }
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length === 0) {throw invalidSignature();}
  const certs = x5c.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (certs.length !== x5c.length) {throw invalidSignature();}
  return certs;
};

const certsOf = (x5c: Array<string>): Array<X509Certificate> => x5c.map((item) => {
  try {
    return new X509Certificate(bytesOf(item));
  } catch {
    throw invalidSignature();
  }
});

const spkiMaterial = (cert: X509Certificate): string => {
  const exported = cert.publicKey.export({ format: "pem", type: "spki" });
  return typeof exported === "string" ? exported : new TextDecoder().decode(exported);
};

const rootCert = (pem: string | undefined): X509Certificate => {
  try {
    if (!pem?.trim()) {throw new Error("missing");}
    return new X509Certificate(pem);
  } catch {
    throw notConfigured("app store root is not configured");
  }
};

const appleRootPem = (env: CoreEnv): string => env.APPLE_ROOT_PEM?.trim() || APPLE_ROOT_G3_PEM;

const appleSide = (environment: unknown): "Sandbox" | "Production" => environment === "Sandbox" ? "Sandbox" : "Production";

const appleHost = (environment: unknown): string => appleSide(environment) === "Sandbox"
  ? "https://api.storekit-sandbox.itunes.apple.com"
  : "https://api.storekit.itunes.apple.com";

const signedBy = (cert: X509Certificate, issuer: X509Certificate): boolean => {
  try {
    return cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
};

interface DerItem { tag: number; start: number; end: number }

const derItem = (der: Uint8Array, at: number): DerItem => {
  const first = der[at + 1];
  const size = first < 0x80 ? 0 : first & 0x7f;
  let length = first < 0x80 ? first : 0;
  for (let i = 0; i < size; i++) {length = length * 256 + der[at + 2 + i];}
  const start = at + 2 + size;
  return { tag: der[at], start, end: start + length };
};

const children = (der: Uint8Array, parent: { start: number; end: number }): Array<DerItem> => {
  const out = [];
  for (let at = parent.start; at < parent.end;) {
    const item = derItem(der, at);
    out.push(item);
    at = item.end;
  }
  return out;
};

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// The extension ids of a certificate: Certificate > tbsCertificate > [3] > Extensions > Extension > extnID.
const extensionIds = (cert: X509Certificate): Set<string> => {
  const der = new Uint8Array(cert.raw);
  try {
    const tbs = children(der, derItem(der, 0))[0];
    const wrapper = children(der, tbs).find((item) => item.tag === 0xa3);
    if (!wrapper) {return new Set();}
    return new Set(children(der, children(der, wrapper)[0]).map((ext) => {
      const id = children(der, ext)[0];
      return hex(der.subarray(id.start, id.end));
    }));
  } catch {
    return new Set();
  }
};

// 1.2.840.113635.100.6.11.1 marks Apple's receipt-signing leaf, 1.2.840.113635.100.6.2.1 the WWDR intermediate.
// Apple Root G3 signs other Apple certificates too, so a chain to the root alone does not prove the App Store signed it.
const APPLE_LEAF_OID = "2a864886f76364060b01";
const APPLE_INTERMEDIATE_OID = "2a864886f76364060201";

const current = (cert: X509Certificate, now: Date): boolean =>
  Date.parse(cert.validFrom) <= now.getTime() && now.getTime() <= Date.parse(cert.validTo);

const appleVerified = async (token: string, rootPem: string | undefined, now: Date): Promise<{ payload: JsonObject; leaf: string }> => {
  const certs = certsOf(x5cList(token));
  if (certs.length < 2) {throw invalidSignature();}
  const leaf = spkiMaterial(certs[0]);
  const payload = await verifyJws(token, leaf, invalidSignature);
  const root = rootCert(rootPem);
  for (let i = 0; i < certs.length - 1; i++) {
    if (!signedBy(certs[i], certs[i + 1])) {throw invalidSignature();}
  }
  const last = certs.at(-1);
  if (!last || !signedBy(last, root)) {throw invalidSignature();}
  if (certs.slice(1).some((cert) => !cert.ca) || !certs.every((cert) => current(cert, now))) {throw invalidSignature();}
  if (!extensionIds(certs[0]).has(APPLE_LEAF_OID) || !extensionIds(certs[1]).has(APPLE_INTERMEDIATE_OID)) {throw invalidSignature();}
  return { payload, leaf };
};

const bearerToken = (authorization: string | null): string => {
  const match = /^Bearer\s+(\S+)/i.exec((authorization ?? "").trim());
  if (!match?.[1]) {throw invalidSignature();}
  return match[1];
};

const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISS = "https://accounts.google.com";

type CachedJwks = { byKid: Map<string, JsonWebKey>; expiresAt: number };
let jwksCache: CachedJwks | null = null;

type PlayToken = { id: string; token: string; expiresAt: number };
let playToken: PlayToken | null = null;

const maxAgeMs = (header: string | null): number => {
  const match = /max-age=(\d+)/i.exec(header ?? "");
  if (!match) {return 0;}
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
};

const jwsHeader = (token: string): JsonObject => {
  const parts = jwsParts(token.trim());
  if (!parts) {throw invalidSignature();}
  try {
    return jsonOf(bytesOf(parts[0]));
  } catch {
    throw invalidSignature();
  }
};

const verifyWithKey = async (token: string, key: CryptoKey, alg: "ES256" | "RS256"): Promise<JsonObject> => {
  const parts = jwsParts(token.trim());
  if (!parts) {throw invalidSignature();}
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" },
      key,
      exactBytes(bytesOf(parts[2])),
      data,
    );
  } catch {
    ok = false;
  }
  if (!ok) {throw invalidSignature();}
  try {
    return jsonOf(bytesOf(parts[1]));
  } catch {
    throw invalidSignature();
  }
};

const importJwk = async (jwk: JsonWebKey): Promise<CryptoKey> => {
  try {
    return await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch {
    throw invalidSignature();
  }
};

const fetchJwks = async (fetchImpl: typeof fetch, now: Date): Promise<Map<string, JsonWebKey>> => {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_CERTS_URL);
  } catch {
    throw new HttpError(502, "PROVIDER_ERROR", "store request failed");
  }
  if (!res.ok) {throw new HttpError(502, "PROVIDER_ERROR", "store request failed");}
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new HttpError(502, "PROVIDER_ERROR", "store request failed");
  }
  const keys = isJsonObject(body) ? body.keys : null;
  if (!Array.isArray(keys)) {throw new HttpError(502, "PROVIDER_ERROR", "store request failed");}
  const byKid = new Map<string, JsonWebKey>();
  for (const item of keys) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {continue;}
    const jwk: JsonWebKey & { kid?: string } = item;
    if (typeof jwk.kid === "string" && jwk.kid) {byKid.set(jwk.kid, jwk);}
  }
  jwksCache = { byKid, expiresAt: now.getTime() + maxAgeMs(res.headers.get("cache-control")) };
  return byKid;
};

const googleJwk = async (fetchImpl: typeof fetch, now: Date, kid: string): Promise<JsonWebKey> => {
  const cached = jwksCache && jwksCache.expiresAt > now.getTime() ? jwksCache.byKid.get(kid) : undefined;
  if (cached) {return cached;}
  const key = (await fetchJwks(fetchImpl, now)).get(kid);
  if (!key) {throw invalidSignature();}
  return key;
};

const verifyGoogleOidc = async (env: CoreEnv, fetchImpl: typeof fetch, authorization: string | null, now: Date): Promise<void> => {
  const token = bearerToken(authorization);
  // Any Google service account can mint a token for any audience, so the sender is the check that names Pub/Sub's.
  const sender = env.GOOGLE_OIDC_EMAIL?.trim();
  if (!env.GOOGLE_OIDC_AUDIENCE || !sender) {throw notConfigured("google oidc is not configured");}
  const header = jwsHeader(token);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {throw invalidSignature();}
  const claims = await verifyWithKey(token, await importJwk(await googleJwk(fetchImpl, now, header.kid)), "RS256");
  if (claims.iss !== GOOGLE_ISS || claims.aud !== env.GOOGLE_OIDC_AUDIENCE) {throw invalidSignature();}
  if (claims.email !== sender || claims.email_verified !== true) {throw invalidSignature();}
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now.getTime()) {throw invalidSignature();}
};

const appleToken = (body: string): string => {
  const text = body.trim();
  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalidSignature();
    }
    const signedPayload = isJsonObject(parsed) ? parsed.signedPayload : undefined;
    if (typeof signedPayload !== "string" || !jwsParts(signedPayload.trim())) {throw invalidSignature();}
    return signedPayload.trim();
  }
  if (!jwsParts(text)) {throw invalidSignature();}
  return text;
};

const expiresOf = (value: unknown): string | null => {
  if ((value === null || value === undefined) || value === "") {return null;}
  if (typeof value === "number") {return new Date(value).toISOString();}
  const text = String(value);
  if (/^\d+$/.test(text)) {return new Date(Number(text)).toISOString();}
  return text;
};

const readStore = async (res: Response): Promise<JsonObject> => {
  if (!res.ok) {throw new HttpError(502, "PROVIDER_ERROR", "store request failed");}
  const body: unknown = await res.json();
  if (!isJsonObject(body)) {throw new HttpError(502, "PROVIDER_ERROR", "store request failed");}
  return body;
};

// Google RTDN codes (developer.android.com/google/play/billing/rtdn-reference). One-time 2 is ONE_TIME_PRODUCT_CANCELED, a pending
// purchase that never paid, so nothing to take back; a paid one-time refund comes as voidedPurchaseNotification.
const googleType = (value: unknown, consumable: boolean): string => {
  const code = typeof value === "number" ? value : Number(value);
  if (consumable) {return code === 1 ? "PURCHASE" : code === 2 ? "CANCELED" : String(value ?? "");}
  if (code === 2) {return "RENEWAL";}
  if (code === 4 || code === 1) {return "PURCHASE";}
  if (code === 12) {return "REFUND";}
  if (code === 13) {return "EXPIRED";}
  return String(value ?? "");
};

const b64url = (bytes: Uint8Array): string => {
  let bin = "";
  for (const byte of bytes) {bin += String.fromCharCode(byte);}
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const jwtPart = (value: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(value)));

const importSigningKey = async (pem: string, alg: "ES256" | "RS256"): Promise<CryptoKey> => {
  const algorithm = alg === "ES256"
    ? { name: "ECDSA", namedCurve: "P-256" }
    : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  try {
    return await crypto.subtle.importKey("pkcs8", exactBytes(spkiBytes(pem)), algorithm, false, ["sign"]);
  } catch {
    throw notConfigured(alg === "ES256" ? "app store is not configured" : "google play is not configured");
  }
};

const signedJwt = async (header: JsonObject, payload: JsonObject, key: CryptoKey, alg: "ES256" | "RS256"): Promise<string> => {
  const unsigned = `${jwtPart(header)}.${jwtPart(payload)}`;
  const sig = new Uint8Array(await crypto.subtle.sign(
    alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  ));
  return `${unsigned}.${b64url(sig)}`;
};

const appleApiJwt = async (env: CoreEnv, now: Date): Promise<string> => {
  const keyPem = env.APPLE_IAP_KEY?.trim() ?? "";
  const keyId = env.APPLE_IAP_KEY_ID?.trim() ?? "";
  const issuer = env.APPLE_ISSUER_ID?.trim() ?? "";
  if (!keyPem || !keyId || !issuer || !env.APPLE_BUNDLE_ID) {throw notConfigured("app store is not configured");}
  const key = await importSigningKey(keyPem, "ES256");
  const iat = Math.floor(now.getTime() / 1000);
  return signedJwt(
    { alg: "ES256", kid: keyId, typ: "JWT" },
    { iss: issuer, iat, exp: iat + 900, aud: "appstoreconnect-v1", bid: env.APPLE_BUNDLE_ID },
    key,
    "ES256",
  );
};

const confirmApple = async (
  env: CoreEnv,
  fetchImpl: typeof fetch,
  now: Date,
  payload: JsonObject,
): Promise<JsonObject> => {
  const transactionId = String(payload.transactionId ?? payload.originalTransactionId ?? "");
  if (!transactionId) {throw invalidPurchase();}
  const res = await fetchImpl(`${appleHost(payload.environment)}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, {
    headers: { authorization: "Bearer " + await appleApiJwt(env, now) },
  });
  const body = await readStore(res);
  if (typeof body.signedTransactionInfo !== "string" || !body.signedTransactionInfo) {throw invalidPurchase();}
  const confirmed = (await appleVerified(body.signedTransactionInfo, appleRootPem(env), now)).payload;
  if (appleSide(confirmed.environment) !== appleSide(payload.environment)) {throw invalidPurchase();}
  return confirmed;
};

const keyId = async (email: string, privateKey: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${email}\n${privateKey}`)));
  return b64url(digest);
};

const googleAccessToken = async (env: CoreEnv, fetchImpl: typeof fetch, now: Date): Promise<string> => {
  const raw = env.GOOGLE_PLAY_KEY?.trim() ?? "";
  if (!raw.startsWith("{")) {throw notConfigured("google play is not configured");}
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw notConfigured("google play is not configured");
  }
  const parsed: JsonObject = isJsonObject(json) ? json : {};
  if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
    throw notConfigured("google play is not configured");
  }
  const id = await keyId(parsed.client_email, parsed.private_key);
  if (playToken && playToken.id === id && playToken.expiresAt > now.getTime()) {return playToken.token;}
  const key = await importSigningKey(parsed.private_key, "RS256");
  const iat = Math.floor(now.getTime() / 1000);
  const assertion = await signedJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: parsed.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    },
    key,
    "RS256",
  );
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const body = await readStore(res);
  if (typeof body.access_token !== "string" || !body.access_token) {throw new HttpError(502, "PROVIDER_ERROR", "store request failed");}
  const ttl = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  playToken = { id, token: body.access_token, expiresAt: now.getTime() + ttl * 1000 };
  return body.access_token;
};

export const googlePlayPubsub = (body: unknown): JsonObject | null => {
  if (!isJsonObject(body)) {return null;}
  const message = body.message;
  if (!isJsonObject(message)) {return null;}
  const data = message.data;
  if (typeof data !== "string" || !data.trim()) {return null;}
  if (jwsParts(data.trim())) {return null;}
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(bytesOf(data)).trim();
  } catch {
    throw invalidSignature();
  }
  if (!decoded || jwsParts(decoded)) {return null;}
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw invalidSignature();
  }
  if (!isJsonObject(parsed)) {throw invalidSignature();}
  return parsed;
};

const playApp = (pkg: string): string => "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" + encodeURIComponent(pkg);

const linkedOf = (body: JsonObject): string | undefined =>
  typeof body.linkedPurchaseToken === "string" && body.linkedPurchaseToken ? body.linkedPurchaseToken : undefined;

export const createStoreReceipts = (env: CoreEnv, fetchImpl: typeof fetch, now: Date): StoreReceipts => ({
  verifyApple: async (signedTransaction) => {
    if (!env.APPLE_BUNDLE_ID) {throw notConfigured("app store is not configured");}
    const { payload } = await appleVerified(signedTransaction, appleRootPem(env), now);
    if (payload.bundleId !== env.APPLE_BUNDLE_ID) {throw invalidPurchase();}
    if (payload.revocationDate !== null && payload.revocationDate !== undefined) {throw invalidPurchase();}
    const originalTransactionId = String(payload.originalTransactionId ?? "");
    if (!originalTransactionId) {throw invalidPurchase();}
    const confirmed = await confirmApple(env, fetchImpl, now, payload);
    if (String(confirmed.originalTransactionId ?? "") !== originalTransactionId) {throw invalidPurchase();}
    if (String(confirmed.productId ?? "") !== String(payload.productId ?? "")) {throw invalidPurchase();}
    if (confirmed.bundleId !== env.APPLE_BUNDLE_ID || (confirmed.revocationDate !== null && confirmed.revocationDate !== undefined)) {throw invalidPurchase();}
    return {
      productId: String(confirmed.productId ?? ""),
      originalTransactionId,
      expiresAt: expiresOf(confirmed.expiresDate),
      consumable: confirmed.type === "Consumable",
      sandbox: confirmed.environment === "Sandbox",
      superseded: confirmed.isUpgraded === true,
    };
  },
  verifyGoogle: async (purchaseToken, productId, subscription) => {
    if (!env.GOOGLE_PLAY_KEY || !env.GOOGLE_PLAY_PACKAGE) {throw notConfigured("google play is not configured");}
    const accessToken = await googleAccessToken(env, fetchImpl, now);
    const app = playApp(env.GOOGLE_PLAY_PACKAGE);
    const url = subscription
      ? app + "/purchases/subscriptionsv2/tokens/" + encodeURIComponent(purchaseToken)
      : app + "/purchases/products/" + encodeURIComponent(productId) + "/tokens/" + encodeURIComponent(purchaseToken);
    const res = await fetchImpl(url, { headers: { authorization: "Bearer " + accessToken } });
    const body = await readStore(res);
    if (!subscription) {
      if (body.purchaseState !== 0) {throw invalidPurchase();}
      return { productId, originalTransactionId: purchaseToken, expiresAt: null, consumable: true, sandbox: body.purchaseType === 0 };
    }
    if (!LIVE_SUBSCRIPTION.has(String(body.subscriptionState ?? ""))) {throw invalidPurchase();}
    const first = Array.isArray(body.lineItems) ? body.lineItems[0] : undefined;
    const line = isJsonObject(first) ? first : undefined;
    return {
      productId: String(line?.productId ?? ""),
      originalTransactionId: purchaseToken,
      expiresAt: expiresOf(line?.expiryTime),
      consumable: false,
      sandbox: body.testPurchase !== null && body.testPurchase !== undefined,
      linkedPurchaseToken: linkedOf(body),
    };
  },
  googleLinkedToken: async (purchaseToken) => {
    if (!env.GOOGLE_PLAY_KEY || !env.GOOGLE_PLAY_PACKAGE) {throw notConfigured("google play is not configured");}
    const accessToken = await googleAccessToken(env, fetchImpl, now);
    const res = await fetchImpl(playApp(env.GOOGLE_PLAY_PACKAGE) + "/purchases/subscriptionsv2/tokens/" + encodeURIComponent(purchaseToken),
      { headers: { authorization: "Bearer " + accessToken } });
    if (!res.ok) {return undefined;}
    const body: unknown = await res.json().catch(() => null);
    return isJsonObject(body) ? linkedOf(body) : undefined;
  },
  decodeAppleNotification: async (body) => {
    const verified = await appleVerified(appleToken(body), appleRootPem(env), now);
    const payload = verified.payload;
    const data = isJsonObject(payload.data) ? payload.data : {};
    if (!env.APPLE_BUNDLE_ID) {throw notConfigured("app store is not configured");}
    if (data.bundleId !== env.APPLE_BUNDLE_ID) {throw invalidSignature();}
    const signed = typeof data.signedTransactionInfo === "string"
      ? await verifyJws(data.signedTransactionInfo, verified.leaf, invalidSignature)
      : payload;
    return {
      notificationType: String(payload.notificationType ?? ""),
      originalTransactionId: String(signed.originalTransactionId ?? ""),
      productId: String(signed.productId ?? ""),
      expiresAt: expiresOf(signed.expiresDate ?? signed.expiresAt),
      sandbox: (signed.environment ?? data.environment) === "Sandbox",
    };
  },
  decodeGoogleNotification: async (body, authorization) => {
    await verifyGoogleOidc(env, fetchImpl, authorization, now);
    const pushed = googlePlayPubsub(body);
    if (!pushed) {throw invalidSignature();}
    const packageName = typeof pushed.packageName === "string" ? pushed.packageName : "";
    if (env.GOOGLE_PLAY_PACKAGE && packageName && packageName !== env.GOOGLE_PLAY_PACKAGE) {throw invalidPurchase();}
    const sub = isJsonObject(pushed.subscriptionNotification) ? pushed.subscriptionNotification : null;
    const oneTime = isJsonObject(pushed.oneTimeProductNotification) ? pushed.oneTimeProductNotification : null;
    const voided = isJsonObject(pushed.voidedPurchaseNotification) ? pushed.voidedPurchaseNotification : null;
    if (voided) {
      // productType 2 is a one-time purchase (a top-up). A voided subscription order keeps its access until Google sends
      // SUBSCRIPTION_REVOKED (12), which is the REFUND above. shortcut: a quantity-based partial refund (refundType 2) takes the
      // whole pack back; top-ups are sold one per purchase until multi-quantity is turned on.
      return {
        notificationType: Number(voided.productType) === 2 ? "REFUND" : "VOIDED_SUBSCRIPTION",
        purchaseToken: String(voided.purchaseToken ?? ""),
        productId: "",
        expiresAt: null,
      };
    }
    const note = sub ?? oneTime ?? {};
    return {
      notificationType: googleType(note.notificationType, Boolean(oneTime)),
      purchaseToken: String(note.purchaseToken ?? ""),
      productId: String(note.subscriptionId ?? note.sku ?? ""),
      expiresAt: null,
    };
  },
});
