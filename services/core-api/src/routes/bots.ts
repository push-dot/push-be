import { boundTransaction, lockOwner } from "../billing/credits.ts";
import { isLockTimeout, one, query, type Query, type Transaction } from "../db.ts";
import { HttpError, asBool, codePoints, data, fieldError, noContent, pageBody, parseUuid, requireUuid, uuid5Url } from "../http.ts";
import { pageOf, pageResult, revisionUpdate, ts } from "../page.ts";
import { decodeCursor, encodeCursor } from "../time.ts";
import type { Ctx } from "../types.ts";
import { openClause, readObject, rejectFields, textOf, httpsUrl, withPublicStatus } from "./recruiting-shared.ts";
import { requireAgentConsent, convDto } from "./conversations.ts";
import { documentLibraryItem, libraryItemsNewerFirst, sourceItem, type DocumentsLibraryRow } from "./sources.ts";

const COMPANY_LIMIT: Record<string, number | null> = { FREE: 3, PRO: 20, ULTRA: null };
const PUSH_LABEL = "Push Bot";
const IMAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const pushBotId = (userId: string): Promise<string> => uuid5Url(`push:bot:${userId}`);

const planTier = (plan: unknown): string => {
  const tier = plan == null ? "" : String(plan).trim().toUpperCase();
  return tier || "FREE";
};

const companyBotLimit = (plan: unknown): number | null => {
  const tier = planTier(plan);
  const limit = COMPANY_LIMIT[tier];
  return limit === undefined ? COMPANY_LIMIT.FREE : limit;
};

const canonUrl = (value: string): string => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${url.protocol}//${host}${path}${url.search}`;
  } catch {
    return value.trim();
  }
};

const postingIdFromUrl = (url: string): string | null => {
  const match = url.match(UUID_IN_PATH);
  if (!match) return null;
  try {
    return requireUuid(match[0], "url");
  } catch {
    return null;
  }
};

type BotRow = Record<string, unknown>;

const botDto = (row: BotRow): Record<string, unknown> => ({
  id: String(row.id),
  kind: String(row.kind),
  displayName: String(row.display_name ?? ""),
  companyId: row.company_id == null ? null : String(row.company_id),
  companyName: String(row.company_name ?? ""),
  postingId: row.posting_id == null ? null : String(row.posting_id),
  postingUrl: row.posting_url == null ? null : String(row.posting_url),
  avatarKey: row.avatar_key == null ? null : String(row.avatar_key),
  mascotKey: row.mascot_key == null ? null : String(row.mascot_key),
  notificationsMuted: asBool(row.notifications_muted),
  revision: Number(row.revision ?? 1),
  createdAt: ts(row.created_at),
  updatedAt: ts(row.updated_at),
  lastMessagePreview: row.last_message_preview == null ? "" : String(row.last_message_preview),
  unread: row.unread === true || row.unread === "t",
  status: row.status == null ? "DONE" : String(row.status),
});

const BOT_COLS = "b.id, b.kind, b.company_id, b.company_name, b.posting_id, b.posting_url, b.display_name, b.avatar_key, b.mascot_key, b.notifications_muted, b.revision, b.created_at, b.updated_at";
const BOT_RETURNING = "id, kind, company_id, company_name, posting_id, posting_url, display_name, avatar_key, mascot_key, notifications_muted, revision, created_at, updated_at";

const ensurePushBot = async (ctx: Ctx): Promise<string> => {
  const id = await pushBotId(ctx.user.id);
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    `INSERT INTO bots (id, user_id, kind, company_name, display_name, created_at, updated_at)
     VALUES ($1,$2,'push','', $3,$4,$4)
     ON CONFLICT (id) DO NOTHING`,
    [id, ctx.user.id, PUSH_LABEL, now]);
  return id;
};

const assertOwnedBot = async (ctx: Ctx, id: string): Promise<BotRow> => {
  const row = await one(ctx.deps.query,
    `SELECT ${BOT_COLS} FROM bots b WHERE b.id = $1 AND b.user_id = $2 AND b.deleted_at IS NULL`,
    [id, ctx.user.id]);
  if (!row) throw new HttpError(404, "NOT_FOUND", "resource not found");
  return row;
};

