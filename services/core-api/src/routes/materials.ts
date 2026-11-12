import { one, query } from "../db.ts";
import { HttpError, asBool, data, fieldError, noContent, requireUuid } from "../http.ts";
import { enqueueIngest } from "../jobs/ingest.ts";
import { pageOf, ts } from "../page.ts";
import { encodeCursor } from "../time.ts";
import type { Ctx } from "../types.ts";
import { botRef, resolveBot } from "./bots.ts";

const KIND_NAMES = ["file", "document", "posting", "link"] as const;
type Kind = (typeof KIND_NAMES)[number];
const SECTION_NAMES = ["doc", "bookmark", "link"] as const;
type Section = (typeof SECTION_NAMES)[number];
type Row = Record<string, unknown>;

/** Rows per section on the 전체 tab, as the Materials board previews them. */
const PREVIEW: Record<Section, number> = { doc: 4, bookmark: 3, link: 3 };
const LIMIT_DEFAULT = 20;
const Q_MAX = 200;

/**
 * A kind of material. In every fragment `x` is the kind's row, $1 the caller, $2 the search text or
 * null, $3 a bot of the caller or null. `live` is the caller's rows the app lists. A deleted material
 * is kept 30 days in its kind's own deleted state, which the retention purge erases: an archived
 * document, a soft-deleted link, and a file or bookmark moved into material_bin.
 */
type KindRule = {
  section: Section;
  from: string;
  live: string;
  /** The sort key, newest first: the time the material was saved, or a document's last edit. */
  at: string;
  search: string[];
  /** The bot that made it. Bookmarks and links are the user's own. */
  maker: string | null;
  cols: string;
  dto: (row: Row) => Row;
  /** Puts a live material into its deleted state. False when the caller has no such live material. */
  remove: (ctx: Ctx, id: string) => Promise<boolean>;
  /** Brings a deleted material back. A material that is live already stays as it is. */
  restore: (ctx: Ctx, id: string) => Promise<void>;
};

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");

const textOrNull = (value: unknown): string | null => (value == null ? null : String(value));
const numberOrNull = (value: unknown): number | null => (value == null ? null : Number(value));
const makerOf = (row: Row): Row | null => (row.bot_id == null ? null : botRef(row));

// The host lets the app mark a LinkedIn link. LinkedIn is not one of the five kinds a link is saved with.
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

const changed = async (ctx: Ctx, sql: string, params: unknown[]): Promise<boolean> =>
  (await query(ctx.deps.query, sql, params)).rows.length > 0;

const FILE_LIVE = "x.user_id = $1 AND lower(x.file_name) NOT LIKE '%.md' AND lower(x.mime_type) <> 'text/markdown'";

// Evidence that cites the file keeps it, as DELETE /sources does. The profile's pin goes with the
// row (ON DELETE SET NULL), so the snapshot remembers it for the restore.
const BIN_FILE = `WITH src AS (SELECT x.* FROM sources x WHERE ${FILE_LIVE} AND x.id = $2),
  used AS (SELECT count(*)::int AS n FROM career_evidence WHERE user_id = $1 AND provenance->>'sourceId' = $2::uuid::text),
  binned AS (
    INSERT INTO material_bin (user_id, kind, id, deleted_at, snapshot)
    SELECT src.user_id, 'file', src.id, $3::timestamptz, to_jsonb(src) || jsonb_build_object('resume_pinned',
      EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = src.user_id AND p.resume_source_id = src.id))
    FROM src, used WHERE used.n = 0
    ON CONFLICT (user_id, kind, id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at, snapshot = EXCLUDED.snapshot
    RETURNING id),
  gone AS (DELETE FROM sources s USING binned WHERE s.id = binned.id RETURNING s.id)
  SELECT (SELECT count(*) FROM src)::int AS found, (SELECT n FROM used) AS used, (SELECT count(*) FROM gone)::int AS deleted`;

