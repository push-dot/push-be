import { decodeCursor, encodeCursor, formatJsonTimestamp, pyJson } from "../time.ts";
import type { Deps, FrontEnv } from "../types.ts";
import {
  asBool, conditional, errorResponse, fieldError, freshRead, jsonResponse, jsonRows,
  pageLimit, parseUuid, USER_CACHE_CONTROL,
} from "../http.ts";
import { interpretAuth, rememberBag, revalidateAuth, requireUser, tokenContext } from "../middleware/auth.ts";
import { LIST_SQL, MESSAGES_SQL, queryToleratingCompany, rateParams, STREAM_SQL, tsText } from "../middleware/ratelimit.ts";

function cursorPair(url: URL, rid: string): { at: string | null; id: string | null } | Response {
  const cur = url.searchParams.get("cursor");
  if (!cur) return { at: null, id: null };
  try {
    const decoded = decodeCursor(cur);
    const id = parseUuid(decoded.id);
    if (!id) throw new Error("bad cursor");
    return { at: decoded.createdAt, id };
  } catch {
    return fieldError("cursor", "invalid cursor", rid);
  }
}

const likePattern = (raw: string | null): string | null => {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  return `%${trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
};

async function listConversationsFor(deps: Deps, ownerId: string, appId: string | null, cursor: { at: string | null; id: string | null }, limit: number, rid: string, audience: "PERSONAL" | "EMPLOYER" = "PERSONAL", q: string | null = null): Promise<Response> {
  let filterSql = "";
  const params: unknown[] = [ownerId];
  if (appId) {
    params.push(appId);
    filterSql += ` AND c.application_id = $${params.length}::uuid`;
  }
  if (cursor.at && cursor.id) {
    params.push(cursor.at, cursor.id);
    filterSql += ` AND (c.updated_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(q);
  const qRef = `$${params.length}`;
  filterSql += ` AND (${qRef}::text IS NULL OR c.title ILIKE ${qRef} ESCAPE '\\' OR COALESCE(last_msg.text, '') ILIKE ${qRef} ESCAPE '\\')`;
  params.push(limit + 1);
  const ownerSql = audience === "EMPLOYER"
    ? "company_id = $1::uuid"
    : "user_id = $1::uuid AND company_id IS NULL";
  const rows = await deps.query(
    "SELECT c.id, c.revision, c.application_id, c.title, c.pinned, "
    + tsText("c.created_at") + " AS created_at, " + tsText("c.updated_at") + " AS updated_at, "
    + "c.posting_id, COALESCE(cu.display_name, '') AS display_name, "
    + "COALESCE(left(last_msg.text, 140), '') AS last_message_preview, "
    + "CASE WHEN EXISTS (SELECT 1 FROM approvals a WHERE a.conversation_id = c.id AND a.status = 'PENDING') THEN 'NEEDS_APPROVAL' "
    + "WHEN EXISTS (SELECT 1 FROM chat_jobs j WHERE j.conversation_id = c.id AND j.status IN ('PENDING', 'RUNNING')) THEN 'RUNNING' "
    + "ELSE 'DONE' END AS status "
    + "FROM conversations c "
    + "LEFT JOIN users cu ON cu.id = c.user_id "
    + "LEFT JOIN LATERAL (SELECT m.text FROM messages m WHERE m.conversation_id = c.id "
    + "ORDER BY m.created_at DESC, m.id DESC LIMIT 1) last_msg ON true "
    + "WHERE " + ownerSql + " AND c.archived = false"
    + filterSql
    + ` ORDER BY c.updated_at DESC, c.id DESC LIMIT $${params.length}`,
    params,
  );
  return jsonResponse(200, pageBody(rows, limit, conversationJson), rid);
}

export async function listConversations(request: Request, env: FrontEnv, deps: Deps, url: URL, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const page = pageLimit(url, rid);
  if (page instanceof Response) return page;
  const appRaw = url.searchParams.get("applicationId") || "";
  let appId: string | null = null;
  if (appRaw) {
    appId = parseUuid(appRaw);
    if (!appId) return fieldError("applicationId", "must be a UUID", rid);
  }
  const cursor = cursorPair(url, rid);
  if (cursor instanceof Response) return cursor;
  const q = likePattern(url.searchParams.get("q"));
  if (url.searchParams.get("audience") === "EMPLOYER") {
    const user = await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) return user;
    if (!user.companyId) {
      return errorResponse(403, "BUSINESS_NOT_VERIFIED", "company is not verified", rid);
    }
    try {
      return await listConversationsFor(deps, user.companyId, appId, cursor, page.limit, rid, "EMPLOYER", q);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  const ctx = await tokenContext(request, env, deps, rid, limits, now);
  if (ctx instanceof Response) return ctx;
  if (ctx.user || ctx.revalidate) {
    const user = ctx.user ?? await revalidateAuth(ctx, env, deps, rid);
    if (user instanceof Response) return user;
    try {
      return await freshRead(
        await listConversationsFor(deps, user.id, appId, cursor, page.limit, rid, "PERSONAL", q),
        request, rid);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  if (ctx.dev) {
    const user = await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) return user;
    try {
      return await listConversationsFor(deps, user.id, appId, cursor, page.limit, rid, "PERSONAL", q);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  try {
    const rows = await queryToleratingCompany(deps.query, LIST_SQL, [
      ...rateParams(ctx.hash, ctx.moment, limits.user, ctx.batch, ctx.release),
      appId, cursor.at, cursor.id, page.limit + 1, q,
    ]);
    const user = interpretAuth(rows, ctx.moment, limits.user, limits.windowMs, ctx.cacheKey, true, rid, deps, rememberBag(ctx, env));
    if (user instanceof Response) return user;
    const text = pyJson(pageBody(jsonRows(rows[0]?.rows), page.limit, conversationJson));
    return conditional(text, request, rid, USER_CACHE_CONTROL);
  } catch {
    const user = await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) return user;
    try {
      return await listConversationsFor(deps, user.id, appId, cursor, page.limit, rid, "PERSONAL", q);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
}

function conversationJson(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    applicationId: row.application_id == null ? null : String(row.application_id),
    title: String(row.title ?? ""),
    pinned: asBool(row.pinned),
    createdAt: formatJsonTimestamp(row.created_at),
    updatedAt: formatJsonTimestamp(row.updated_at),
    status: row.status == null || row.status === "" ? "DONE" : String(row.status),
    lastMessagePreview: String(row.last_message_preview ?? "").slice(0, 140),
    createdBy: { displayName: String(row.display_name ?? "") },
    postingId: row.posting_id == null || row.posting_id === "" ? null : String(row.posting_id),
  };
}

async function listMessagesFor(deps: Deps, userId: string, id: string, cursor: { at: string | null; id: string | null }, limit: number, rid: string, companyId: string | null): Promise<Response> {
  const found = await deps.query(
    "SELECT id, company_id FROM conversations WHERE id = $1::uuid AND (user_id = $2::uuid OR ($3::uuid IS NOT NULL AND company_id = $3::uuid))",
    [id, userId, companyId],
  );
  if (!found.length) return errorResponse(404, "NOT_FOUND", "resource not found", rid);
  const shared = found[0].company_id != null && found[0].company_id !== "";
  const params: unknown[] = shared ? [id] : [userId, id];
  let cursorSql = "";
  if (cursor.at && cursor.id) {
    params.push(cursor.at, cursor.id);
    cursorSql = ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(limit + 1);
  const where = shared
    ? "conversation_id = $1::uuid"
    : "user_id = $1::uuid AND conversation_id = $2::uuid";
  const rows = await deps.query(
    "SELECT id, conversation_id, role, text, attachments, operation_id, "
    + tsText("created_at") + " AS created_at "
    + "FROM messages WHERE " + where +
    cursorSql +
    ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return jsonResponse(200, pageBody(rows, limit, messageJson), rid);
}

export async function listMessages(request: Request, env: FrontEnv, deps: Deps, url: URL, rawId: string, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const id = parseUuid(rawId);
  if (!id) return fieldError("id", "must be a UUID", rid);
  const page = pageLimit(url, rid);
  if (page instanceof Response) return page;
  const cursor = cursorPair(url, rid);
  if (cursor instanceof Response) return cursor;
  const ctx = await tokenContext(request, env, deps, rid, limits, now);
  if (ctx instanceof Response) return ctx;
  if (ctx.user || ctx.revalidate) {
    const user = ctx.user ?? await revalidateAuth(ctx, env, deps, rid);
    if (user instanceof Response) return user;
    try {
      return await freshRead(
        await listMessagesFor(deps, user.id, id, cursor, page.limit, rid, user.companyId),
        request, rid);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  if (ctx.dev) {
    const user = await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) return user;
    try {
      return await listMessagesFor(deps, user.id, id, cursor, page.limit, rid, user.companyId);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  try {
    const rows = await queryToleratingCompany(deps.query, MESSAGES_SQL, [
      ...rateParams(ctx.hash, ctx.moment, limits.user, ctx.batch, ctx.release),
      id, cursor.at, cursor.id, page.limit + 1,
    ]);
    const user = interpretAuth(rows, ctx.moment, limits.user, limits.windowMs, ctx.cacheKey, true, rid, deps, rememberBag(ctx, env));
    if (user instanceof Response) return user;
    const conversationId = rows[0]?.conversation_id;
    if (conversationId == null || conversationId === "") {
      return errorResponse(404, "NOT_FOUND", "resource not found", rid);
    }
    const text = pyJson(pageBody(jsonRows(rows[0]?.rows), page.limit, messageJson));
    return conditional(text, request, rid, USER_CACHE_CONTROL);
  } catch {
    const user = await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) return user;
    try {
      return await listMessagesFor(deps, user.id, id, cursor, page.limit, rid, user.companyId);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
}

function messageJson(row: Record<string, unknown>): Record<string, unknown> {
  let attachments = row.attachments ?? [];
  if (typeof attachments === "string") {
    try { attachments = JSON.parse(attachments); } catch { attachments = []; }
  }
  const cleaned = Array.isArray(attachments) ? attachments.map(attachmentJson) : [];
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: String(row.role),
    text: String(row.text ?? ""),
    attachments: cleaned,
    operationId: row.operation_id == null ? null : String(row.operation_id),
    createdAt: formatJsonTimestamp(row.created_at),
  };
}

function attachmentJson(raw: unknown): Record<string, unknown> {
  const a = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const out: Record<string, unknown> = { type: String(a.type ?? ""), id: String(a.id ?? "") };
  if (a.documentId != null) out.documentId = String(a.documentId);
  if (a.title != null) out.title = String(a.title);
  return out;
}

function pageBody(rows: Record<string, unknown>[], limit: number, map: (row: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> {
  const more = rows.length > limit;
  const items = (more ? rows.slice(0, limit) : rows).map(map);
  let nextCursor: string | null = null;
  if (more && items.length) {
    const last = items[items.length - 1];
    const stamp = map === conversationJson ? String(last.updatedAt) : String(last.createdAt);
    const id = String(last.id);
    nextCursor = encodeCursor(stamp, id);
  }
  return { data: items, page: { nextCursor, hasMore: more } };
}

async function activeJobFor(deps: Deps, userId: string, id: string, companyId: string | null): Promise<string | null | Response> {
  const found = await deps.query(
    "SELECT id, company_id FROM conversations WHERE id = $1::uuid AND (user_id = $2::uuid OR ($3::uuid IS NOT NULL AND company_id = $3::uuid))",
    [id, userId, companyId],
  );
  if (!found.length) return errorResponse(404, "NOT_FOUND", "resource not found", "");
  const shared = found[0].company_id != null && found[0].company_id !== "";
  const jobs = await deps.query(
    shared
      ? "SELECT id FROM chat_jobs WHERE conversation_id = $1::uuid AND status IN ('PENDING', 'RUNNING') ORDER BY created_at DESC LIMIT 1"
      : "SELECT id FROM chat_jobs WHERE user_id = $1::uuid AND conversation_id = $2::uuid AND status IN ('PENDING', 'RUNNING') ORDER BY created_at DESC LIMIT 1",
    shared ? [id] : [userId, id],
  );
  return jobs.length ? String(jobs[0].id) : null;
}

export const streamCancel = async (request: Request, env: FrontEnv, deps: Deps, rawId: string, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> => {
  const id = parseUuid(rawId);
  if (!id) return fieldError("id", "must be a UUID", rid);
  const user = await requireUser(request, env, deps, rid, limits, now);
  if (user instanceof Response) return user;
  try {
    const found = await activeJobFor(deps, user.id, id, user.companyId);
    if (found instanceof Response) {
      return errorResponse(found.status, "NOT_FOUND", "resource not found", rid);
    }
    if (!found) return errorResponse(409, "CONFLICT", "no active stream", rid);
    const updated = await deps.query(
      "UPDATE chat_jobs SET status = 'CANCELLED', updated_at = now() "
      + "WHERE id = $1::uuid AND status IN ('PENDING', 'RUNNING') RETURNING id",
      [found],
    );
    if (!updated.length) return errorResponse(409, "CONFLICT", "no active stream", rid);
    await deps.query(
      "INSERT INTO chat_events (job_id, type, payload) "
      + "VALUES ($1::uuid, 'cancelled', '{}'::jsonb)",
      [found],
    );
    return jsonResponse(200, { data: { jobId: found, status: "CANCELLED" } }, rid);
  } catch {
    return errorResponse(500, "INTERNAL", "internal error", rid);
  }
};

export async function streamActive(request: Request, env: FrontEnv, deps: Deps, url: URL, rawId: string, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const id = parseUuid(rawId);
  if (!id) return fieldError("id", "must be a UUID", rid);
  const ctx = await tokenContext(request, env, deps, rid, limits, now);
  if (ctx instanceof Response) return ctx;
  let jobId: string | null;
  try {
    if (ctx.user || ctx.revalidate) {
      const user = ctx.user ?? await revalidateAuth(ctx, env, deps, rid);
      if (user instanceof Response) return user;
      const found = await activeJobFor(deps, user.id, id, user.companyId);
      if (found instanceof Response) {
        return errorResponse(found.status, "NOT_FOUND", "resource not found", rid);
      }
      jobId = found;
    } else if (ctx.dev) {
      const user = await requireUser(request, env, deps, rid, limits, now);
      if (user instanceof Response) return user;
      const found = await activeJobFor(deps, user.id, id, user.companyId);
      if (found instanceof Response) {
        return errorResponse(found.status, "NOT_FOUND", "resource not found", rid);
      }
      jobId = found;
    } else {
      const rows = await queryToleratingCompany(deps.query, STREAM_SQL, [
        ...rateParams(ctx.hash, ctx.moment, limits.user, ctx.batch, ctx.release), id,
      ]);
      const user = interpretAuth(rows, ctx.moment, limits.user, limits.windowMs, ctx.cacheKey, true, rid, deps, rememberBag(ctx, env));
      if (user instanceof Response) return user;
      const conversationId = rows[0]?.conversation_id;
      if (conversationId == null || conversationId === "") {
        return errorResponse(404, "NOT_FOUND", "resource not found", rid);
      }
      const rawJob = rows[0]?.job_id;
      jobId = rawJob == null || rawJob === "" ? null : String(rawJob);
    }
  } catch {
    if (ctx.user || ctx.revalidate) return errorResponse(500, "INTERNAL", "internal error", rid);
    try {
      const user = await requireUser(request, env, deps, rid, limits, now);
      if (user instanceof Response) return user;
      const found = await activeJobFor(deps, user.id, id, user.companyId);
      if (found instanceof Response) {
        return errorResponse(found.status, "NOT_FOUND", "resource not found", rid);
      }
      jobId = found;
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  if (!jobId) return new Response(null, { status: 204, headers: { "x-request-id": rid } });
  const afterRaw = url.searchParams.get("after") || request.headers.get("last-event-id") || "";
  let after = /^[0-9]+$/.test(afterRaw) ? Number(afterRaw) : 0;
  const polls = Math.max(1, Number(env.SSE_MAX_POLLS || "20") || 20);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (frame: string) => {
        if (!open) return;
        try { controller.enqueue(encoder.encode(frame)); }
        catch { open = false; }
      };
      send("retry: 400\n\n");
      try {
        for (let i = 0; i < polls; i++) {
          if (!open) break;
          const rows = await deps.query(
            "SELECT id, type, payload FROM chat_events WHERE job_id = $1::uuid AND id > $2 ORDER BY id",
            [jobId, after],
          );
          let terminal = false;
          for (const row of rows) {
            after = Number(row.id);
            send(sseFrame(row));
            if (row.type === "done" || row.type === "error" || row.type === "cancelled") {
              terminal = true;
              break;
            }
          }
          if (terminal) break;
          if (i + 1 < polls) await sleep(250);
        }
      } catch {
        send("data: " + pyJson({
          type: "error",
          error: { code: "INTERNAL", message: "internal error", details: null },
        }) + "\n\n");
      }
      try { controller.close(); }
      catch { /* the client already hung up */ }
    },
    cancel() { open = false; },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      "x-request-id": rid,
    },
  });
}

function sseFrame(row: Record<string, unknown>): string {
  const seq = Number(row.id);
  let payload = row.payload ?? {};
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
  }
  const p = (payload && typeof payload === "object") ? payload as Record<string, unknown> : {};
  let body: Record<string, unknown>;
  if (row.type === "token") body = { type: "token", text: String(p.text ?? "") };
  else if (row.type === "status") body = { type: "status", text: String(p.text ?? "") };
  else if (row.type === "error") body = { type: "error", error: p.error ?? {} };
  else if (row.type === "done") body = { type: "done", operation: p.operation ?? null };
  else if (row.type === "cancelled") body = { type: "cancelled" };
  else body = { type: row.type, ...p };
  body.seq = seq;
  return `id: ${seq}\ndata: ${pyJson(body)}\n\n`;
}