const enrichBotsSql = (): string => {
  return `WITH last_msg AS (
       SELECT DISTINCT ON (c.bot_id) c.bot_id, left(m.text, 140) AS preview
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
       WHERE c.user_id = $1 AND c.bot_id IS NOT NULL AND NOT c.archived
       ORDER BY c.bot_id, m.created_at DESC, m.id DESC
     ),
     bot_activity AS (
       SELECT c.bot_id,
         max(c.updated_at) AS latest_at,
         bool_or(EXISTS (
           SELECT 1 FROM approvals a
           WHERE a.conversation_id = c.id AND a.status = 'PENDING'
             AND (a.expires_at IS NULL OR a.expires_at > now())
         )) AS needs_approval,
         bool_or(EXISTS (
           SELECT 1 FROM chat_jobs j
           WHERE j.conversation_id = c.id AND j.status IN ('PENDING', 'RUNNING')
         )) AS running
       FROM conversations c
       WHERE c.user_id = $1 AND c.bot_id IS NOT NULL AND NOT c.archived
       GROUP BY c.bot_id
     )
     SELECT ${BOT_COLS},
       COALESCE(lm.preview, '') AS last_message_preview,
       CASE
         WHEN ba.needs_approval THEN 'NEEDS_APPROVAL'
         WHEN ba.running THEN 'RUNNING'
         ELSE 'DONE'
       END AS status,
       (
         ba.latest_at IS NOT NULL AND (
           br.read_at IS NULL OR ba.latest_at > br.read_at
         )
       ) AS unread
     FROM bots b
     LEFT JOIN last_msg lm ON lm.bot_id = b.id
     LEFT JOIN bot_activity ba ON ba.bot_id = b.id
     LEFT JOIN bot_read_markers br ON br.user_id = b.user_id AND br.bot_id = b.id
     WHERE b.user_id = $1 AND b.deleted_at IS NULL`;
};

const listBots = async (ctx: Ctx): Promise<Response> => {
  await ensurePushBot(ctx);
  const rows = await query(ctx.deps.query,
    enrichBotsSql() + " ORDER BY CASE WHEN b.kind = 'push' THEN 0 ELSE 1 END, b.updated_at DESC, b.id DESC",
    [ctx.user.id]);
  const items = rows.rows.map(botDto);
  return data(200, items, ctx.rid);
};

const inTransactionOf = (ctx: Ctx): Transaction =>
  ctx.deps.transaction ?? ((work) => work(ctx.deps.query));

const resolveCompanyName = async (q: Query, companyId: string | null, companyName: string): Promise<{ companyId: string | null; companyName: string }> => {
  if (companyId) {
    const company = await one(q, "SELECT id, name FROM companies WHERE id = $1", [companyId]);
    if (!company) throw new HttpError(404, "NOT_FOUND", "resource not found");
    return { companyId, companyName: String(company.name ?? companyName) };
  }
  if (!companyName.trim()) throw fieldError("companyName", "required when companyId is omitted");
  return { companyId: null, companyName: companyName.trim() };
};