const UNBIN_FILE = `WITH back AS (DELETE FROM material_bin WHERE user_id = $1 AND kind = 'file' AND id = $2 RETURNING snapshot),
  put AS (
    INSERT INTO sources SELECT (jsonb_populate_record(NULL::sources, back.snapshot || jsonb_build_object('created_by_bot_id', b.id))).*
    FROM back LEFT JOIN bots b ON b.id = (back.snapshot->>'created_by_bot_id')::uuid
    RETURNING id),
  pinned AS (UPDATE profiles p SET resume_source_id = put.id FROM put, back
    WHERE p.user_id = $1 AND p.resume_source_id IS NULL AND (back.snapshot->>'resume_pinned')::boolean)
  SELECT id FROM put`;

const POSTING_LIVE = "k.user_id = $1 AND x.status <> 'DRAFT'";

const BIN_BOOKMARK = `WITH gone AS (
    DELETE FROM bookmarks k USING job_postings x WHERE x.id = k.posting_id AND ${POSTING_LIVE} AND k.posting_id = $2 RETURNING k.*)
  INSERT INTO material_bin (user_id, kind, id, deleted_at, snapshot)
  SELECT gone.user_id, 'posting', gone.posting_id, $3::timestamptz, to_jsonb(gone) FROM gone
  ON CONFLICT (user_id, kind, id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at, snapshot = EXCLUDED.snapshot
  RETURNING id`;

const UNBIN_BOOKMARK = `WITH back AS (DELETE FROM material_bin WHERE user_id = $1 AND kind = 'posting' AND id = $2 RETURNING snapshot)
  INSERT INTO bookmarks SELECT (jsonb_populate_record(NULL::bookmarks, back.snapshot)).*
  FROM back JOIN job_postings x ON x.id = $2
  ON CONFLICT (user_id, posting_id) DO NOTHING`;

