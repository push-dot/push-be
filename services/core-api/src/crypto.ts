/** AES-GCM layout matches Python `KeyCipher`: ciphertext || 16-byte tag. */

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export async function masterKey(master: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = master ? base64ToBytes(master) : new Uint8Array();
  } catch {
    raw = new Uint8Array();
  }
  if (raw.length !== 32) {
    if (!master) throw new Error("empty master key");
    raw = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(master)));
  }
  return crypto.subtle.importKey("raw", asBuffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptAes(
  key: CryptoKey, plaintext: string, userId: string, provider: string, nonce?: Uint8Array,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  const iv = nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`${userId}|${provider}|v1`);
  const buf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asBuffer(iv), additionalData: asBuffer(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: new Uint8Array(buf), nonce: iv };
}

export async function decryptAes(
  key: CryptoKey, ciphertext: Uint8Array, nonce: Uint8Array, userId: string, provider: string,
): Promise<string> {
  const aad = new TextEncoder().encode(`${userId}|${provider}|v1`);
  const buf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asBuffer(nonce), additionalData: asBuffer(aad) },
    key,
    asBuffer(ciphertext),
  );
  return new TextDecoder().decode(buf);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return bytesToBase64(digest).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (!verifier) return false;
  const got = await pkceChallenge(verifier);
  if (got.length !== challenge.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ challenge.charCodeAt(i);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, payload: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, asBuffer(payload)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
