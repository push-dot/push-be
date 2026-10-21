import { X509Certificate } from "node:crypto";

import { HttpError } from "../http.ts";
import type { CoreEnv } from "../types.ts";

export interface StoreReceipts {
  verifyApple(signedTransaction: string): Promise<{ productId: string; originalTransactionId: string; expiresAt: string | null; consumable: boolean }>;
  verifyGoogle(purchaseToken: string, productId: string): Promise<{ productId: string; originalTransactionId: string; expiresAt: string | null; consumable: boolean }>;
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

const verifyGoogleOidc = async (env: CoreEnv, authorization: string | null): Promise<void> => {
  const token = bearerToken(authorization);
  if (!env.GOOGLE_OIDC_AUDIENCE || !env.GOOGLE_OIDC_KEY) throw notConfigured("google oidc is not configured");
  const claims = await verifyJws(token, env.GOOGLE_OIDC_KEY);
  if (claims.iss !== "https://accounts.google.com" || claims.aud !== env.GOOGLE_OIDC_AUDIENCE) throw invalidSignature();
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

export const createStoreReceipts = (env: CoreEnv, fetchImpl: typeof fetch): StoreReceipts => ({
  verifyApple: async (signedTransaction) => {
    if (!env.APPLE_IAP_KEY) throw notConfigured("app store is not configured");
    const res = await fetchImpl("https://api.storekit.itunes.apple.com/inApps/v1/transactions/" + encodeURIComponent(signedTransaction), {
      headers: { authorization: "Bearer " + env.APPLE_IAP_KEY },
    });
    const body = await readStore(res);
    const type = String(body.type ?? "");
    return {
      productId: String(body.productId ?? ""),
      originalTransactionId: String(body.originalTransactionId ?? ""),
      expiresAt: expiresOf(body.expiresAt ?? body.expiresDate),
      consumable: body.consumable === true || type === "Consumable",
    };
  },
  verifyGoogle: async (purchaseToken, productId) => {
    if (!env.GOOGLE_PLAY_KEY || !env.GOOGLE_PLAY_PACKAGE) throw notConfigured("google play is not configured");
    const url = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/"
      + encodeURIComponent(env.GOOGLE_PLAY_PACKAGE)
      + "/purchases/products/" + encodeURIComponent(productId)
      + "/tokens/" + encodeURIComponent(purchaseToken);
    const res = await fetchImpl(url, { headers: { authorization: "Bearer " + env.GOOGLE_PLAY_KEY } });
    const body = await readStore(res);
    return {
      productId,
      originalTransactionId: String(body.orderId ?? purchaseToken),
      expiresAt: expiresOf(body.expiryTime ?? body.expiryTimeMillis),
      consumable: body.consumptionState != null || body.consumable === true,
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
    await verifyGoogleOidc(env, authorization);
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