const KINDS: Record<Kind, KindRule> = {
  file: {
    section: "doc",
    from: "sources x",
    // Markdown files are the resume flow's working notes, kept off every list the user sees.
    live: FILE_LIVE,
    at: "x.created_at",
    search: ["x.file_name"],
    maker: "x.created_by_bot_id",
    cols: "x.file_name AS title, x.mime_type, x.size, x.page_count, x.origin",
    dto: (row) => ({
      kind: "file", id: String(row.id), title: String(row.title), mimeType: String(row.mime_type), size: Number(row.size),
      pageCount: numberOrNull(row.page_count), origin: String(row.origin), createdBy: makerOf(row), updatedAt: ts(row.at),
    }),
    remove: async (ctx, id) => {
      const row = await one(ctx.deps.query, BIN_FILE, [ctx.user.id, id, ctx.now.toISOString()]);
      if (!Number(row?.found)) return false;
      if (Number(row?.used) > 0) {
        throw new HttpError(409, "INVALID_TRANSITION", "source is referenced by evidence", {
          reason: "REFERENCED_BY_EVIDENCE", evidenceCount: Number(row?.used),
        });
      }
      return Number(row?.deleted) > 0;
    },
    // Its search nodes went with the row, so the file is read again.
    restore: async (ctx, id) => {
      if (await changed(ctx, UNBIN_FILE, [ctx.user.id, id])) await enqueueIngest(ctx, { sourceId: id });
    },
  },
  document: {
    section: "doc",
    from: "documents x LEFT JOIN applications a ON a.id = x.application_id",
    live: "x.user_id = $1 AND x.status <> 'ARCHIVED'",
    at: "x.updated_at",
    search: ["x.title", "a.company"],
    maker: "x.created_by_bot_id",
    cols: "x.title, x.kind AS doc_kind",
    dto: (row) => ({
      kind: "document", id: String(row.id), title: String(row.title), docKind: String(row.doc_kind ?? ""), origin: "AI",
      createdBy: makerOf(row), updatedAt: ts(row.at),
    }),
    remove: (ctx, id) => changed(ctx,
      "UPDATE documents x SET revision = revision + 1, status = 'ARCHIVED', updated_at = $3 WHERE x.user_id = $1 AND x.status <> 'ARCHIVED' AND x.id = $2 RETURNING x.id",
      [ctx.user.id, id, ctx.now.toISOString()]),
    // As POST /documents/{id}/restore, without its revision check. Archiving dropped its search nodes.
    restore: async (ctx, id) => {
      const restored = await changed(ctx,
        `UPDATE documents SET revision = revision + 1,
           status = CASE WHEN finalized_version_id IS NOT NULL THEN 'FINALIZED' ELSE 'DRAFT' END, updated_at = $3
         WHERE user_id = $1 AND id = $2 AND status = 'ARCHIVED' RETURNING id`,
        [ctx.user.id, id, ctx.now.toISOString()]);
      if (restored) await enqueueIngest(ctx, { documentId: id });
    },
  },
  posting: {
    section: "bookmark",
    from: "bookmarks k JOIN job_postings x ON x.id = k.posting_id",
    live: POSTING_LIVE,
    at: "k.created_at",
    search: ["x.company", "x.title"],
    maker: null,
    cols: `x.title, x.company, x.deadline::text AS deadline, NOT (x.status = 'OPEN' AND x.closed_at IS NULL) AS closed,
      x.career_min, x.career_max, x.employment_type, x.location`,
    dto: (row) => ({
      kind: "posting", id: String(row.id), title: String(row.title), company: String(row.company), deadline: textOrNull(row.deadline),
      closed: asBool(row.closed), careerMin: numberOrNull(row.career_min), careerMax: numberOrNull(row.career_max),
      employmentType: textOrNull(row.employment_type), location: textOrNull(row.location), bookmarkedAt: ts(row.at),
    }),
    remove: (ctx, id) => changed(ctx, BIN_BOOKMARK, [ctx.user.id, id, ctx.now.toISOString()]),
    restore: async (ctx, id) => {
      await query(ctx.deps.query, UNBIN_BOOKMARK, [ctx.user.id, id]);
    },
  },
  link: {
    section: "link",
    from: "user_links x",
    live: "x.user_id = $1 AND x.deleted_at IS NULL",
    at: "x.created_at",
    search: ["x.title", "x.url"],
    maker: null,
    cols: "COALESCE(NULLIF(x.title, ''), x.url) AS title, x.url, x.kind AS link_kind, x.last_checked_at, x.last_check_ok",
    dto: (row) => ({
      kind: "link", id: String(row.id), title: String(row.title), url: String(row.url), host: hostOf(String(row.url)),
      linkKind: String(row.link_kind), addedAt: ts(row.at), lastCheckedAt: ts(row.last_checked_at),
      lastCheckOk: row.last_check_ok == null ? null : asBool(row.last_check_ok),
    }),
    remove: (ctx, id) => changed(ctx,
      "UPDATE user_links x SET deleted_at = $3 WHERE x.user_id = $1 AND x.deleted_at IS NULL AND x.id = $2 RETURNING x.id",
      [ctx.user.id, id, ctx.now.toISOString()]),
    restore: async (ctx, id) => {
      await query(ctx.deps.query,
        "UPDATE user_links SET deleted_at = NULL WHERE user_id = $1 AND id = $2 AND deleted_at IS NOT NULL", [ctx.user.id, id]);
    },
  },
};

const kindsOf = (section: Section): Kind[] => KIND_NAMES.filter((kind) => KINDS[kind].section === section);

// What bot $3's chat attached, read once per statement. A probe per material walked the whole thread
// for each one: 0.4 s for 300 materials and a 2,000-message thread.
const ATTACHED = `WITH attached AS MATERIALIZED (
    SELECT a->>'kind' AS kind, a->>'id' AS id
    FROM conversations c JOIN messages m ON m.conversation_id = c.id
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.attachments) = 'array' THEN m.attachments END) a
    WHERE c.bot_id = $3 AND m.attachments <> '[]'::jsonb)`;

/** The caller's live materials of a kind that match the search and belong to the bot: made by it or attached in its chat. */
const matching = (kind: Kind): string => {
  const rule = KINDS[kind];
  const found = rule.search.map((col) => `strpos(lower(${col}), lower($2)) > 0`).join(" OR ");
  const attached = `x.id::text IN (SELECT id FROM attached WHERE kind = '${kind}')`;
  const ofBot = rule.maker ? `${rule.maker} = $3 OR ${attached}` : attached;
  return `${rule.live} AND ($2::text IS NULL OR ${found}) AND ($3::uuid IS NULL OR ${ofBot})`;
};

