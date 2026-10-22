import { strictBody } from "../body.ts";
import { one, query } from "../db.ts";
import { HttpError, data, fieldError, pageBody, requireUuid, sha256Hex } from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import type { Ctx } from "../types.ts";

const KINDS = new Set(["RESUME", "GITHUB", "CAREER", "EDUCATION", "SKILL", "PROJECT"]);
const COLS = "id, user_id, revision, kind, title, source_text, source_url, skills, verification_status, provenance, supersedes_id, archived, created_at, updated_at";

type Row = Record<string, unknown>;

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");
const len = (value: string): number => Array.from(value).length;

const pick = (obj: Row, camel: string, snake: string): unknown => (camel in obj ? obj[camel] : obj[snake]);

const location = (value: unknown): Row | null => {
  if (!value || typeof value !== "object") return null;
  const loc = value as Row;
  return { start: Number(loc.start), end: Number(loc.end), unit: String(loc.unit) };
};

const provenance = (value: unknown): Row => {
  const p = (value && typeof value === "object" ? value : {}) as Row;
  const sourceId = pick(p, "sourceId", "source_id");
  const projectEvidenceId = pick(p, "projectEvidenceId", "project_evidence_id");
  return {
    sourceId: sourceId == null ? null : String(sourceId),
    projectEvidenceId: projectEvidenceId == null ? null : String(projectEvidenceId),
    contentHash: String(pick(p, "contentHash", "content_hash") ?? ""),
    sourceLocation: location(pick(p, "sourceLocation", "source_location")),
  };
};

const evidenceDto = (row: Row): Row => ({
  id: String(row.id),
  revision: Number(row.revision),
  kind: String(row.kind),
  title: String(row.title),
  sourceText: String(row.source_text),
  sourceUrl: row.source_url == null ? null : String(row.source_url),
  skills: Array.isArray(row.skills) ? row.skills.map(String) : [],
  verificationStatus: String(row.verification_status),
  provenance: provenance(row.provenance),
  supersedesId: row.supersedes_id == null ? null : String(row.supersedes_id),
  archived: Boolean(row.archived),
  createdAt: ts(row.created_at),
  updatedAt: ts(row.updated_at),
});

const httpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
};

const loadEvidence = async (ctx: Ctx, id: string): Promise<Row> => {
  const row = await one(ctx.deps.query, `SELECT ${COLS} FROM career_evidence WHERE id = $1 AND user_id = $2`, [id, ctx.user.id]);
  if (!row) throw notFound();
  return row;
};

