import { decodeCursor, encodeCursor, formatCursorTimestamp, formatJsonTimestamp, pyJson } from "../time.ts";
import type { DbValue, Deps, FrontEnv } from "../types.ts";

type Row = Awaited<ReturnType<Deps["query"]>>[number];

const rowOf = (entries: Iterable<readonly [string, DbValue]>): Row => Object.fromEntries(entries);
import {
  asBool, conditional, errorResponse, fieldError, freshRead, jsonResponse, jsonRows,
  pageLimit, parseUuid, sha256Hex, USER_CACHE_CONTROL,
} from "../http.ts";
import { proxy } from "./proxy.ts";
import { interpretAuth, rememberBag, revalidateAuth, requireUser, tokenContext } from "../middleware/auth.ts";
import {
  conversationRowSelect, employerOwnerPc, LIST_SQL, MESSAGE_ROWS, MESSAGES_SQL,
  openStream, personalOwnerPc, queryToleratingCompany, rateParams, STREAM_SQL, tsText,
} from "../middleware/ratelimit.ts";

function cursorPair(url: URL, rid: string): { at: string | null; id: string | null } | Response {
  const cur = url.searchParams.get("cursor");
  if (!cur) {return { at: null, id: null };}
  try {
    const decoded = decodeCursor(cur);
    const id = parseUuid(decoded.id);
    if (!id) {throw new Error("bad cursor");}
    // parseUtc also takes Date-parsable text Postgres may reject; send canonical ISO.
    return { at: formatCursorTimestamp(decoded.createdAt), id };
  } catch {
    return fieldError("cursor", "invalid cursor", rid);
  }
}