const createBot = async (ctx: Ctx): Promise<Response> => {
  const body = await readObject(ctx.request);
  rejectFields(body, ["id", "kind", "revision", "createdAt", "updatedAt"]);
  const companyId = body.companyId == null ? null : requireUuid(String(body.companyId), "companyId");
  const companyName = body.companyName == null ? "" : textOf(body.companyName, "companyName", 0, 200);
  let postingId: string | null = null;
  if (body.postingId != null) postingId = requireUuid(String(body.postingId), "postingId");
  let postingUrl: string | null = null;
  if (body.postingUrl != null) {
    postingUrl = textOf(body.postingUrl, "postingUrl", 1, 2000);
    if (!httpsUrl(postingUrl)) throw fieldError("postingUrl", "must be an http(s) URL without credentials");
  }
  let displayName = body.displayName == null ? "" : textOf(body.displayName, "displayName", 1, 120);
  await ensurePushBot(ctx);
  const now = ctx.now.toISOString();
  const id = crypto.randomUUID();
  try {
    const inserted = await inTransactionOf(ctx)(async (q) => {
      const limit = companyBotLimit(ctx.user.plan);
      if (limit != null) {
        await boundTransaction(q, "3s");
        await lockOwner(q, "PERSONAL", ctx.user.id);
        const row = await one(q, "SELECT count(*)::int AS n FROM bots WHERE user_id = $1 AND kind = 'company' AND deleted_at IS NULL", [ctx.user.id]);
        if (Number(row?.n ?? 0) >= limit) {
          throw new HttpError(403, "BOT_LIMIT", "company bot limit reached for your plan", { limit, plan: planTier(ctx.user.plan) });
        }
      }
      const resolved = await resolveCompanyName(q, companyId, companyName);
      if (postingId != null) {
        const posting = await one(q, "SELECT id, company, title FROM job_postings WHERE id = $1", [postingId]);
        if (!posting) throw new HttpError(404, "NOT_FOUND", "resource not found");
        if (!resolved.companyName) resolved.companyName = String(posting.company ?? "");
      }
      if (!displayName) {
        displayName = postingId
          ? resolved.companyName
          : resolved.companyName || "Company bot";
      }
      await query(q,
        `INSERT INTO bots (id, user_id, kind, company_id, company_name, posting_id, posting_url, display_name, created_at, updated_at)
         VALUES ($1,$2,'company',$3,$4,$5,$6,$7,$8,$8)`,
        [id, ctx.user.id, resolved.companyId, resolved.companyName, postingId, postingUrl, displayName, now]);
      return {
        companyId: resolved.companyId, companyName: resolved.companyName,
      };
    });
    return data(201, botDto({
      id, kind: "company", company_id: inserted.companyId, company_name: inserted.companyName,
      posting_id: postingId, posting_url: postingUrl, display_name: displayName,
      avatar_key: null, mascot_key: null, notifications_muted: false, revision: 1,
      created_at: now, updated_at: now, last_message_preview: "", unread: false, status: "DONE",
    }), ctx.rid);
  } catch (err) {
    if (isLockTimeout(err)) {
      throw new HttpError(429, "RATE_LIMITED", "too many requests", { retryAfterSec: 1 });
    }
    throw err;
  }
};

const getBot = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  if (id === await pushBotId(ctx.user.id)) await ensurePushBot(ctx);
  const rows = await query(ctx.deps.query, enrichBotsSql() + " AND b.id = $2", [ctx.user.id, id]);
  if (!rows.rows[0]) throw new HttpError(404, "NOT_FOUND", "resource not found");
  return data(200, botDto(rows.rows[0]), ctx.rid);
};

const patchBot = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  rejectFields(body, ["id", "kind", "companyId", "companyName", "postingId", "postingUrl", "createdAt", "updatedAt"]);
  const current = await assertOwnedBot(ctx, id);
  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision)) {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
  if (Number(current.revision) !== body.expectedRevision) {
    throw new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision: Number(current.revision) });
  }
  let displayName = String(current.display_name ?? "");
  if (body.displayName != null) {
    displayName = textOf(body.displayName, "displayName", 1, 120);
  }
  let notificationsMuted = asBool(current.notifications_muted);
  if (body.notificationsMuted != null) {
    if (typeof body.notificationsMuted !== "boolean") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
    notificationsMuted = body.notificationsMuted;
  }
  let avatarKey = current.avatar_key == null ? null : String(current.avatar_key);
  if ("avatarKey" in body) {
    if (body.avatarKey === null) avatarKey = null;
    else if (typeof body.avatarKey === "string" && IMAGE_KEY.test(body.avatarKey) && !body.avatarKey.includes("..")) {
      avatarKey = body.avatarKey;
    } else throw fieldError("avatarKey", "invalid image key");
  }
  let mascotKey = current.mascot_key == null ? null : String(current.mascot_key);
  if ("mascotKey" in body) {
    if (body.mascotKey === null) mascotKey = null;
    else if (typeof body.mascotKey === "string" && IMAGE_KEY.test(body.mascotKey) && !body.mascotKey.includes("..")) {
      mascotKey = body.mascotKey;
    } else throw fieldError("mascotKey", "invalid image key");
  }
  const now = ctx.now.toISOString();
  const updated = await revisionUpdate(ctx.deps.query, "bots",
    `UPDATE bots SET revision = revision + 1, display_name = $3, notifications_muted = $4, avatar_key = $5, mascot_key = $6, updated_at = $7
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND revision = $8
     RETURNING ${BOT_RETURNING}`,
    [id, ctx.user.id, displayName, notificationsMuted, avatarKey, mascotKey, now, body.expectedRevision],
    id, ctx.user.id);
  if (!updated) throw new HttpError(404, "NOT_FOUND", "resource not found");
  return data(200, botDto({ ...updated, last_message_preview: "", unread: false, status: "DONE" }), ctx.rid);
};

