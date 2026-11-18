import { one, query } from "../db.ts";
import { HttpError, data, fieldError, requireUuid, uuid5Url } from "../http.ts";
import { ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import { resolveBot } from "./bots.ts";
import {
  CANONICAL_ACCESS, PERSONAL_INTENTS, SAVED_ACCESS_MODE, aiDto, allowChat, effortFor, enqueueChatMessage, forbidExtra,
  requireAgentConsent, resolveApproval,
} from "./conversations.ts";
import { readObject, textOf } from "./recruiting-shared.ts";

const MATERIAL_KINDS = ["file", "document", "posting", "link"] as const;
type MaterialKind = (typeof MATERIAL_KINDS)[number];

/** What the client sends. A message stores it with the material's title at send time. */
type AttachmentRef = { kind: MaterialKind; id: string };
type Material = AttachmentRef & { title: string; url?: string };

/** Per kind, the rows among $1 the caller may attach, as (id, title). An owned kind takes the caller as $2. */
const MATERIALS: Record<MaterialKind, { sql: string; owned: boolean }> = {
  file: { owned: true, sql: "SELECT id, file_name AS title FROM sources WHERE id = ANY($1::uuid[]) AND user_id = $2" },
  document: { owned: true, sql: "SELECT id, title FROM documents WHERE id = ANY($1::uuid[]) AND user_id = $2 AND status <> 'ARCHIVED'" },
  posting: { owned: false, sql: "SELECT id, company || ' · ' || title AS title FROM job_postings WHERE id = ANY($1::uuid[]) AND status <> 'DRAFT'" },
  link: { owned: true, sql: "SELECT id, COALESCE(NULLIF(title, ''), url) AS title, url FROM user_links WHERE id = ANY($1::uuid[]) AND user_id = $2 AND deleted_at IS NULL" },
};

const ACCESS_MODES = ["ALWAYS_ASK", "AUTO", "BYPASS"];
const MAX_ATTACHMENTS = 10;
const MAX_MATCHES = 200;
const FOREIGN_KEY_VIOLATION = "23503";

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");

const keyOf = (ref: AttachmentRef): string => `${ref.kind}:${ref.id}`;

const attachmentRefs = (raw: unknown): AttachmentRef[] => {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) throw fieldError("attachments", `must be a list of at most ${MAX_ATTACHMENTS}`);
  const refs = raw.map((item): AttachmentRef => {
    const ref = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const kind = MATERIAL_KINDS.find((name) => name === ref.kind);
    if (!kind || Object.keys(ref).some((key) => key !== "kind" && key !== "id")) throw fieldError("attachments", "each item is { kind, id }");
    return { kind, id: requireUuid(String(ref.id ?? ""), "attachments") };
  });
  return [...new Map(refs.map((ref) => [keyOf(ref), ref])).values()];
};

const resolveAttachments = async (ctx: Ctx, refs: AttachmentRef[]): Promise<Material[]> => {
  const found = new Map<string, Record<string, unknown>>();
  await Promise.all(MATERIAL_KINDS.map(async (kind) => {
    const ids = refs.filter((ref) => ref.kind === kind).map((ref) => ref.id);
    if (ids.length === 0) return;
    const { sql, owned } = MATERIALS[kind];
    const rows = await query(ctx.deps.query, sql, owned ? [ids, ctx.user.id] : [ids]);
    for (const row of rows.rows) found.set(keyOf({ kind, id: String(row.id) }), row);
  }));
  return refs.map((ref) => {
    const row = found.get(keyOf(ref));
    if (!row) throw new HttpError(409, "ATTACHMENT_GONE", "an attached material is gone", { kind: ref.kind, id: ref.id });
    return { ...ref, title: String(row.title ?? ""), ...(row.url == null ? {} : { url: String(row.url) }) };
  });
};

/** Attachments as the job context the AI service reads. A run takes one document and one posting, so the first of each. */
const contextOf = (materials: Material[]): Record<string, unknown> => {
  const ids = (kind: MaterialKind): string[] => materials.filter((material) => material.kind === kind).map((material) => material.id);
  return {
    documentId: ids("document")[0] ?? null,
    versionId: null,
    evidenceIds: ids("file"),
    postingId: ids("posting")[0] ?? null,
    urls: materials.flatMap((material) => (material.url ? [material.url] : [])),
  };
};

const threadOf = async (ctx: Ctx, botId: string): Promise<string | null> => {
  const row = await one(ctx.deps.query, "SELECT id FROM conversations WHERE bot_id = $1 AND user_id = $2", [botId, ctx.user.id]);
  return row ? String(row.id) : null;
};

// The unique index on bot_id (migration 0053) makes two first sends meet on one row.
// The title is the bot's name, so the AI service never renames the thread from a placeholder.
const ensureThread = async (ctx: Ctx, botId: string): Promise<string> => {
  await query(ctx.deps.query,
    `INSERT INTO conversations (id, user_id, revision, title, pinned, archived, created_at, updated_at, bot_id, posting_id)
     SELECT $1, b.user_id, 1, b.display_name, false, false, $2, $2, b.id, b.posting_id FROM bots b WHERE b.id = $3 AND b.user_id = $4
     ON CONFLICT (bot_id) WHERE bot_id IS NOT NULL DO NOTHING`,
    [crypto.randomUUID(), ctx.now.toISOString(), botId, ctx.user.id]);
  const thread = await threadOf(ctx, botId);
  if (!thread) throw notFound();
  return thread;
};