const COUNTS = `${ATTACHED} SELECT ${SECTION_NAMES.map((section) =>
  `(${kindsOf(section).map((kind) => `(SELECT count(*) FROM ${KINDS[kind].from} WHERE ${matching(kind)})`).join(" + ")})::int AS ${section}`).join(", ")}`;

// $4 and $5 are the cursor, $6 the row count.
const PAGE: Record<Section, string> = Object.fromEntries(SECTION_NAMES.map((section) => [section,
  `${ATTACHED} SELECT kind, id, at FROM (${kindsOf(section).map((kind) =>
    `SELECT '${kind}' AS kind, x.id, ${KINDS[kind].at} AS at FROM ${KINDS[kind].from} WHERE ${matching(kind)}`).join(" UNION ALL ")}) m
   WHERE $4::timestamptz IS NULL OR (m.at, m.id) < ($4::timestamptz, $5::uuid)
   ORDER BY m.at DESC, m.id DESC LIMIT $6`])) as Record<Section, string>;

const ROWS: Record<Kind, string> = Object.fromEntries(KIND_NAMES.map((kind) => {
  const { from, live, at, cols, maker } = KINDS[kind];
  const madeBy = maker ? `, cb.id AS bot_id, cb.kind, cb.display_name, cb.color FROM ${from} LEFT JOIN bots cb ON cb.id = ${maker} AND cb.deleted_at IS NULL` : ` FROM ${from}`;
  return [kind, `SELECT x.id, ${at} AS at, ${cols}${madeBy} WHERE ${live} AND x.id = ANY($2::uuid[])`];
})) as Record<Kind, string>;

// The containment goes first, through the GIN index. Left to the planner, it walked every thread of the
// caller instead: 19 ms against 0.4 ms for 31 bots of 2,000 messages.
const USED_BY = `WITH hits AS MATERIALIZED (
    SELECT m.conversation_id, m.created_at FROM messages m
    WHERE m.attachments @> jsonb_build_array(jsonb_build_object('kind', $2::text, 'id', $3::text)) AND m.user_id = $1)
  SELECT b.id AS bot_id, b.kind, b.display_name, b.color
  FROM hits h JOIN conversations c ON c.id = h.conversation_id JOIN bots b ON b.id = c.bot_id
  WHERE b.user_id = $1 AND b.deleted_at IS NULL
  GROUP BY b.id, b.kind, b.display_name, b.color
  ORDER BY max(h.created_at) DESC, b.id`;

/** The caller's live materials of one kind, as DTOs in the order of `ids`. One that is gone is left out. */
const materialsOf = async (ctx: Ctx, kind: Kind, ids: string[]): Promise<Row[]> => {
  if (ids.length === 0) return [];
  const rows = await query(ctx.deps.query, ROWS[kind], [ctx.user.id, ids]);
  const byId = new Map<string, Row>(rows.rows.map((row) => [String(row.id), KINDS[kind].dto(row)]));
  return ids.map((id) => byId.get(id)).filter((row): row is Row => row !== undefined);
};

type Filter = [userId: string, q: string | null, botId: string | null];

const countsOf = async (ctx: Ctx, filter: Filter): Promise<Record<Section, number>> => {
  const row = await one(ctx.deps.query, COUNTS, filter);
  return Object.fromEntries(SECTION_NAMES.map((section) => [section, Number(row?.[section] ?? 0)])) as Record<Section, number>;
};

/** Materials made by the bot or attached in its chat. The profile's number equals the count of its materials list. */
export const materialCountOf = async (ctx: Ctx, botId: string): Promise<number> => {
  const counts = await countsOf(ctx, [ctx.user.id, null, botId]);
  return counts.doc + counts.bookmark + counts.link;
};

type Cursor = { createdAt: string; id: string } | null;