export const listEvidence = async (ctx: Ctx): Promise<Response> => {
  const page = pageOf(ctx.url);
  const kind = ctx.url.searchParams.get("kind") || null;
  if (kind !== null && !KINDS.has(kind)) throw fieldError("kind", "unsupported kind");
  const params: unknown[] = [ctx.user.id];
  const where = ["user_id = $1", "NOT archived"];
  if (kind) {
    params.push(kind);
    where.push(`kind = $${params.length}`);
  }
  const q = ctx.url.searchParams.get("query") || "";
  if (q) {
    params.push("%" + q + "%", "%" + q + "%");
    where.push(`(title ILIKE $${params.length - 1} OR source_text ILIKE $${params.length})`);
  }
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
  }
  params.push(page.limit + 1);
  const rows = await query(ctx.deps.query,
    `SELECT ${COLS} FROM career_evidence WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  const paged = pageResult(rows.rows, page.limit, (row) => ({ createdAt: row.created_at, id: String(row.id) }));
  return pageBody(paged.items.map(evidenceDto), paged.nextCursor, paged.hasMore, ctx.rid);
};

export const getEvidence = async (ctx: Ctx, idRaw: string): Promise<Response> =>
  data(200, evidenceDto(await loadEvidence(ctx, requireUuid(idRaw, "id"))), ctx.rid);

export const createEvidence = async (ctx: Ctx): Promise<Response> => {
  const { values } = await strictBody(ctx.request, {
    kind: { kind: "str", required: true },
    title: { kind: "str", required: true },
    sourceText: { kind: "str", required: true },
    sourceUrl: { kind: "str", nullable: true },
    skills: { kind: "str[]" },
    supersedesId: { kind: "uuid", nullable: true },
  });
  const kind = String(values.kind);
  const title = String(values.title);
  const sourceText = String(values.sourceText);
  const sourceUrl = values.sourceUrl == null ? null : String(values.sourceUrl);
  const skills = (values.skills as string[] | undefined) ?? [];
  const supersedesId = values.supersedesId == null ? null : String(values.supersedesId);
  if (!KINDS.has(kind)) throw fieldError("kind", "unsupported kind");
  if (len(title) < 1 || len(title) > 200) throw fieldError("title", "title must be 1-200 characters");
  if (len(sourceText) < 1 || len(sourceText) > 100000) throw fieldError("sourceText", "sourceText must be 1-100000 characters");
  if (skills.length > 100) throw fieldError("skills", "at most 100 skills");
  if (skills.some((skill) => len(skill) < 1 || len(skill) > 100)) throw fieldError("skills", "each skill must be 1-100 characters");
  if (sourceUrl !== null && !httpUrl(sourceUrl)) throw fieldError("sourceUrl", "must be an http(s) URL without credentials");
  if (supersedesId !== null) {
    const prior = await one(ctx.deps.query, "SELECT id FROM career_evidence WHERE id = $1 AND user_id = $2", [supersedesId, ctx.user.id]);
    if (!prior) throw fieldError("supersedesId", "referenced evidence not found");
  }
  const now = ts(ctx.now);
  const row: Row = {
    id: crypto.randomUUID(), revision: 1, kind, title, source_text: sourceText, source_url: sourceUrl, skills,
    verification_status: "USER_PROVIDED",
    provenance: { sourceId: null, projectEvidenceId: null, contentHash: await sha256Hex(sourceText), sourceLocation: null },
    supersedes_id: supersedesId, archived: false, created_at: now, updated_at: now,
  };
  await query(ctx.deps.query,
    `INSERT INTO career_evidence (${COLS}) VALUES ($1,$2,1,$3,$4,$5,$6,$7::jsonb,'USER_PROVIDED',$8::jsonb,$9,false,$10,$10)`,
    [row.id, ctx.user.id, kind, title, sourceText, sourceUrl, JSON.stringify(skills), JSON.stringify(row.provenance), supersedesId, now]);
  return data(201, evidenceDto(row), ctx.rid);
};

export const archiveEvidence = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, { expectedRevision: { kind: "int", required: true } });
  const expected = Number(values.expectedRevision);
  const row = await loadEvidence(ctx, id);
  if (row.archived) return data(200, evidenceDto(row), ctx.rid);
  const now = ts(ctx.now);
  const updated = await one(ctx.deps.query,
    "UPDATE career_evidence SET revision = revision + 1, archived = true, updated_at = $3 WHERE id = $1 AND user_id = $2 AND revision = $4 RETURNING id",
    [id, ctx.user.id, now, expected]);
  if (!updated) {
    const current = await one(ctx.deps.query, "SELECT revision FROM career_evidence WHERE id = $1 AND user_id = $2", [id, ctx.user.id]);
    if (!current) throw notFound();
    throw new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision: Number(current.revision) });
  }
  return data(200, evidenceDto({ ...row, archived: true, updated_at: now, revision: expected + 1 }), ctx.rid);
};

export const dispatchEvidence = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === "/api/v1/career-evidence") {
    if (method === "GET") return listEvidence(ctx);
    if (method === "POST") return createEvidence(ctx);
    return null;
  }
  if (path === "/api/v1/career-evidence/import") return null;
  const m = path.match(/^\/api\/v1\/career-evidence\/([^/]+)(\/archive)?$/);
  if (!m) return null;
  if (!m[2] && method === "GET") return getEvidence(ctx, m[1]);
  if (m[2] && method === "POST") return archiveEvidence(ctx, m[1]);
  return null;
};
