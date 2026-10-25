import { one, query } from "../db.ts";
import { HttpError, data, fieldError, noContent, pageBody, requireUuid } from "../http.ts";
import { enqueueJob, kickDispatcher, withDispatcher } from "../jobs/enqueue.ts";
import { pageOf, ts } from "../page.ts";
import { encodeCursor, parseUtc } from "../time.ts";
import type { Ctx } from "../types.ts";
import { declaredTooLarge } from "./images.ts";

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
  if (declaredTooLarge(ctx.request, MAX_SOURCE_BYTES)) throw tooLarge();
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
  });
  await withDispatcher(ctx.env, ctx.deps.fetch ?? fetch, () => kickDispatcher("q:ingest"));
  return data(201, {
    id, fileName: file.name, mimeType: mime, size: bytes.length, sha256: sha, status: "STORED", jobId,
  }, ctx.rid);
};

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");

type LibraryItem = { id: string; fileName: string; mimeType: string; size: number; pageCount: number | null; createdAt: string | null; origin: string };

const rank = (createdAt: unknown): string => {
  const p = parseUtc(createdAt);
  return `${p.y}-${p.mo}-${p.d}T${p.h}:${p.mi}:${p.s}.${String(p.micros).padStart(6, "0")}`;
};

const newerFirst = (a: LibraryItem, b: LibraryItem): number => {
  const byTime = rank(b.createdAt).localeCompare(rank(a.createdAt));
  return byTime || b.id.localeCompare(a.id);
};

export const listSources = async (ctx: Ctx): Promise<Response> => {
  const kind = ctx.url.searchParams.get("kind") || null;
  if (kind !== null && kind !== "UPLOAD" && kind !== "AI") throw fieldError("kind", "unsupported kind");
  const page = pageOf(ctx.url);
  const items: LibraryItem[] = [];
  if (kind !== "AI") {
    const rows = await query(ctx.deps.query,
      "SELECT id, file_name, mime_type, size, page_count, origin, created_at FROM sources WHERE user_id = $1 ORDER BY created_at DESC, id DESC",
      [ctx.user.id]);
    for (const row of rows.rows) {
      items.push({
        id: String(row.id), fileName: String(row.file_name), mimeType: String(row.mime_type), size: Number(row.size),
        pageCount: row.page_count == null ? null : Number(row.page_count), createdAt: ts(row.created_at),
        origin: row.origin ? String(row.origin) : "UPLOAD",
      });
    }
  }
  if (kind !== "UPLOAD") {
    const rows = await query(ctx.deps.query,
      "SELECT id, title, created_at FROM documents WHERE user_id = $1 ORDER BY created_at DESC, id DESC", [ctx.user.id]);
    for (const row of rows.rows) {
      items.push({
        id: String(row.id), fileName: String(row.title), mimeType: "application/json", size: 0, pageCount: null,
        createdAt: ts(row.created_at), origin: "AI",
      });
    }
  }
  items.sort(newerFirst);
  const cursor = page.cursor;
  const after = cursor
    ? items.filter((item) => newerFirst(item, { id: cursor.id.toLowerCase(), createdAt: cursor.createdAt } as LibraryItem) > 0)
    : items;
  const hasMore = after.length > page.limit;
  const slice = after.slice(0, page.limit);
  const last = slice[slice.length - 1];
  return pageBody(slice, hasMore && last ? encodeCursor(last.createdAt, last.id) : null, hasMore, ctx.rid);
};

const loadSource = async (ctx: Ctx, id: string): Promise<Record<string, unknown>> => {
  const row = await one(ctx.deps.query,
    "SELECT id, file_name, mime_type, size, sha256, status, created_at FROM sources WHERE id = $1 AND user_id = $2", [id, ctx.user.id]);
  if (!row) throw notFound();
  return row;
};

export const getSource = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const row = await loadSource(ctx, requireUuid(idRaw, "id"));
  return data(200, {
    id: String(row.id), fileName: String(row.file_name), mimeType: String(row.mime_type), size: Number(row.size),
    sha256: String(row.sha256), status: String(row.status), createdAt: ts(row.created_at),
  }, ctx.rid);
};

const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

export const getSourceContent = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query,
    "SELECT mime_type, encode(COALESCE(content, ''::bytea), 'base64') AS content FROM sources WHERE id = $1 AND user_id = $2", [id, ctx.user.id]);
  if (!row) throw notFound();
  const mime = String(row.mime_type);
  const body = fromBase64(String(row.content || "").replace(/\s+/g, ""));
  return new Response(body as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": mime.startsWith("text/") ? mime + "; charset=utf-8" : mime, "x-request-id": ctx.rid },
  });
};

export const deleteSource = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  await loadSource(ctx, id);
  const used = await one(ctx.deps.query,
    "SELECT count(*)::int AS n FROM career_evidence WHERE user_id = $1 AND provenance->>'sourceId' = $2", [ctx.user.id, id]);
  if (Number(used?.n) > 0) throw new HttpError(409, "INVALID_TRANSITION", "source is referenced by evidence");
  const gone = await query(ctx.deps.query, "DELETE FROM sources WHERE id = $1 AND user_id = $2", [id, ctx.user.id]);
  if (!gone.rowCount) throw notFound();
  return noContent(ctx.rid);
};

export const dispatchSources = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === "/api/v1/sources") {
    if (method === "GET") return listSources(ctx);
    if (method === "POST") return createSource(ctx);
    return null;
  }
  const m = path.match(/^\/api\/v1\/sources\/([^/]+)(\/content)?$/);
  if (!m) return null;
  if (m[2] && method === "GET") return getSourceContent(ctx, m[1]);
  if (!m[2] && method === "GET") return getSource(ctx, m[1]);
  if (!m[2] && method === "DELETE") return deleteSource(ctx, m[1]);
  return null;
};