/** Up to `limit` materials of a section after the cursor, newest first, and the cursor of the next page. */
const sectionPage = async (ctx: Ctx, section: Section, filter: Filter, cursor: Cursor, limit: number) => {
  const keys = (await query(ctx.deps.query, PAGE[section], [...filter, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1])).rows;
  const shown = keys.slice(0, limit);
  const loaded = await Promise.all(kindsOf(section).map((kind) =>
    materialsOf(ctx, kind, shown.filter((key) => key.kind === kind).map((key) => String(key.id)))));
  const byKey = new Map(loaded.flat().map((material) => [`${material.kind}:${material.id}`, material]));
  const last = shown[shown.length - 1];
  return {
    items: shown.flatMap((key) => byKey.get(`${key.kind}:${key.id}`) ?? []),
    nextCursor: keys.length > limit && last ? encodeCursor(last.at, String(last.id)) : null,
  };
};

const listMaterials = async (ctx: Ctx): Promise<Response> => {
  const params = ctx.url.searchParams;
  const tab = params.get("tab") ?? "all";
  const sections = tab === "all" ? [...SECTION_NAMES] : SECTION_NAMES.filter((name) => name === tab);
  if (sections.length === 0) throw fieldError("tab", `must be all or one of ${SECTION_NAMES.join(", ")}`);
  const q = (params.get("q") ?? "").trim();
  if ([...q].length > Q_MAX) throw fieldError("q", `must be at most ${Q_MAX} characters`);
  const page = pageOf(ctx.url);
  const botRaw = params.get("bot");
  const botId = botRaw == null ? null : String((await resolveBot(ctx, botRaw)).id);
  const filter: Filter = [ctx.user.id, q || null, botId];
  const limit = params.has("limit") ? page.limit : LIMIT_DEFAULT;
  const [counts, ...pages] = await Promise.all([
    countsOf(ctx, filter),
    ...sections.map(async (section) => {
      if (tab !== "all") return { section, ...await sectionPage(ctx, section, filter, page.cursor, limit) };
      const preview = await sectionPage(ctx, section, filter, null, PREVIEW[section]);
      return { section, items: preview.items, nextCursor: null };
    }),
  ]);
  return data(200, { counts, sections: pages }, ctx.rid);
};

const kindOf = (raw: string): Kind => {
  const kind = KIND_NAMES.find((name) => name === raw);
  if (!kind) throw notFound();
  return kind;
};

const getMaterial = async (ctx: Ctx, kindRaw: string, idRaw: string): Promise<Response> => {
  const kind = kindOf(kindRaw);
  const id = requireUuid(idRaw, "id");
  const [material] = await materialsOf(ctx, kind, [id]);
  if (!material) throw notFound();
  const maker = (material.createdBy ?? null) as Row | null;
  const used = (await query(ctx.deps.query, USED_BY, [ctx.user.id, kind, id])).rows.map(botRef);
  const usedBy = maker ? [maker, ...used.filter((bot) => bot.id !== maker.id)] : used;
  return data(200, { ...material, usedBy }, ctx.rid);
};

const deleteMaterial = async (ctx: Ctx, kindRaw: string, idRaw: string): Promise<Response> => {
  const kind = kindOf(kindRaw);
  if (!(await KINDS[kind].remove(ctx, requireUuid(idRaw, "id")))) throw notFound();
  return noContent(ctx.rid);
};

const restoreMaterial = async (ctx: Ctx, kindRaw: string, idRaw: string): Promise<Response> => {
  const kind = kindOf(kindRaw);
  const id = requireUuid(idRaw, "id");
  await KINDS[kind].restore(ctx, id);
  const [material] = await materialsOf(ctx, kind, [id]);
  if (!material) throw notFound();
  return data(200, material, ctx.rid);
};

export const dispatchMaterials = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === "/api/v1/materials") return method === "GET" ? listMaterials(ctx) : null;
  const m = path.match(/^\/api\/v1\/materials\/([^/]+)\/([^/]+)(\/restore)?$/);
  if (!m) return null;
  if (m[3]) return method === "POST" ? restoreMaterial(ctx, m[1], m[2]) : null;
  if (method === "GET") return getMaterial(ctx, m[1], m[2]);
  if (method === "DELETE") return deleteMaterial(ctx, m[1], m[2]);
  return null;
};
