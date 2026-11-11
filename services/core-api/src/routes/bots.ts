import { one, query } from "../db.ts";
import { HttpError, asBool, codePoints, data, fieldError, noContent, pageBody, requireUuid, uuid5Url } from "../http.ts";
import { pageOf, pageResult, revisionUpdate, ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import { openClause, readObject, rejectFields, textOf, httpsUrl, withPublicStatus } from "./recruiting-shared.ts";
import { requireAgentConsent, convDto } from "./conversations.ts";

const COMPANY_LIMIT: Record<string, number | null> = { FREE: 3, PRO: 20, ULTRA: null };
const PUSH_LABEL = "Push Bot";
const IMAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const pushBotId = (userId: string): Promise<string> => uuid5Url(`push:bot:${userId}`);

const planTier = (plan: unknown): string => {
  const tier = plan == null ? "" : String(plan).trim().toUpperCase();
  return tier || "FREE";
};

const companyBotLimit = (plan: unknown): number | null => COMPANY_LIMIT[planTier(plan)] ?? COMPANY_LIMIT.FREE;

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

const assertCompanyBotLimit = async (ctx: Ctx): Promise<void> => {
  const limit = companyBotLimit(ctx.user.plan);
  if (limit == null) return;
  const row = await one(ctx.deps.query,
    "SELECT count(*)::int AS n FROM bots WHERE user_id = $1 AND kind = 'company' AND deleted_at IS NULL",
    [ctx.user.id]);
  if (Number(row?.n ?? 0) >= limit) {
    throw new HttpError(403, "BOT_LIMIT", "company bot limit reached for your plan", { limit, plan: planTier(ctx.user.plan) });
  }
};

const resolveCompanyName = async (ctx: Ctx, companyId: string | null, companyName: string): Promise<{ companyId: string | null; companyName: string }> => {
  if (companyId) {
    const company = await one(ctx.deps.query, "SELECT id, name FROM companies WHERE id = $1", [companyId]);
    if (!company) throw new HttpError(404, "NOT_FOUND", "resource not found");
    return { companyId, companyName: String(company.name ?? companyName) };
  }
  if (!companyName.trim()) throw fieldError("companyName", "required when companyId is omitted");
  return { companyId: null, companyName: companyName.trim() };
};

const createBot = async (ctx: Ctx): Promise<Response> => {
  await ensurePushBot(ctx);
  const body = await readObject(ctx.request);
  rejectFields(body, ["id", "kind", "revision", "createdAt", "updatedAt"]);
  await assertCompanyBotLimit(ctx);
  const companyId = body.companyId == null ? null : requireUuid(String(body.companyId), "companyId");
  const companyName = body.companyName == null ? "" : textOf(body.companyName, "companyName", 0, 200);
  const resolved = await resolveCompanyName(ctx, companyId, companyName);
  let postingId: string | null = null;
  if (body.postingId != null) {
    postingId = requireUuid(String(body.postingId), "postingId");
    const posting = await one(ctx.deps.query, "SELECT id, company, title FROM job_postings WHERE id = $1", [postingId]);
    if (!posting) throw new HttpError(404, "NOT_FOUND", "resource not found");
    if (!resolved.companyName) resolved.companyName = String(posting.company ?? "");
  }
  let postingUrl: string | null = null;
  if (body.postingUrl != null) {
    postingUrl = textOf(body.postingUrl, "postingUrl", 1, 2000);
    if (!httpsUrl(postingUrl)) throw fieldError("postingUrl", "must be an http(s) URL without credentials");
  }
  let displayName = body.displayName == null ? "" : textOf(body.displayName, "displayName", 1, 120);
  if (!displayName) {
    displayName = postingId
      ? resolved.companyName
      : resolved.companyName || "Company bot";
  }
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    `INSERT INTO bots (id, user_id, kind, company_id, company_name, posting_id, posting_url, display_name, created_at, updated_at)
     VALUES ($1,$2,'company',$3,$4,$5,$6,$7,$8,$8)`,
    [id, ctx.user.id, resolved.companyId, resolved.companyName, postingId, postingUrl, displayName, now]);
  return data(201, botDto({
    id, kind: "company", company_id: resolved.companyId, company_name: resolved.companyName,
    posting_id: postingId, posting_url: postingUrl, display_name: displayName,
    avatar_key: null, mascot_key: null, notifications_muted: false, revision: 1,
    created_at: now, updated_at: now, last_message_preview: "", unread: false, status: "DONE",
  }), ctx.rid);
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
     RETURNING ${BOT_COLS}`,
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
  const read = path.match(/^\/api\/v1\/bots\/([^/]+)\/read$/);
  if (method === "POST" && read) return markBotRead(ctx, read[1]);
  return null;
};
