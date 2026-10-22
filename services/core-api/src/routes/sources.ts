import { query } from "../db.ts";
import { HttpError, data, fieldError } from "../http.ts";
import { enqueueJob, kickDispatcher, withDispatcher } from "../jobs/enqueue.ts";
import type { Ctx } from "../types.ts";

const MAX_SOURCE_BYTES = 20 << 20;

const ALLOWED_SOURCE_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "application/octet-stream",
]);

const tooLarge = (): HttpError => new HttpError(413, "PAYLOAD_TOO_LARGE", "request body too large");

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const base64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export const createSource = async (ctx: Ctx): Promise<Response> => {
  const form = await ctx.request.formData();
  const kind = form.get("kind");
  if (!kind || typeof kind !== "string") throw fieldError("kind", "required");
  const file = form.get("file");
  if (!(file instanceof File)) throw fieldError("file", "required");
  if (file.size > MAX_SOURCE_BYTES) throw tooLarge();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_SOURCE_BYTES) throw tooLarge();
  const mime = file.type || "application/octet-stream";
  if (!ALLOWED_SOURCE_MIME.has(mime)) throw fieldError("file", "unsupported file type " + mime);
  const sha = hex(await crypto.subtle.digest("SHA-256", bytes));
  const id = crypto.randomUUID();
  await query(ctx.deps.query,
    "INSERT INTO sources (id, user_id, file_name, mime_type, size, sha256, path, status, created_at, content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,decode($10,'base64'))",
    [id, ctx.user.id, file.name, mime, bytes.length, sha, `db://sources/${id}`, "STORED", ctx.now.toISOString(), base64(bytes)]);
  const { jobId } = await enqueueJob(ctx.deps.query, {
    type: "ingest",
    userId: ctx.user.id,
    plan: "FREE",
    payload: { sourceId: id },
    byok: false,
  });
  await withDispatcher(ctx.env, ctx.deps.fetch ?? fetch, () => kickDispatcher("q:ingest"));
  return data(201, {
    id, fileName: file.name, mimeType: mime, size: bytes.length, sha256: sha, status: "STORED", jobId,
  }, ctx.rid);
};