const deleteBot = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query, "SELECT kind FROM bots WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL", [id, ctx.user.id]);
  if (!row) throw new HttpError(404, "NOT_FOUND", "resource not found");
  if (String(row.kind) === "push") {
    throw new HttpError(403, "DEFAULT_BOT_PROTECTED", "default bot cannot be deleted");
  }
  await query(ctx.deps.query,
    "UPDATE bots SET deleted_at = $3, updated_at = $3 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
    [id, ctx.user.id, ctx.now.toISOString()]);
  return noContent(ctx.rid);
};

const listBotConversations = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const botId = requireUuid(idRaw, "id");
  await assertOwnedBot(ctx, botId);
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id, botId];
  let sql = "SELECT id, revision, application_id, title, pinned, archived, created_at, updated_at FROM conversations WHERE user_id = $1 AND bot_id = $2 AND archived = false";
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (updated_at, id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY updated_at DESC, id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: convDto(row), createdAt: row.updated_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
};

const createBotConversation = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const botId = requireUuid(idRaw, "id");
  await assertOwnedBot(ctx, botId);
  await requireAgentConsent(ctx);
  const body = await readObject(ctx.request);
  rejectFields(body, ["botId", "id"]);
  if (typeof body.title !== "string") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  if (codePoints(body.title) > 300) {
    throw new HttpError(400, "VALIDATION_ERROR", "title must be at most 300 characters", { field: "title" });
  }
  let applicationId: string | null = null;
  if (body.applicationId != null) {
    applicationId = requireUuid(String(body.applicationId), "applicationId");
    const app = await one(ctx.deps.query, "SELECT id FROM applications WHERE id = $1 AND user_id = $2", [applicationId, ctx.user.id]);
    if (!app) throw new HttpError(404, "NOT_FOUND", "resource not found");
  }
  const bot = await assertOwnedBot(ctx, botId);
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    `INSERT INTO conversations (id, user_id, revision, application_id, title, pinned, archived, created_at, updated_at, bot_id, company_id, posting_id)
     VALUES ($1,$2,1,$3,$4,false,false,$5,$5,$6,$7,$8)`,
    [id, ctx.user.id, applicationId, body.title, now, botId, bot.company_id ?? null, bot.posting_id ?? null]);
  return data(201, convDto({
    id, revision: 1, application_id: applicationId, title: body.title, pinned: false, created_at: now, updated_at: now,
  }), ctx.rid);
};

const linkPreview = async (ctx: Ctx): Promise<Response> => {
  const body = await readObject(ctx.request);
  rejectFields(body, ["status"]);
  const url = textOf(body.url, "url", 1, 2000);
  if (!httpsUrl(url)) throw fieldError("url", "must be an http(s) URL without credentials");
  const byId = postingIdFromUrl(url);
  if (byId) {
    const posting = await one(ctx.deps.query, "SELECT id, company, title FROM job_postings WHERE id = $1", [byId]);
    if (posting) {
      return data(200, {
        status: "found",
        company: String(posting.company ?? ""),
        title: String(posting.title ?? ""),
        postingId: String(posting.id),
      }, ctx.rid);
    }
  }
  const canon = canonUrl(url);
  const row = await one(ctx.deps.query,
    `SELECT id, company, title FROM job_postings
     WHERE source_url IS NOT NULL AND (
       source_url = $1 OR source_url = $2 OR rtrim(source_url, '/') = rtrim($1, '/')
     )
     ORDER BY created_at DESC LIMIT 1`,
    [url, canon]);
  if (row) {
    return data(200, {
      status: "found",
      company: String(row.company ?? ""),
      title: String(row.title ?? ""),
      postingId: String(row.id),
    }, ctx.rid);
  }
  return data(200, { status: "not_a_posting" }, ctx.rid);
};

