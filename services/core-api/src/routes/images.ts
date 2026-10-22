import { one, query } from "../db.ts";
import { HttpError, data, fieldError } from "../http.ts";
import type { Ctx } from "../types.ts";

const MAX_IMAGE_BYTES = 10 << 20;
const ALIASES: Record<string, string> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "image/heif": "image/heic" };
const EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic" };
const KEY = /^[0-9a-f]{32}\.(jpg|png|webp|heic)$/;
const HEIC_BRANDS = new Set(["heic", "heix", "heif", "mif1", "msf1"]);

const tooLarge = (): HttpError => new HttpError(413, "PAYLOAD_TOO_LARGE", "request body too large");

const ascii = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));

const sniff = (b: Uint8Array): string | null => {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(b, 8, 12))) return "image/heic";
  return null;
};

const normalizeType = (value: string): string => {
  const base = value.split(";", 1)[0].trim().toLowerCase();
  return ALIASES[base] ?? base;
};

const mediaType = (key: string): string => {
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".heic")) return "image/heic";
  return "image/jpeg";
};

const base64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export const uploadImage = async (ctx: Ctx): Promise<Response> => {
  const form = await ctx.request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw fieldError("file", "required");
  if (file.size > MAX_IMAGE_BYTES) throw tooLarge();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw tooLarge();
  const declared = normalizeType(file.type || "");
  const sniffed = sniff(bytes);
  if (sniffed === null || !(declared in EXT) || declared !== sniffed) throw fieldError("file", "unsupported image type");
  const key = crypto.randomUUID().replaceAll("-", "") + EXT[sniffed];
  await query(ctx.deps.query,
    "INSERT INTO upload_images (key, user_id, mime_type, content, created_at) VALUES ($1, $2, $3, decode($4, 'base64'), $5)",
    [key, ctx.user.id, sniffed, base64(bytes), ctx.now.toISOString()]);
  return data(201, { key, url: "/api/v1/uploads/images/" + key }, ctx.rid);
};

export const getImage = async (ctx: Ctx, key: string): Promise<Response> => {
  if (!KEY.test(key)) throw fieldError("key", "invalid image key");
  const row = await one(ctx.deps.query, "SELECT encode(content, 'base64') AS content FROM upload_images WHERE key = $1", [key]);
  if (!row) throw new HttpError(404, "NOT_FOUND", "resource not found");
  const body = Uint8Array.from(atob(String(row.content).replace(/\s+/g, "")), (ch) => ch.charCodeAt(0));
  return new Response(body as unknown as BodyInit, { status: 200, headers: { "content-type": mediaType(key), "x-request-id": ctx.rid } });
};

export const isImageRead = (method: string, path: string): boolean =>
  method === "GET" && path.startsWith("/api/v1/uploads/images/") && !path.includes("..");

export const dispatchImages = async (ctx: Ctx, path: string): Promise<Response | null> => {
  if (path === "/api/v1/uploads/images") return ctx.request.method === "POST" ? uploadImage(ctx) : null;
  if (isImageRead(ctx.request.method, path)) return getImage(ctx, decodeURIComponent(path.slice("/api/v1/uploads/images/".length)));
  return null;
};
