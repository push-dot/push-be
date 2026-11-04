import { X509Certificate } from "node:crypto";

import { HttpError } from "../http.ts";
import type { CoreEnv } from "../types.ts";

export interface StoreReceipts {
  verifyApple(signedTransaction: string): Promise<{ productId: string; originalTransactionId: string; expiresAt: string | null; consumable: boolean }>;
  verifyGoogle(purchaseToken: string, productId: string, subscription: boolean): Promise<{ productId: string; originalTransactionId: string; expiresAt: string | null; consumable: boolean }>;
  decodeAppleNotification(body: string): Promise<{ notificationType: string; originalTransactionId: string; productId: string; expiresAt: string | null }>;
  decodeGoogleNotification(body: unknown, authorization: string | null): Promise<{ notificationType: string; purchaseToken: string; productId: string; expiresAt: string | null }>;
}

const notConfigured = (message: string): HttpError => new HttpError(503, "NOT_CONFIGURED", message);

const bytesOf = (input: string): Uint8Array => {
  const pad = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = pad + "=".repeat((4 - (pad.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const jsonOf = (bytes: Uint8Array): Record<string, unknown> => {
  const body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "VALIDATION_ERROR", "invalid store payload");
  return body as Record<string, unknown>;
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
    ? key.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "")
    : key.replace(/\s+/g, "");
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
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
};

const verifyJws = async (
  token: string,
  material: string,
  onKeyFail: () => HttpError = () => notConfigured("store verify key is not configured"),
): Promise<Record<string, unknown>> => {
  const parts = jwsParts(token.trim());
  if (!parts) throw invalidSignature();
  let header: Record<string, unknown>;
  try {
    header = jsonOf(bytesOf(parts[0]));
  } catch {
    throw invalidSignature();
  }
  const alg = typeof header.alg === "string" ? header.alg : "";
  if (alg !== "ES256" && alg !== "RS256") throw invalidSignature();
  const key = await importVerifyKey(material, alg, onKeyFail);
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let ok = false;
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
  if (!ok) throw invalidSignature();
  try {
    return jsonOf(bytesOf(parts[1]));
  } catch {
    throw invalidSignature();
  }
};

const x5cList = (token: string): string[] => {
  const parts = jwsParts(token.trim());
  if (!parts) throw invalidSignature();
  let header: Record<string, unknown>;
  try {
    header = jsonOf(bytesOf(parts[0]));
  } catch {
    throw invalidSignature();
  }
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length === 0 || x5c.some((item) => typeof item !== "string" || item.length === 0)) {
    throw invalidSignature();
  }
  return x5c;
};

const certsOf = (x5c: string[]): X509Certificate[] => x5c.map((item) => {
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
    if (!pem?.trim()) throw new Error("missing");
    return new X509Certificate(pem);
  } catch {
    throw notConfigured("app store root is not configured");
  }
};

const signedBy = (cert: X509Certificate, issuer: X509Certificate): boolean => {
  try {
    return cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
};

const appleVerified = async (token: string, rootPem: string | undefined): Promise<{ payload: Record<string, unknown>; leaf: string }> => {
  const certs = certsOf(x5cList(token));
  const leaf = spkiMaterial(certs[0]!);
  const payload = await verifyJws(token, leaf, invalidSignature);
  const root = rootCert(rootPem);
  for (let i = 0; i < certs.length - 1; i++) {
    if (!signedBy(certs[i]!, certs[i + 1]!)) throw invalidSignature();
  }
  if (!signedBy(certs[certs.length - 1]!, root)) throw invalidSignature();
  return { payload, leaf };
};

const bearerToken = (authorization: string | null): string => {
  const match = /^Bearer\s+(\S+)/i.exec((authorization ?? "").trim());
  if (!match?.[1]) throw invalidSignature();
  return match[1];
};

const verifyGoogleOidc = async (env: CoreEnv, authorization: string | null, now: Date): Promise<void> => {
  const token = bearerToken(authorization);
  if (!env.GOOGLE_OIDC_AUDIENCE || !env.GOOGLE_OIDC_KEY) throw notConfigured("google oidc is not configured");
  const claims = await verifyJws(token, env.GOOGLE_OIDC_KEY);
  if (claims.iss !== "https://accounts.google.com" || claims.aud !== env.GOOGLE_OIDC_AUDIENCE) throw invalidSignature();
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now.getTime()) throw invalidSignature();
};

const appleToken = (body: string): string => {
  const text = body.trim();
  if (text.startsWith("{")) {
    let parsed: { signedPayload?: unknown };
    try {
      parsed = JSON.parse(text) as { signedPayload?: unknown };
    } catch {
      throw invalidSignature();
    }
    if (typeof parsed.signedPayload !== "string" || !jwsParts(parsed.signedPayload.trim())) throw invalidSignature();
    return parsed.signedPayload.trim();
  }
  if (!jwsParts(text)) throw invalidSignature();
  return text;
};

const googleToken = (body: unknown): string => {
  if (typeof body === "string") {
    const text = body.trim();
    if (!jwsParts(text)) throw invalidSignature();
    return text;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidSignature();
  const root = body as Record<string, unknown>;
  if (typeof root.signedPayload === "string" && jwsParts(root.signedPayload.trim())) return root.signedPayload.trim();
  const message = root.message && typeof root.message === "object" && !Array.isArray(root.message)
    ? root.message as Record<string, unknown> : null;
  const data = message && typeof message.data === "string" ? message.data.trim() : "";
  if (data && jwsParts(data)) return data;
  if (data) {
    try {
      const decoded = new TextDecoder().decode(bytesOf(data)).trim();
      if (jwsParts(decoded)) return decoded;
    } catch {
      throw invalidSignature();
    }
  }
  throw invalidSignature();
};

const expiresOf = (value: unknown): string | null => {
  if (value == null || value === "") return null;
  if (typeof value === "number") return new Date(value).toISOString();
  const text = String(value);
  if (/^\d+$/.test(text)) return new Date(Number(text)).toISOString();
  return text;
};

const readStore = async (res: Response): Promise<Record<string, unknown>> => {
  if (!res.ok) throw new HttpError(502, "PROVIDER_ERROR", "store request failed");
  const body = await res.json() as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(502, "PROVIDER_ERROR", "store request failed");
  return body as Record<string, unknown>;
};

const googleType = (value: unknown, consumable: boolean): string => {
  const code = typeof value === "number" ? value : Number(value);
  if (consumable) return code === 2 ? "REFUND" : "PURCHASE";
  if (code === 2) return "RENEWAL";
  if (code === 4 || code === 1) return "PURCHASE";
  if (code === 12) return "REFUND";
  if (code === 13) return "EXPIRED";
  return String(value ?? "");
};

const b64url = (bytes: Uint8Array): string => {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
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

const signedJwt = async (header: Record<string, unknown>, payload: Record<string, unknown>, key: CryptoKey, alg: "ES256" | "RS256"): Promise<string> => {
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
  if (!keyPem || !keyId || !issuer || !env.APPLE_BUNDLE_ID) throw notConfigured("app store is not configured");
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
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const transactionId = String(payload.transactionId ?? payload.originalTransactionId ?? "");
  if (!transactionId) throw invalidPurchase();
  const host = env.APPLE_IAP_SANDBOX === "true"
    ? "https://api.storekit-sandbox.itunes.apple.com"
    : "https://api.storekit.itunes.apple.com";
  const res = await fetchImpl(`${host}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, {
    headers: { authorization: "Bearer " + await appleApiJwt(env, now) },
  });
  const body = await readStore(res);
  if (typeof body.signedTransactionInfo !== "string" || !body.signedTransactionInfo) throw invalidPurchase();
  return (await appleVerified(body.signedTransactionInfo, env.APPLE_ROOT_PEM)).payload;
};

// shortcut: a non-JSON GOOGLE_PLAY_KEY is sent as a bearer, upgrade when every environment stores the service-account JSON
const googleAccessToken = async (env: CoreEnv, fetchImpl: typeof fetch, now: Date): Promise<string> => {
  const raw = env.GOOGLE_PLAY_KEY?.trim() ?? "";
  if (!raw) throw notConfigured("google play is not configured");
  if (!raw.startsWith("{")) return raw;
  let parsed: { client_email?: unknown; private_key?: unknown };
  try {
    parsed = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown };
  } catch {
    throw notConfigured("google play is not configured");
  }
  if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
    throw notConfigured("google play is not configured");
  }
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
  if (typeof body.access_token !== "string" || !body.access_token) throw new HttpError(502, "PROVIDER_ERROR", "store request failed");
  return body.access_token;
};

const pubsubNote = (body: unknown): Record<string, unknown> | null => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const message = (body as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const data = (message as Record<string, unknown>).data;
  if (typeof data !== "string" || !data.trim()) return null;
  if (jwsParts(data.trim())) return null;
  let decoded = "";
  try {
    decoded = new TextDecoder().decode(bytesOf(data)).trim();
  } catch {
    throw invalidSignature();
  }
  if (!decoded || jwsParts(decoded)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw invalidSignature();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalidSignature();
  return parsed as Record<string, unknown>;
};

export const createStoreReceipts = (env: CoreEnv, fetchImpl: typeof fetch, now: Date): StoreReceipts => ({
  verifyApple: async (signedTransaction) => {
    if (!env.APPLE_BUNDLE_ID) throw notConfigured("app store is not configured");
    const { payload } = await appleVerified(signedTransaction, env.APPLE_ROOT_PEM);
    if (payload.bundleId !== env.APPLE_BUNDLE_ID) throw invalidPurchase();
    if (payload.revocationDate != null) throw invalidPurchase();
    const originalTransactionId = String(payload.originalTransactionId ?? "");
    if (!originalTransactionId) throw invalidPurchase();
    const confirmed = await confirmApple(env, fetchImpl, now, payload);
    if (String(confirmed.originalTransactionId ?? "") !== originalTransactionId) throw invalidPurchase();
    if (String(confirmed.productId ?? "") !== String(payload.productId ?? "")) throw invalidPurchase();
    if (confirmed.bundleId !== env.APPLE_BUNDLE_ID || confirmed.revocationDate != null) throw invalidPurchase();
    return {
      productId: String(confirmed.productId ?? ""),
      originalTransactionId,
      expiresAt: expiresOf(confirmed.expiresDate),
      consumable: confirmed.type === "Consumable",
    };
  },
  verifyGoogle: async (purchaseToken, productId, subscription) => {
    if (!env.GOOGLE_PLAY_KEY || !env.GOOGLE_PLAY_PACKAGE) throw notConfigured("google play is not configured");
    const accessToken = await googleAccessToken(env, fetchImpl, now);
    const app = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" + encodeURIComponent(env.GOOGLE_PLAY_PACKAGE);
    const url = subscription
      ? app + "/purchases/subscriptionsv2/tokens/" + encodeURIComponent(purchaseToken)
      : app + "/purchases/products/" + encodeURIComponent(productId) + "/tokens/" + encodeURIComponent(purchaseToken);
    const res = await fetchImpl(url, { headers: { authorization: "Bearer " + accessToken } });
    const body = await readStore(res);
    if (!subscription) {
      if (body.purchaseState !== 0) throw invalidPurchase();
      return { productId, originalTransactionId: purchaseToken, expiresAt: null, consumable: true };
    }
    if (!LIVE_SUBSCRIPTION.has(String(body.subscriptionState ?? ""))) throw invalidPurchase();
    const line = Array.isArray(body.lineItems) ? body.lineItems[0] as Record<string, unknown> | undefined : undefined;
    return {
      productId: String(line?.productId ?? ""),
      originalTransactionId: purchaseToken,
      expiresAt: expiresOf(line?.expiryTime),
      consumable: false,
    };
  },
  decodeAppleNotification: async (body) => {
    const verified = await appleVerified(appleToken(body), env.APPLE_ROOT_PEM);
    const payload = verified.payload;
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? payload.data as Record<string, unknown> : {};
    const signed = typeof data.signedTransactionInfo === "string"
      ? await verifyJws(data.signedTransactionInfo, verified.leaf, invalidSignature)
      : payload;
    return {
      notificationType: String(payload.notificationType ?? ""),
      originalTransactionId: String(signed.originalTransactionId ?? ""),
      productId: String(signed.productId ?? ""),
      expiresAt: expiresOf(signed.expiresDate ?? signed.expiresAt),
    };
  },
  decodeGoogleNotification: async (body, authorization) => {
    await verifyGoogleOidc(env, authorization, now);
    const pushed = pubsubNote(body);
    if (pushed) {
      const packageName = typeof pushed.packageName === "string" ? pushed.packageName : "";
      if (env.GOOGLE_PLAY_PACKAGE && packageName && packageName !== env.GOOGLE_PLAY_PACKAGE) throw invalidPurchase();
      const sub = pushed.subscriptionNotification && typeof pushed.subscriptionNotification === "object"
        ? pushed.subscriptionNotification as Record<string, unknown> : null;
      const oneTime = pushed.oneTimeProductNotification && typeof pushed.oneTimeProductNotification === "object"
        ? pushed.oneTimeProductNotification as Record<string, unknown> : null;
      const note = sub ?? oneTime ?? {};
      return {
        notificationType: googleType(note.notificationType, Boolean(oneTime)),
        purchaseToken: String(note.purchaseToken ?? ""),
        productId: String(note.subscriptionId ?? note.sku ?? ""),
        expiresAt: null,
      };
    }
    if (!env.GOOGLE_PLAY_KEY) throw notConfigured("google play is not configured");
    const decoded = await verifyJws(googleToken(body), env.GOOGLE_PLAY_KEY);
    const sub = decoded.subscriptionNotification && typeof decoded.subscriptionNotification === "object"
      ? decoded.subscriptionNotification as Record<string, unknown> : null;
    const oneTime = decoded.oneTimeProductNotification && typeof decoded.oneTimeProductNotification === "object"
      ? decoded.oneTimeProductNotification as Record<string, unknown> : null;
    const note = sub ?? oneTime ?? {};
    return {
      notificationType: googleType(note.notificationType, Boolean(oneTime)),
      purchaseToken: String(note.purchaseToken ?? ""),
      productId: String(note.subscriptionId ?? note.sku ?? ""),
      expiresAt: null,
    };
  },
});