const searchCompanies = async (ctx: Ctx): Promise<Response> => {
  const q = (ctx.url.searchParams.get("q") || "").trim();
  if (!q) throw fieldError("q", "required");
  if (codePoints(q) > 200) throw fieldError("q", "must be at most 200 characters");
  const page = pageOf(ctx.url);
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await withPublicStatus(async (withStatus) => {
    const params: unknown[] = [like, page.limit + 1];
    const sql = `SELECT p.company AS name, count(*)::int AS open_posting_count
      FROM job_postings p WHERE ${openClause(withStatus)} AND p.company ILIKE $1 ESCAPE '\\'
      GROUP BY p.company
      ORDER BY open_posting_count DESC, p.company ASC
      LIMIT $2`;
    return query(ctx.deps.query, sql, params);
  });
  const mapped = rows.rows.map((row) => ({
    item: { name: String(row.name ?? ""), openPostingCount: Number(row.open_posting_count ?? 0) },
    createdAt: row.name,
    id: String(row.name ?? ""),
  }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: String(row.createdAt), id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
};

type LibrarySection<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };

const emptyLibrarySection = <T>(): LibrarySection<T> => ({ items: [], nextCursor: null, hasMore: false });

const libraryLimit = (url: URL): number => {
  const raw = url.searchParams.get("limit");
  if (!raw) return 50;
  if (!/^[1-9]\d*$/.test(raw)) throw fieldError("limit", "must be a positive integer");
  return Math.min(Number(raw), 100);
};

const libraryCursor = (url: URL, field: string): { createdAt: string; id: string } | null => {
  const encoded = url.searchParams.get(field);
  if (!encoded) return null;
  try {
    const cursor = decodeCursor(encoded);
    const id = parseUuid(cursor.id);
    if (!id) throw fieldError(field, "invalid cursor");
    return { createdAt: cursor.createdAt, id };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw fieldError(field, "invalid cursor");
  }
};

const botLibraryConversationDto = (row: Record<string, unknown>): Record<string, unknown> => ({
  ...convDto(row),
  status: String(row.status ?? "DONE"),
  lastMessagePreview: String(row.last_message_preview ?? ""),
});

const botLibraryLinkDto = (row: Record<string, unknown>): Record<string, unknown> => ({
  id: String(row.id),
  kind: String(row.kind ?? "other"),
  url: String(row.url ?? ""),
  title: String(row.title ?? ""),
  status: String(row.status ?? "READ"),
  fitCount: Number(row.fit_count ?? 0),
  aiRead: asBool(row.ai_read),
  createdAt: ts(row.created_at),
});

const CONV_STATUS_SQL = `CASE
    WHEN EXISTS (
      SELECT 1 FROM approvals a
      WHERE a.conversation_id = c.id AND a.status = 'PENDING'
        AND (a.expires_at IS NULL OR a.expires_at > now())
    ) THEN 'NEEDS_APPROVAL'
    WHEN EXISTS (
      SELECT 1 FROM chat_jobs j
      WHERE j.conversation_id = c.id AND j.status IN ('PENDING', 'RUNNING')
    ) THEN 'RUNNING'
    ELSE 'DONE'
  END AS status`;

const ATTACH_SOURCE_IDS = `SELECT (a->>'id')::uuid
  FROM conversations c
  JOIN messages m ON m.conversation_id = c.id
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(m.attachments) = 'array' THEN m.attachments ELSE '[]'::jsonb END
  ) a
  WHERE c.user_id = $1 AND c.bot_id = $2 AND NOT c.archived
    AND a->>'type' IN ('SOURCE', 'FILE')
    AND a->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

const ATTACH_DOCUMENT_IDS = `SELECT (a->>'documentId')::uuid
  FROM conversations c
  JOIN messages m ON m.conversation_id = c.id
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(m.attachments) = 'array' THEN m.attachments ELSE '[]'::jsonb END
  ) a
  WHERE c.user_id = $1 AND c.bot_id = $2 AND NOT c.archived
    AND a->>'documentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

