import { one, query } from "../db.ts";
import { HttpError, data, fieldError } from "../http.ts";
import type { Ctx } from "../types.ts";

const MAX_IMAGE_BYTES = 10 << 20;
export const IMAGE_QUOTA = { files: 300, bytes: 200 << 20 };
const ALIASES = new Map([["image/jpg", "image/jpeg"], ["image/pjpeg", "image/jpeg"], ["image/heif", "image/heic"]]);
const EXT = new Map([["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/webp", ".webp"], ["image/heic", ".heic"]]);
const KEY = /^[0-9a-f]{32}\.(jpg|png|webp|heic)$/;
const HEIC_BRANDS = new Set(["heic", "heix", "heif", "mif1", "msf1"]);

const tooLarge = (): HttpError => new HttpError(413, "PAYLOAD_TOO_LARGE", "request body too large");

// Multipart framing adds a few hundred bytes; 64 KiB of slack keeps a file at the limit acceptable.
export const declaredTooLarge = (request: Request, maxFileBytes: number): boolean =>
  Number(request.headers.get("content-length") || 0) > maxFileBytes + (64 << 10);

export const assertUploadQuota = async (
  ctx: Ctx,
  usageSql: string,
  quota: { files: number; bytes: number },
  incomingBytes: number,
): Promise<void> => {
  const row = await one(ctx.deps.query, usageSql, [ctx.user.id]);
  const files = Number(row?.files ?? 0);
  const bytes = Number(row?.bytes ?? 0);
  if (files >= quota.files || bytes + incomingBytes > quota.bytes) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "upload quota exceeded", { reason: "UPLOAD_QUOTA", maxFiles: quota.files, maxBytes: quota.bytes });
  }
};

const IMAGE_USAGE = "SELECT count(*)::int AS files, COALESCE(sum(octet_length(content)), 0)::bigint AS bytes FROM upload_images WHERE user_id = $1";

const ascii = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));

const sniff = (b: Uint8Array): string | null => {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {return "image/jpeg";}
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) {return "image/png";}
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") {return "image/webp";}
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(b, 8, 12))) {return "image/heic";}
  return null;
};

const normalizeType = (value: string): string => {
  const base = value.split(";", 1)[0].trim().toLowerCase();
  return ALIASES.get(base) ?? base;
};

const mediaType = (key: string): string => {
  if (key.endsWith(".png")) {return "image/png";}
  if (key.endsWith(".webp")) {return "image/webp";}
  if (key.endsWith(".heic")) {return "image/heic";}
  return "image/jpeg";
};

const base64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x80_00) {bin += String.fromCharCode(...bytes.subarray(i, i + 0x80_00));}
  return btoa(bin);
};

export const uploadImage = async (ctx: Ctx): Promise<Response> => {
  if (declaredTooLarge(ctx.request, MAX_IMAGE_BYTES)) {throw tooLarge();}
  const form = await ctx.request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {throw fieldError("file", "required");}
  if (file.size > MAX_IMAGE_BYTES) {throw tooLarge();}
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) {throw tooLarge();}
  const declared = normalizeType(file.type || "");
  const sniffed = sniff(bytes);
  const ext = EXT.get(declared);
  if (sniffed === null || ext === undefined || declared !== sniffed) {throw fieldError("file", "unsupported image type");}
  await assertUploadQuota(ctx, IMAGE_USAGE, IMAGE_QUOTA, bytes.length);
  const key = crypto.randomUUID().replaceAll("-", "") + ext;
  await query(ctx.deps.query,
    "INSERT INTO upload_images (key, user_id, mime_type, content, created_at) VALUES ($1, $2, $3, decode($4, 'base64'), $5)",
    [key, ctx.user.id, sniffed, base64(bytes), ctx.now.toISOString()]);
  return data(201, { key, url: "/api/v1/uploads/images/" + key }, ctx.rid);
};

export const getImage = async (ctx: Ctx, key: string): Promise<Response> => {
  if (!KEY.test(key)) {throw fieldError("key", "invalid image key");}
  const row = await one(ctx.deps.query, "SELECT encode(content, 'base64') AS content FROM upload_images WHERE key = $1", [key]);
  if (!row) {throw new HttpError(404, "NOT_FOUND", "resource not found");}
  const body = Uint8Array.from(atob(String(row.content).replaceAll(/\s+/g, "")), (ch) => ch.charCodeAt(0));
  return new Response(body, { status: 200, headers: { "content-type": mediaType(key), "x-request-id": ctx.rid } });
};

export const isImageRead = (method: string, path: string): boolean =>
  method === "GET" && path.startsWith("/api/v1/uploads/images/") && !path.includes("..");

export const dispatchImages = async (ctx: Ctx, path: string): Promise<Response | null> => {
  if (path === "/api/v1/uploads/images") {return ctx.request.method === "POST" ? uploadImage(ctx) : null;}
  if (isImageRead(ctx.request.method, path)) {return getImage(ctx, path.slice("/api/v1/uploads/images/".length));}
  return null;
};
