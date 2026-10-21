import { HttpError } from "../http.ts";
import type { CoreEnv } from "../types.ts";

export interface StoreReceipts {
  verifyApple(signedTransaction: string): Promise<{ productId: string; originalTransactionId: string; expiresAt: string | null; consumable: boolean }>;
  verifyGoogle(purchaseToken: string, productId: string): Promise<{ productId: string; originalTransactionId: string; expiresAt: string | null; consumable: boolean }>;
  decodeAppleNotification(body: string): Promise<{ notificationType: string; originalTransactionId: string; productId: string; expiresAt: string | null }>;
  decodeGoogleNotification(body: unknown): Promise<{ notificationType: string; purchaseToken: string; productId: string; expiresAt: string | null }>;
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

const jwsPayload = (token: string): Record<string, unknown> => {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) throw new HttpError(400, "VALIDATION_ERROR", "invalid store payload");
  return jsonOf(bytesOf(parts[1]));
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

const appleNote = (body: string): Record<string, unknown> => {
  const text = body.trim();
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text) as { signedPayload?: unknown };
    if (typeof parsed.signedPayload === "string") return jwsPayload(parsed.signedPayload);
  }
  return jwsPayload(text);
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
    if (!env.APPLE_IAP_KEY) throw notConfigured("app store is not configured");
    const payload = appleNote(body);
    const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const signed = typeof data.signedTransactionInfo === "string" ? jwsPayload(data.signedTransactionInfo) : payload;
    return {
      notificationType: String(payload.notificationType ?? ""),
      originalTransactionId: String(signed.originalTransactionId ?? ""),
      productId: String(signed.productId ?? ""),
      expiresAt: expiresOf(signed.expiresDate ?? signed.expiresAt),
    };
  },
  decodeGoogleNotification: async (body) => {
    if (!env.GOOGLE_PLAY_KEY) throw notConfigured("google play is not configured");
    const root = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const message = root.message && typeof root.message === "object" ? root.message as Record<string, unknown> : {};
    let decoded = root;
    if (typeof message.data === "string") decoded = jsonOf(bytesOf(message.data));
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