const fetchBotLibraryConversations = async (ctx: Ctx, botId: string, limit: number): Promise<LibrarySection<Record<string, unknown>>> => {
  const cursor = libraryCursor(ctx.url, "conversationCursor");
  const params: unknown[] = [ctx.user.id, botId];
  let sql = `SELECT c.id, c.revision, c.application_id, c.title, c.pinned, c.created_at, c.updated_at,
    COALESCE((
      SELECT left(m.text, 140) FROM messages m
      WHERE m.conversation_id = c.id
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    ), '') AS last_message_preview,
    ${CONV_STATUS_SQL}
    FROM conversations c
    WHERE c.user_id = $1 AND c.bot_id = $2 AND NOT c.archived`;
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    sql += ` AND (c.updated_at, c.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit + 1);
  sql += ` ORDER BY c.updated_at DESC, c.id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: botLibraryConversationDto(row), createdAt: row.updated_at, id: String(row.id) }));
  const paged = pageResult(mapped, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return { items: paged.items.map((row) => row.item), nextCursor: paged.nextCursor, hasMore: paged.hasMore };
};

const fileListTail = (alias: "" | "d.", params: unknown[], cursor: { createdAt: string; id: string } | null, limit: number): string => {
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    params.push(limit + 1);
    return ` AND (${alias}created_at, ${alias}id) < ($${params.length - 2}, $${params.length - 1}) ORDER BY ${alias}created_at DESC, ${alias}id DESC LIMIT $${params.length}`;
  }
  params.push(limit + 1);
  return ` ORDER BY ${alias}created_at DESC, ${alias}id DESC LIMIT $${params.length}`;
};

const fetchBotLibraryFiles = async (ctx: Ctx, botId: string, limit: number): Promise<LibrarySection<DocumentsLibraryRow>> => {
  const cursor = libraryCursor(ctx.url, "fileCursor");
  const uploadParams: unknown[] = [ctx.user.id, botId];
  const docParams: unknown[] = [ctx.user.id, botId];
  const uploadSql = `SELECT id, file_name, mime_type, size, page_count, origin, created_at, to_jsonb(sources)->>'doc_kind' AS doc_kind
    FROM sources
    WHERE user_id = $1
    AND id IN (${ATTACH_SOURCE_IDS})${fileListTail("", uploadParams, cursor, limit)}`;
  const docSql = `SELECT d.id, d.title, d.created_at, to_jsonb(d)->>'kind' AS kind, a.company, a.title AS posting_title
    FROM documents d
    LEFT JOIN applications a ON a.id = d.application_id
    WHERE d.user_id = $1 AND d.status <> 'ARCHIVED'
    AND (
      d.application_id IN (
        SELECT c.application_id FROM conversations c
        WHERE c.user_id = $1 AND c.bot_id = $2 AND NOT c.archived AND c.application_id IS NOT NULL
      )
      OR d.id IN (${ATTACH_DOCUMENT_IDS})
    )${fileListTail("d.", docParams, cursor, limit)}`;
  const [uploads, documents] = await Promise.all([
    query(ctx.deps.query, uploadSql, uploadParams),
    query(ctx.deps.query, docSql, docParams),
  ]);
  const sourceRows = uploads.rows.filter((row) => {
    const name = String(row.file_name ?? "");
    const mime = String(row.mime_type ?? "");
    return !name.toLowerCase().endsWith(".md") && mime.toLowerCase() !== "text/markdown";
  });
  const items: DocumentsLibraryRow[] = [
    ...sourceRows.map(sourceItem),
    ...documents.rows.map(documentLibraryItem),
  ].sort(libraryItemsNewerFirst);
  const hasMore = items.length > limit;
  const slice = items.slice(0, limit);
  const last = slice[slice.length - 1];
  const nextCursor = hasMore && last?.createdAt ? encodeCursor(last.createdAt, last.id) : null;
  return { items: slice, nextCursor, hasMore };
};