const likePattern = (raw: string | null): string | null => {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {return null;}
  return `%${trimmed.replaceAll(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
};

async function listConversationsFor(deps: Deps, ownerId: string, appId: string | null, cursor: { at: string | null; id: string | null }, limit: number, rid: string, audience: "PERSONAL" | "EMPLOYER" = "PERSONAL", q: string | null = null, archived = false): Promise<Response> {
  let filterSql = "";
  const params: Array<unknown> = [ownerId];
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
    : "user_id = $1::uuid AND company_id IS NULL AND c.bot_id IS NULL";
  const ownerPc = audience === "EMPLOYER" ? employerOwnerPc("$1") : personalOwnerPc("$1");
  const rows = await deps.query(
    conversationRowSelect(ownerPc)
    + "WHERE " + ownerSql + " AND c.archived = " + (archived ? "true" : "false")
    + filterSql
    + ` ORDER BY c.updated_at DESC, c.id DESC LIMIT $${params.length}`,
    params,
  );
  return jsonResponse(200, pageBody(rows, limit, conversationJson), rid);
}

export async function getConversation(request: Request, env: FrontEnv, deps: Deps, rawId: string, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const id = parseUuid(rawId);
  if (!id) {return fieldError("id", "must be a UUID", rid);}
  const user = await requireUser(request, env, deps, rid, limits, now);
  if (user instanceof Response) {return user;}
  try {
    const rows = await deps.query(
      conversationRowSelect(personalOwnerPc("$2"))
      + "WHERE c.id = $1::uuid AND c.user_id = $2::uuid AND c.company_id IS NULL",
      [id, user.id],
    );
    if (!rows[0]) {return errorResponse(404, "NOT_FOUND", "resource not found", rid);}
    return await freshRead(jsonResponse(200, { data: conversationJson(rows[0]) }, rid), request, rid);
  } catch {
    return errorResponse(500, "INTERNAL", "internal error", rid);
  }
}

export async function listConversations(request: Request, env: FrontEnv, deps: Deps, url: URL, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const page = pageLimit(url, rid);
  if (page instanceof Response) {return page;}
  const appRaw = url.searchParams.get("applicationId") || "";
  let appId: string | null = null;
  if (appRaw) {
    appId = parseUuid(appRaw);
    if (!appId) {return fieldError("applicationId", "must be a UUID", rid);}
  }
  const cursor = cursorPair(url, rid);
  if (cursor instanceof Response) {return cursor;}
  const q = likePattern(url.searchParams.get("q"));
  const archived = url.searchParams.get("archived") === "true";
  if (url.searchParams.get("audience") === "EMPLOYER") {
    const user = await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) {return user;}
    if (!user.companyId) {
      return errorResponse(403, "BUSINESS_NOT_VERIFIED", "company is not verified", rid);
    }
    try {
      return await listConversationsFor(deps, user.companyId, appId, cursor, page.limit, rid, "EMPLOYER", q, archived);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  const ctx = await tokenContext(request, env, deps, rid, limits, now);
  if (ctx instanceof Response) {return ctx;}
  if (ctx.user || ctx.revalidate) {
    const user = ctx.user ?? await revalidateAuth(ctx, env, deps, rid);
    if (user instanceof Response) {return user;}
    try {
      return await freshRead(
        await listConversationsFor(deps, user.id, appId, cursor, page.limit, rid, "PERSONAL", q, archived),
        request, rid);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  if (ctx.dev) {
    const user = await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) {return user;}
    try {
      return await listConversationsFor(deps, user.id, appId, cursor, page.limit, rid, "PERSONAL", q, archived);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  try {
    const rows = await queryToleratingCompany(deps.query, archived ? LIST_SQL.replace("AND c.archived = false ", "AND c.archived = true ") : LIST_SQL, [
      ...rateParams(ctx.hash, ctx.moment, limits.user, ctx.batch, ctx.release),
      appId, cursor.at, cursor.id, page.limit + 1, q,
    ]);
    const user = interpretAuth(rows, ctx.moment, limits.user, limits.windowMs, ctx.cacheKey, true, rid, deps, rememberBag(ctx, env));
    if (user instanceof Response) {return user;}
    const text = pyJson(pageBody(jsonRows(rows[0]?.rows), page.limit, conversationJson));
    return conditional(text, request, rid, USER_CACHE_CONTROL);
  } catch {
    const user = await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) {return user;}
    try {
      return await listConversationsFor(deps, user.id, appId, cursor, page.limit, rid, "PERSONAL", q, archived);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
}

function conversationJson(row: Row) {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    applicationId: (row.application_id === null || row.application_id === undefined) ? null : String(row.application_id),
    title: String(row.title ?? ""),
    pinned: asBool(row.pinned),
    createdAt: formatJsonTimestamp(row.created_at),
    updatedAt: formatJsonTimestamp(row.updated_at),
    status: (row.status === null || row.status === undefined) || row.status === "" ? "DONE" : String(row.status),
    queuePosition: (row.queue_position === null || row.queue_position === undefined) ? null : Number(row.queue_position),
    lastLine: (row.last_line === null || row.last_line === undefined) || row.last_line === "" ? null : String(row.last_line),
    lastMessagePreview: String(row.last_message_preview ?? "").slice(0, 140),
    createdBy: { displayName: String(row.display_name ?? "") },
    postingId: (row.posting_id === null || row.posting_id === undefined) || row.posting_id === "" ? null : String(row.posting_id),
  };
}

// Reads for a session that is already authenticated. Each is one round
// trip: visibility, then the page, job, or cancel, in a single statement.
// $1 conversation, $2 user, $3 the user's company. A company conversation
// is visible to every current member and to no one else, its author included
// once they leave; in a personal one only the author's rows are.
const SCOPED_FOUND = "WITH found AS (SELECT id, company_id FROM conversations WHERE id = $1::uuid "
  + "AND ((company_id IS NULL AND user_id = $2::uuid) OR ($3::uuid IS NOT NULL AND company_id = $3::uuid)))";

const SCOPED_MESSAGES_SQL = SCOPED_FOUND + ", page AS ("
  + "SELECT m.id, m.conversation_id, m.role, m.text, m.attachments, m.operation_id, m.created_at "
  + "FROM messages m JOIN found ON found.id = m.conversation_id "
  + "WHERE (found.company_id IS NOT NULL OR m.user_id = $2::uuid) "
  + "AND ($4::timestamptz IS NULL OR (m.created_at, m.id) < ($4::timestamptz, $5::uuid)) "
  + "ORDER BY m.created_at DESC, m.id DESC LIMIT $6"
  + ") SELECT (SELECT id FROM found) AS conversation_id, " + MESSAGE_ROWS;

const ACTIVE_JOB = "SELECT j.id FROM chat_jobs j JOIN found ON found.id = j.conversation_id "
  + "WHERE j.status IN ('PENDING', 'RUNNING') AND (found.company_id IS NOT NULL OR j.user_id = $2::uuid) "
  + "ORDER BY j.created_at DESC LIMIT 1";

const ACTIVE_JOB_SQL = SCOPED_FOUND
  + " SELECT (SELECT id FROM found) AS conversation_id, (" + ACTIVE_JOB + ") AS job_id";

// A company conversation is shared, so any member may stop its running job. In a
// personal or bot conversation only the job's creator may. `mine` is false when
// the caller may not stop the running job, and null when there is no running job.
const CANCEL_JOB = "SELECT j.id, (j.user_id = $2::uuid OR found.company_id IS NOT NULL) AS mine FROM chat_jobs j "
  + "JOIN found ON found.id = j.conversation_id "
  + "WHERE j.status IN ('PENDING', 'RUNNING') "
  + "ORDER BY j.created_at DESC LIMIT 1";

// The job-end trigger (migration 0055) writes the cancelled event inside this
// statement, so a stream always sees the terminal event. An insert here would
// be a second row. A job that finished in the meantime updates no row.
const cancelSql = (found: string, seen: string): string => found + ", active AS (" + CANCEL_JOB + "), job AS ("
  + "SELECT id FROM active WHERE mine), cancelled AS ("
  + "UPDATE chat_jobs SET status = 'CANCELLED', updated_at = now() "
  + "WHERE id = (SELECT id FROM job) AND status IN ('PENDING', 'RUNNING') RETURNING id"
  + ") SELECT " + seen + ", (SELECT id FROM cancelled) AS job_id, "
  + "(SELECT mine FROM active) AS mine, chat_run_resumable((SELECT id FROM found)) AS resumable";

export const CANCEL_SQL = cancelSql(SCOPED_FOUND, "(SELECT id FROM found) AS conversation_id");

// The same reads by bot. $1 a bot id or `push`, $2 the caller. `found` is empty
// for a bot with no thread. Only core derives the Push Bot's id and inserts its
// row, so `push` is matched by kind and is seen before that row exists.
const BOT_FOUND = "WITH bot AS (SELECT b.id FROM bots b WHERE b.user_id = $2::uuid AND b.deleted_at IS NULL "
  + "AND (b.id::text = $1 OR ($1 = 'push' AND b.kind = 'push'))), "
  + "found AS (SELECT c.id, c.company_id FROM conversations c JOIN bot ON bot.id = c.bot_id)";

const BOT_SEEN = "COALESCE((SELECT id::text FROM bot), CASE WHEN $1 = 'push' THEN $1 END) AS bot_id";

const BOT_ACTIVE_JOB_SQL = BOT_FOUND + " SELECT " + BOT_SEEN + ", (" + ACTIVE_JOB + ") AS job_id";

const BOT_CANCEL_SQL = cancelSql(BOT_FOUND, BOT_SEEN);

const present = (value: unknown): boolean => (value !== null && value !== undefined) && value !== "";

export const isBotThread = async (deps: Deps, conversationId: string): Promise<boolean> =>
  (await deps.query("SELECT 1 FROM conversations WHERE id = $1::uuid AND bot_id IS NOT NULL", [conversationId])).length > 0;

// push-agent owns a company's conversations and push-bot the rest. Without AGENT_ORIGIN one AI service answers both, so nothing is asked.
export const aiOriginFor = async (env: FrontEnv, deps: Deps, conversationId: string | null): Promise<string> => {
  const agent = (env.AGENT_ORIGIN || "").trim();
  if (!agent || !conversationId) {return env.AI_ORIGIN || "";}
  const company = await deps.query("SELECT 1 FROM conversations WHERE id = $1::uuid AND company_id IS NOT NULL", [conversationId]);
  return company.length > 0 ? agent : env.AI_ORIGIN || "";
};

async function listMessagesFor(deps: Deps, userId: string, id: string, cursor: { at: string | null; id: string | null }, limit: number, rid: string, companyId: string | null): Promise<Response> {
  const rows = await deps.query(SCOPED_MESSAGES_SQL, [id, userId, companyId, cursor.at, cursor.id, limit + 1]);
  if (!present(rows[0]?.conversation_id)) {return errorResponse(404, "NOT_FOUND", "resource not found", rid);}
  const page = jsonRows(rows[0].rows);
  return jsonResponse(200, pageBody(page, limit, messageJson(await storedFiles(deps, id, page))), rid);
}

export async function listMessages(request: Request, env: FrontEnv, deps: Deps, url: URL, rawId: string, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const id = parseUuid(rawId);
  if (!id) {return fieldError("id", "must be a UUID", rid);}
  const page = pageLimit(url, rid);
  if (page instanceof Response) {return page;}
  const cursor = cursorPair(url, rid);
  if (cursor instanceof Response) {return cursor;}
  const ctx = await tokenContext(request, env, deps, rid, limits, now);
  if (ctx instanceof Response) {return ctx;}
  if (ctx.user || ctx.revalidate) {
    const user = ctx.user ?? await revalidateAuth(ctx, env, deps, rid);
    if (user instanceof Response) {return user;}
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
    if (user instanceof Response) {return user;}
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
    if (user instanceof Response) {return user;}
    const conversationId = rows[0]?.conversation_id;
    if ((conversationId === null || conversationId === undefined) || conversationId === "") {
      return errorResponse(404, "NOT_FOUND", "resource not found", rid);
    }
    const messages = jsonRows(rows[0]?.rows);
    const text = pyJson(pageBody(messages, page.limit, messageJson(await storedFiles(deps, String(conversationId), messages))));
    return conditional(text, request, rid, USER_CACHE_CONTROL);
  } catch {
    const user = await requireUser(request, env, deps, rid, limits, now);
    if (user instanceof Response) {return user;}
    try {
      return await listMessagesFor(deps, user.id, id, cursor, page.limit, rid, user.companyId);
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
}

type StoredFile = { fileName: string; size: number };
type ApplicationChip = { title: string; documentTitles: Array<string> };
type StoredAttachments = { files: Map<string, StoredFile>; applications: Map<string, ApplicationChip> };

// Company conversations only. A personal conversation has a null company_id, so the join matches nothing.
const APPLICATION_CHIPS_SQL = `SELECT a.id, u.display_name,
  COALESCE((
    SELECT json_agg(docs.title ORDER BY docs.ord, docs.title)
    FROM (
      SELECT s.title, 0 AS ord FROM application_snapshots s WHERE s.application_id = a.id
      UNION
      SELECT f.file_name, 1 AS ord FROM application_files f WHERE f.application_id = a.id
    ) docs
  ), '[]'::json) AS document_titles
 FROM applications a
 JOIN jobs j ON j.id = a.job_id
 JOIN job_postings p ON p.id = j.source_posting_id
 JOIN conversations c ON c.id = $1::uuid AND c.company_id IS NOT NULL AND c.company_id = p.company_id
 JOIN users u ON u.id = a.user_id
 WHERE a.id = ANY($2::uuid[])`;

function chipTitles(value: unknown): Array<string> {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) {return [];}
  return raw.map((item) => String(item ?? ""));
}

function attachmentList(raw: unknown): Array<unknown> {
  let attachments = raw;
  if (typeof attachments === "string") {
    try { attachments = JSON.parse(attachments); } catch { attachments = []; }
  }
  return Array.isArray(attachments) ? attachments : [];
}

async function storedFiles(deps: Deps, conversationId: string, messages: Array<Row>): Promise<StoredAttachments> {
  const files: Map<string, StoredFile> = new Map();
  const applications: Map<string, ApplicationChip> = new Map();
  const ids = new Set<string>();
  const applicationIds = new Set<string>();
  for (const message of messages) {
    for (const raw of attachmentList(message.attachments)) {
      if (!raw || typeof raw !== "object") {continue;}
      const item = rowOf(Object.entries(raw));
      const id = parseUuid(String(item.id ?? ""));
      if (!id) {continue;}
      ids.add(id);
      if (String(item.type ?? "") === "APPLICATION") {applicationIds.add(id);}
    }
  }
  if (ids.size) {
    try {
      const rows = await deps.query(
        "SELECT id, file_name, octet_length(content) AS size FROM conversation_attachments WHERE conversation_id = $1::uuid AND id = ANY($2::uuid[])",
        [conversationId, [...ids]],
      );
      for (const row of rows) {files.set(String(row.id), { fileName: String(row.file_name), size: Number(row.size) });}
    } catch {
      // names and sizes are extras; the page is still served without them
    }
  }
  if (applicationIds.size) {
    try {
      const rows = await deps.query(APPLICATION_CHIPS_SQL, [conversationId, [...applicationIds]]);
      for (const row of rows) {
        applications.set(String(row.id).toLowerCase(), {
          title: String(row.display_name ?? ""),
          documentTitles: chipTitles(row.document_titles),
        });
      }
    } catch {
      // titles are extras; the page is still served without them
    }
  }
  return { files, applications };
}

const messageJson = (stored: StoredAttachments) => (row: Row) => ({
  id: String(row.id),
  conversationId: String(row.conversation_id),
  role: String(row.role),
  text: String(row.text ?? ""),
  attachments: attachmentList(row.attachments)
    .map((raw) => attachmentJson(raw, stored))
    .filter((item) => item !== null),
  operationId: (row.operation_id === null || row.operation_id === undefined) ? null : String(row.operation_id),
  createdAt: formatJsonTimestamp(row.created_at),
});

type AttachmentOut = {
  type: string; id: string; documentId?: string; title?: string; fileName?: string; size?: number; documentTitles?: Array<string>;
};

function attachmentJson(raw: unknown, stored: StoredAttachments): AttachmentOut | null {
  const a = (raw && typeof raw === "object") ? rowOf(Object.entries(raw)) : {};
  const title = (a.title === null || a.title === undefined) ? "" : String(a.title);
  const name = String(a.name ?? a.fileName ?? "");
  const mime = String(a.mime ?? a.mimeType ?? "");
  if (title.toLowerCase().endsWith(".md") || name.toLowerCase().endsWith(".md") || mime.toLowerCase() === "text/markdown") {
    return null;
  }
  const out: AttachmentOut = { type: String(a.type ?? ""), id: String(a.id ?? "") };
  if ((a.documentId !== null && a.documentId !== undefined)) {out.documentId = String(a.documentId);}
  if ((a.title !== null && a.title !== undefined)) {out.title = String(a.title);}
  const file = stored.files.get(parseUuid(String(out.id)) ?? "");
  if (file) {Object.assign(out, file);}
  if (String(out.type) === "APPLICATION") {
    const chip = stored.applications.get(parseUuid(String(out.id)) ?? "");
    if (chip) {
      out.title = chip.title;
      out.documentTitles = chip.documentTitles;
    }
  }
  return out;
}

function pageBody<T extends { id: string; createdAt: string; updatedAt?: string }>(rows: Array<Row>, limit: number, map: (row: Row) => T) {
  const more = rows.length > limit;
  const items = (more ? rows.slice(0, limit) : rows).map(map);
  let nextCursor: string | null = null;
  const last = items.at(-1);
  if (more && last) {
    const stamp = String(last.updatedAt ?? last.createdAt);
    const id = String(last.id);
    nextCursor = encodeCursor(stamp, id);
  }
  return { data: items, page: { nextCursor, hasMore: more } };
}

/** The newest running job id, null when there is none, or a 404 when the conversation is not visible. */
async function activeJobFor(deps: Deps, userId: string, id: string, companyId: string | null, rid: string): Promise<string | null | Response> {
  const rows = await deps.query(ACTIVE_JOB_SQL, [id, userId, companyId]);
  if (!present(rows[0]?.conversation_id)) {return errorResponse(404, "NOT_FOUND", "resource not found", rid);}
  return present(rows[0].job_id) ? String(rows[0].job_id) : null;
}

type Limits = { user: number; public: number; windowMs: number };

/** The row of the job a cancel statement stopped, or the error it answers with. `seen` is the column that is null when the caller may not see the chat. */
const cancelActive = async (deps: Deps, sql: string, params: Array<unknown>, seen: string, rid: string): Promise<Row | Response> => {
  try {
    const row = (await deps.query(sql, params))[0];
    if (!present(row?.[seen])) {return errorResponse(404, "NOT_FOUND", "resource not found", rid);}
    if (present(row.job_id)) {return row;}
    const mine = row.mine;
    if (mine === false || mine === "f" || mine === "false") {
      return errorResponse(403, "FORBIDDEN", "forbidden", rid);
    }
    return errorResponse(409, "CONFLICT", "no active stream", rid);
  } catch {
    return errorResponse(500, "INTERNAL", "internal error", rid);
  }
};

export const streamCancel = async (request: Request, env: FrontEnv, deps: Deps, rawId: string, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> => {
  const id = parseUuid(rawId);
  if (!id) {return fieldError("id", "must be a UUID", rid);}
  const user = await requireUser(request, env, deps, rid, limits, now);
  if (user instanceof Response) {return user;}
  const row = await cancelActive(deps, CANCEL_SQL, [id, user.id, user.companyId], "conversation_id", rid);
  if (row instanceof Response) {return row;}
  return jsonResponse(200, { data: { jobId: String(row.job_id), status: "CANCELLED" } }, rid);
};

const botAddress = (raw: string): string | null => (raw === "push" ? raw : parseUuid(raw));

export const streamBotCancel = async (request: Request, env: FrontEnv, deps: Deps, rawId: string, rid: string, limits: Limits, now: () => Date): Promise<Response> => {
  const address = botAddress(rawId);
  if (!address) {return fieldError("id", "must be a UUID", rid);}
  const user = await requireUser(request, env, deps, rid, limits, now);
  if (user instanceof Response) {return user;}
  const row = await cancelActive(deps, BOT_CANCEL_SQL, [address, user.id], "bot_id", rid);
  if (row instanceof Response) {return row;}
  return jsonResponse(200, { data: { status: "CANCELLED", resumable: asBool(row.resumable) } }, rid);
};

const resumeSeq = (request: Request, url: URL): number => {
  const raw = url.searchParams.get("after") || request.headers.get("last-event-id") || "";
  return /^[0-9]+$/.test(raw) ? Number(raw) : 0;
};

export const streamBotActive = async (request: Request, env: FrontEnv, deps: Deps, url: URL, rawId: string, rid: string, limits: Limits, now: () => Date): Promise<Response> => {
  const address = botAddress(rawId);
  if (!address) {return fieldError("id", "must be a UUID", rid);}
  const user = await requireUser(request, env, deps, rid, limits, now);
  if (user instanceof Response) {return user;}
  let row: Row | undefined;
  try {
    row = (await deps.query(BOT_ACTIVE_JOB_SQL, [address, user.id]))[0];
  } catch {
    return errorResponse(500, "INTERNAL", "internal error", rid);
  }
  if (!present(row?.bot_id)) {return errorResponse(404, "NOT_FOUND", "resource not found", rid);}
  if (!present(row?.job_id)) {return new Response(null, { status: 204, headers: { "x-request-id": rid } });}
  return jobEvents(request, String(row?.job_id), resumeSeq(request, url), env, deps, rid, true);
};

export async function streamActive(request: Request, env: FrontEnv, deps: Deps, url: URL, rawId: string, rid: string, limits: { user: number; public: number; windowMs: number }, now: () => Date): Promise<Response> {
  const id = parseUuid(rawId);
  if (!id) {return fieldError("id", "must be a UUID", rid);}
  const ctx = await tokenContext(request, env, deps, rid, limits, now);
  if (ctx instanceof Response) {return ctx;}
  let jobId: string | null;
  try {
    if (ctx.user || ctx.revalidate) {
      const user = ctx.user ?? await revalidateAuth(ctx, env, deps, rid);
      if (user instanceof Response) {return user;}
      const found = await activeJobFor(deps, user.id, id, user.companyId, rid);
      if (found instanceof Response) {return found;}
      jobId = found;
    } else if (ctx.dev) {
      const user = await requireUser(request, env, deps, rid, limits, now);
      if (user instanceof Response) {return user;}
      const found = await activeJobFor(deps, user.id, id, user.companyId, rid);
      if (found instanceof Response) {return found;}
      jobId = found;
    } else {
      const rows = await queryToleratingCompany(deps.query, STREAM_SQL, [
        ...rateParams(ctx.hash, ctx.moment, limits.user, ctx.batch, ctx.release), id,
      ]);
      const user = interpretAuth(rows, ctx.moment, limits.user, limits.windowMs, ctx.cacheKey, true, rid, deps, rememberBag(ctx, env));
      if (user instanceof Response) {return user;}
      const conversationId = rows[0]?.conversation_id;
      if ((conversationId === null || conversationId === undefined) || conversationId === "") {
        return errorResponse(404, "NOT_FOUND", "resource not found", rid);
      }
      const rawJob = rows[0]?.job_id;
      jobId = (rawJob === null || rawJob === undefined) || rawJob === "" ? null : String(rawJob);
    }
  } catch {
    if (ctx.user || ctx.revalidate) {return errorResponse(500, "INTERNAL", "internal error", rid);}
    try {
      const user = await requireUser(request, env, deps, rid, limits, now);
      if (user instanceof Response) {return user;}
      const found = await activeJobFor(deps, user.id, id, user.companyId, rid);
      if (found instanceof Response) {return found;}
      jobId = found;
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  if (!jobId) {return new Response(null, { status: 204, headers: { "x-request-id": rid } });}
  return jobEvents(request, jobId, resumeSeq(request, url), env, deps, rid);
}

const queuedJobId = (body: unknown): string => {
  if (typeof body !== "object" || body === null || !("data" in body)) {return "";}
  const { data } = body;
  if (typeof data !== "object" || data === null || !("result" in data)) {return "";}
  const { result } = data;
  if (typeof result !== "object" || result === null || !("value" in result)) {return "";}
  const { value } = result;
  if (typeof value !== "object" || value === null || !("jobId" in value)) {return "";}
  return String(value.jobId ?? "");
};

/** Queues the send in core and streams its job. `bot` is true for a send addressed by bot. */
export const streamMessage = async (request: Request, env: FrontEnv, deps: Deps, rid: string, bot = false): Promise<Response> => {
  const queued = await proxy(request, env.CORE, rid);
  if (queued.status !== 202) {return queued;}
  let jobId: string;
  try {
    jobId = queuedJobId(await queued.json());
  } catch {
    jobId = "";
  }
  if (!parseUuid(jobId)) {return errorResponse(500, "INTERNAL", "internal error", rid);}
  return jobEvents(request, jobId, 0, env, deps, rid, bot);
};

// Each poll is a Neon read. Idle polls back off to MAX_POLL_MS; a full
// page is read again at once so a replay is not slowed to one page a poll.
const POLL_MS = 250;
const MAX_POLL_MS = 1000;
const EVENT_PAGE = 200;

const EVENTS_SQL = "SELECT id, type, payload, " + tsText("created_at") + " AS created_at FROM chat_events "
  + `WHERE job_id = $1::uuid AND id > $2 ORDER BY id LIMIT ${EVENT_PAGE}`;

// A connection that would close before sending anything keeps polling while its job is still
// live: the app reads an empty connection as the end of the run. Capped near the job deadline.
const LIVE_JOB_SQL = "SELECT 1 FROM chat_jobs WHERE id = $1::uuid AND status IN ('PENDING', 'RUNNING')";
const LIVE_ROUNDS = 45;

const jobEvents = async (request: Request, jobId: string, start: number, env: FrontEnv, deps: Deps, rid: string, bot = false): Promise<Response> => {
  const release = openStream(await sha256Hex(request.headers.get("authorization") || ""));
  if (!release) {return errorResponse(429, "RATE_LIMITED", "too many open streams", rid);}
  let after = start;
  const version = a2uiVersion(request);
  const polls = Math.max(1, Number(env.SSE_MAX_POLLS || "20") || 20);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => { setTimeout(r, ms); }));
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (frame: string) => {
        if (!open) {return;}
        try { controller.enqueue(encoder.encode(frame)); }
        catch { open = false; }
      };
      send("retry: 400\n\n");
      try {
        let idle = 0;
        let budget = polls;
        let sent = false;
        for (let i = 0; i < budget; i++) {
          if (!open) {break;}
          const rows = await deps.query(EVENTS_SQL, [jobId, after]);
          let terminal = false;
          for (const row of rows) {
            after = Number(row.id);
            const payload = payloadOf(row);
            if (hidden(row.type, payload, bot, version)) {continue;}
            send(sseFrame(row, payload, jobId, version));
            sent = true;
            if (row.type === "done" || row.type === "error" || row.type === "cancelled") {
              terminal = true;
              break;
            }
          }
          if (terminal || !open) {break;}
          if (rows.length >= EVENT_PAGE) {continue;}
          idle = rows.length ? 0 : idle + 1;
          if (i + 1 === budget && !sent && budget < polls * LIVE_ROUNDS
            && (await deps.query(LIVE_JOB_SQL, [jobId])).length > 0) {budget += polls;}
          if (i + 1 < budget) {
            if (rows.length === 0) {send(": ping\n\n");}
            await sleep(Math.min(MAX_POLL_MS, POLL_MS * 2 ** Math.max(0, idle - 1)));
          }
        }
      } catch {
        send("data: " + pyJson({
          type: "error",
          error: { code: "INTERNAL", message: "internal error", details: null },
        }) + "\n\n");
      }
      release();
      try { controller.close(); }
      catch { /* the client already hung up */ }
    },
    cancel() { open = false; release(); },
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
};

const objectOf = (value: unknown): Row => {
  let payload = value;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
  }
  return (payload && typeof payload === "object") ? rowOf(Object.entries(payload)) : {};
};

const payloadOf = (row: Row): Row => objectOf(row.payload);

// The card rows the AI service stores with their A2UI surface under `a2ui`, one per version
// (services/ai/src/app/domain/a2ui.py `surfaces`).
const CARD_KINDS = new Set(["approval", "choice", "plan", "paper", "todo", "diff", "fit", "result"]);

/** The A2UI version a request names with A2UI-Version: 1.0, else v0.9.1 (also when absent or unknown). */
const a2uiVersion = (request: Request): string => (request.headers.get("a2ui-version")?.trim() === "1.0" ? "1.0" : "v0.9.1");

const surfaceOf = (p: Row, version: string): Row | undefined => {
  const surface = objectOf(objectOf(p.a2ui)[version]);
  return Array.isArray(surface.messages) ? surface : undefined;
};

// A bot stream promises a phase on every status. A row without one was stored
// before phases, or by a run of the AI service that does not write them yet.
// A card row without a surface is one no client draws, such as a gate the server answered itself.
const hidden = (type: unknown, p: Row, bot: boolean, version: string): boolean => {
  if (type === "status") {return bot && (p.phase === null || p.phase === undefined);}
  if (typeof type === "string" && CARD_KINDS.has(type)) {return surfaceOf(p, version) === undefined;}
  if (type !== "file") {return false;}
  const name = String(p.name ?? p.fileName ?? "");
  const mime = String(p.mime ?? p.mimeType ?? "");
  return name.toLowerCase().endsWith(".md") || mime.toLowerCase() === "text/markdown";
};

const STATUS_FIELDS = ["phase", "since", "ahead", "for", "cardId"];

const frameOf = (row: Row, p: Row, version: string) => {
  if (row.type === "token") {return { type: "token", text: String(p.text ?? "") };}
  if (row.type === "status") {
    const fields = STATUS_FIELDS.flatMap((field): Array<[string, DbValue]> => (p[field] !== null && p[field] !== undefined ? [[field, p[field]]] : []));
    return { type: "status", text: String(p.text ?? ""), ...rowOf(fields) };
  }
  if (row.type === "error") {return { type: "error", error: p.error ?? {} };}
  if (row.type === "done") {return p.awaiting ? { type: "done", operation: p.operation ?? null, awaiting: p.awaiting } : { type: "done", operation: p.operation ?? null };}
  if (row.type === "cancelled") {return { type: "cancelled", resumable: p.resumable === true };}
  const surface = surfaceOf(p, version);
  if (surface && typeof row.type === "string" && CARD_KINDS.has(row.type)) {
    return { type: "a2ui", kind: row.type, surfaceId: surface.surfaceId ?? null, messages: surface.messages };
  }
  return { type: row.type, ...p };
};

/** `turn` is the job id: opaque to a client and equal for every frame of one run. */
const sseFrame = (row: Row, p: Row, turn: string, version: string): string => {
  const seq = Number(row.id);
  const body = { ...frameOf(row, p, version), seq, at: formatJsonTimestamp(row.created_at), turn };
  return `id: ${seq}\ndata: ${pyJson(body)}\n\n`;
};