const accessModeOf = async (ctx: Ctx, raw: unknown): Promise<string> => {
  if (raw != null) {
    if (typeof raw !== "string" || !ACCESS_MODES.includes(raw)) throw fieldError("accessMode", `must be one of ${ACCESS_MODES.join(", ")}`);
    return raw;
  }
  const saved = await one(ctx.deps.query, SAVED_ACCESS_MODE, [ctx.user.id]);
  return CANONICAL_ACCESS[String(saved?.ai_access_mode ?? "")] ?? "AUTO";
};

const postBotMessage = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const bot = await resolveBot(ctx, idRaw);
  await requireAgentConsent(ctx);
  const body = await readObject(ctx.request);
  forbidExtra(body, ["text", "attachments", "intent", "accessMode", "ai"]);
  const text = textOf(body.text, "text", 1, 20000);
  const refs = attachmentRefs(body.attachments);
  if (body.intent != null && (typeof body.intent !== "string" || !PERSONAL_INTENTS.has(body.intent))) {
    throw fieldError("intent", "unsupported intent");
  }
  const ai = aiDto(body.ai);
  const accessMode = await accessModeOf(ctx, body.accessMode);
  const materials = await resolveAttachments(ctx, refs);
  await allowChat(ctx, ai);
  if (ai) ai.effort = effortFor("PERSONAL", ctx.user.plan);
  const payload = {
    text, context: contextOf(materials), ai, accessMode, access_mode: accessMode, intent: body.intent ?? null, applicationId: null,
  };
  try {
    const thread = await ensureThread(ctx, String(bot.id));
    return await enqueueChatMessage(ctx, thread, payload, text, materials.map(({ kind, id, title }) => ({ kind, id, title })));
  } catch (err) {
    // The bot was deleted while this send was under way. Its thread took every row of the send with it.
    if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) throw notFound();
    throw err;
  }
};

const answerBotCard = async (ctx: Ctx, idRaw: string, approvalRaw: string): Promise<Response> => {
  const bot = await resolveBot(ctx, idRaw);
  await requireAgentConsent(ctx);
  const thread = await threadOf(ctx, String(bot.id));
  if (!thread) throw notFound();
  const answer = await resolveApproval(ctx, thread, approvalRaw);
  const { jobId: _job, ...card } = (await answer.json() as { data: Record<string, unknown> }).data;
  return data(answer.status, card, ctx.rid);
};

// A message's id is a hash of its job's id and cannot be read back, so each job's two ids are computed until every match has its turn.
// shortcut: walks the thread's jobs newest first, store the job id on the message when a thread reaches tens of thousands of turns.
const turnsOf = async (ctx: Ctx, thread: string, messages: Record<string, unknown>[]): Promise<Map<string, string>> => {
  const wanted = new Set(messages.map((message) => String(message.id)));
  const turns = new Map<string, string>();
  if (wanted.size === 0) return turns;
  const jobs = await query(ctx.deps.query,
    "SELECT id FROM ai_jobs WHERE conversation_id = $1 AND type = 'chat' AND created_at <= $2 ORDER BY created_at DESC",
    [thread, messages[0].created_at]);
  for (const job of jobs.rows) {
    if (turns.size === wanted.size) break;
    for (const role of ["user", "assistant"]) {
      const messageId = await uuid5Url(`push:chat:${job.id}:${role}`);
      if (wanted.has(messageId)) turns.set(messageId, String(job.id));
    }
  }
  return turns;
};

const findInChat = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const bot = await resolveBot(ctx, idRaw);
  const q = textOf(ctx.url.searchParams.get("q") ?? "", "q", 1, 200);
  const thread = await threadOf(ctx, String(bot.id));
  if (!thread) return data(200, { total: 0, items: [] }, ctx.rid);
  const matches = await query(ctx.deps.query,
    `SELECT m.id, m.created_at, count(*) OVER () AS total FROM messages m
     WHERE m.conversation_id = $1 AND strpos(lower(m.text), lower($2)) > 0
     ORDER BY m.created_at DESC, m.id DESC LIMIT ${MAX_MATCHES}`,
    [thread, q]);
  const turns = await turnsOf(ctx, thread, matches.rows);
  const items = matches.rows.flatMap((message) => {
    const turnId = turns.get(String(message.id));
    return turnId ? [{ messageId: String(message.id), turnId, at: ts(message.created_at) }] : [];
  });
  // A message whose job is gone has no turn to open, so it is not a match.
  const total = Number(matches.rows[0]?.total ?? 0) - (matches.rows.length - items.length);
  return data(200, { total, items }, ctx.rid);
};

export const dispatchBotChat = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  const send = path.match(/^\/api\/v1\/bots\/([^/]+)\/messages\/stream$/);
  if (method === "POST" && send) return postBotMessage(ctx, send[1]);
  const card = path.match(/^\/api\/v1\/bots\/([^/]+)\/approvals\/([^/]+)$/);
  if (method === "POST" && card) return answerBotCard(ctx, card[1], card[2]);
  const matches = path.match(/^\/api\/v1\/bots\/([^/]+)\/transcript\/matches$/);
  if (method === "GET" && matches) return findInChat(ctx, matches[1]);
  return null;
};