const fetchBotLibraryLinks = async (ctx: Ctx, botId: string, limit: number): Promise<LibrarySection<Record<string, unknown>>> => {
  const cursor = libraryCursor(ctx.url, "linkCursor");
  const params: unknown[] = [ctx.user.id, botId];
  let sql = `SELECT ul.id, ul.kind, ul.url, ul.title, ul.status, ul.fit_count, ul.ai_read, ul.created_at
    FROM user_links ul
    WHERE ul.user_id = $1 AND ul.deleted_at IS NULL AND ul.url <> ''
    AND (
      ul.url = (SELECT b.posting_url FROM bots b WHERE b.id = $2 AND b.user_id = $1 AND b.deleted_at IS NULL)
      OR EXISTS (
        SELECT 1 FROM conversations c
        JOIN messages m ON m.conversation_id = c.id
        WHERE c.user_id = ul.user_id AND c.bot_id = $2 AND NOT c.archived
          AND strpos(m.text, ul.url) > 0
      )
    )`;
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    sql += ` AND (ul.created_at, ul.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit + 1);
  sql += ` ORDER BY ul.created_at DESC, ul.id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: botLibraryLinkDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return { items: paged.items.map((row) => row.item), nextCursor: paged.nextCursor, hasMore: paged.hasMore };
};

const listBotLibrary = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  if (id === await pushBotId(ctx.user.id)) await ensurePushBot(ctx);
  await assertOwnedBot(ctx, id);
  const limit = libraryLimit(ctx.url);
  const sectionRaw = ctx.url.searchParams.get("section");
  if (sectionRaw && sectionRaw !== "conversations" && sectionRaw !== "files" && sectionRaw !== "links") {
    throw fieldError("section", "must be conversations, files, or links");
  }
  const wantConversations = !sectionRaw || sectionRaw === "conversations";
  const wantFiles = !sectionRaw || sectionRaw === "files";
  const wantLinks = !sectionRaw || sectionRaw === "links";
  const [conversations, files, links] = await Promise.all([
    wantConversations ? fetchBotLibraryConversations(ctx, id, limit) : emptyLibrarySection(),
    wantFiles ? fetchBotLibraryFiles(ctx, id, limit) : emptyLibrarySection(),
    wantLinks ? fetchBotLibraryLinks(ctx, id, limit) : emptyLibrarySection(),
  ]);
  return data(200, { conversations, files, links }, ctx.rid);
};

const markBotRead = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const botId = requireUuid(idRaw, "id");
  await assertOwnedBot(ctx, botId);
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    `INSERT INTO bot_read_markers (user_id, bot_id, read_at) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, bot_id) DO UPDATE SET read_at = EXCLUDED.read_at`,
    [ctx.user.id, botId, now]);
  return data(200, { readAt: now }, ctx.rid);
};

export const dispatchBots = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (method === "GET" && path === "/api/v1/bots") return listBots(ctx);
  if (method === "POST" && path === "/api/v1/bots") return createBot(ctx);
  if (method === "POST" && path === "/api/v1/bots/link-preview") return linkPreview(ctx);
  if (method === "GET" && path === "/api/v1/bots/companies/search") return searchCompanies(ctx);
  const oneBot = path.match(/^\/api\/v1\/bots\/([^/]+)$/);
  if (method === "GET" && oneBot) return getBot(ctx, oneBot[1]);
  if (method === "PATCH" && oneBot) return patchBot(ctx, oneBot[1]);
  if (method === "DELETE" && oneBot) return deleteBot(ctx, oneBot[1]);
  const convs = path.match(/^\/api\/v1\/bots\/([^/]+)\/conversations$/);
  if (method === "GET" && convs) return listBotConversations(ctx, convs[1]);
  if (method === "POST" && convs) return createBotConversation(ctx, convs[1]);
  const library = path.match(/^\/api\/v1\/bots\/([^/]+)\/library$/);
  if (method === "GET" && library) return listBotLibrary(ctx, library[1]);
  const read = path.match(/^\/api\/v1\/bots\/([^/]+)\/read$/);
  if (method === "POST" && read) return markBotRead(ctx, read[1]);
  return null;
};
