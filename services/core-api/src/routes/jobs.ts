import { one, query } from "../db.ts";
import { HttpError, data, jsonList, pageBody, requireUuid } from "../http.ts";
import { pageOf, pageResult, revisionUpdate, ts } from "../page.ts";
import type { Ctx } from "../types.ts";

const KINDS = new Set(["URL", "TEXT", "DOM"]);

function httpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function jobDto(row: Record<string, unknown>): Record<string, unknown> {
  let deadline: string | null = null;
  if (row.deadline != null && row.deadline !== "") {
    const text = String(row.deadline);
    deadline = text.slice(0, 10);
  }
  return {
    id: String(row.id),
    revision: Number(row.revision),
    company: String(row.company ?? ""),
    title: String(row.title ?? ""),
    sourceKind: String(row.source_kind ?? ""),
    sourceUrl: row.source_url == null ? null : String(row.source_url),
    sourceText: String(row.source_text ?? ""),
    requirements: jsonList(row.requirements),
    preferred: jsonList(row.preferred),
    keywords: jsonList(row.keywords),
    risks: jsonList(row.risks),
    deadline,
    language: String(row.language ?? ""),
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
  };
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw) throw new HttpError(400, "VALIDATION_ERROR", "request body required");
  try {
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("shape");
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
}

function validateJob(company: string, title: string, kind: string, sourceUrl: string | null, sourceText: string): void {
  if (company.length < 1 || company.length > 200) {
    throw new HttpError(400, "VALIDATION_ERROR", "company must be 1-200 characters", { field: "company" });
  }
  if (title.length < 1 || title.length > 300) {
    throw new HttpError(400, "VALIDATION_ERROR", "title must be 1-300 characters", { field: "title" });
  }
  if (!KINDS.has(kind)) throw new HttpError(400, "VALIDATION_ERROR", "must be URL, TEXT or DOM", { field: "sourceKind" });
  if (kind !== "TEXT" && !sourceUrl) throw new HttpError(400, "VALIDATION_ERROR", "required for URL/DOM sources", { field: "sourceUrl" });
  if (sourceUrl && !httpsUrl(sourceUrl)) {
    throw new HttpError(400, "VALIDATION_ERROR", "must be an http(s) URL without credentials", { field: "sourceUrl" });
  }
  if (sourceText.length < 1 || sourceText.length > 200000) {
    throw new HttpError(400, "VALIDATION_ERROR", "collected source text is required (1-200000 characters)", { field: "sourceText" });
  }
}

export async function listJobs(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  let sql = "SELECT id, revision, company, title, source_kind, source_url, source_text, requirements, preferred, keywords, risks, deadline, language, created_at, updated_at FROM jobs WHERE user_id = $1";
  if (ctx.url.searchParams.has("archived")) {
    params.push(ctx.url.searchParams.get("archived") === "true");
    sql += ` AND archived = $${params.length}`;
  }
  const q = ctx.url.searchParams.get("query") || "";
  if (q) {
    params.push("%" + q + "%", "%" + q + "%");
    sql += ` AND (company ILIKE $${params.length - 1} OR title ILIKE $${params.length})`;
  }
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (created_at, id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({ item: jobDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

export async function createJob(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  const company = String(body.company ?? "");
  const title = String(body.title ?? "");
  const kind = String(body.sourceKind ?? "");
  const sourceUrl = body.sourceUrl == null ? null : String(body.sourceUrl);
  const sourceText = String(body.sourceText ?? "");
  if (typeof body.company !== "string" || typeof body.title !== "string" || typeof body.sourceKind !== "string" || typeof body.sourceText !== "string" || typeof body.language !== "string") {
    throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  }
  validateJob(company, title, kind, sourceUrl, sourceText);
  let deadline: string | null = null;
  if (body.deadline != null) {
    if (typeof body.deadline !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.deadline)) {
      throw new HttpError(400, "VALIDATION_ERROR", "must be YYYY-MM-DD", { field: "deadline" });
    }
    deadline = body.deadline;
  }
  const requirements = Array.isArray(body.requirements) ? body.requirements : [];
  const preferred = Array.isArray(body.preferred) ? body.preferred : [];
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    "INSERT INTO jobs (id, user_id, revision, company, title, source_kind, source_url, source_text, requirements, preferred, keywords, risks, deadline, language, archived, created_at, updated_at) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,'[]'::jsonb,'[]'::jsonb,$10,$11,false,$12,$12)",
    [id, ctx.user.id, company, title, kind, sourceUrl, sourceText, JSON.stringify(requirements), JSON.stringify(preferred), deadline, body.language, now]);
  return data(201, jobDto({
    id, revision: 1, company, title, source_kind: kind, source_url: sourceUrl, source_text: sourceText,
    requirements, preferred, keywords: [], risks: [], deadline, language: body.language, created_at: now, updated_at: now,
  }), ctx.rid);
}

export async function getJob(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query,
    "SELECT id, revision, company, title, source_kind, source_url, source_text, requirements, preferred, keywords, risks, deadline, language, created_at, updated_at FROM jobs WHERE id = $1 AND user_id = $2",
    [id, ctx.user.id]);
  if (!row) throw new HttpError(404, "NOT_FOUND", "resource not found");
  return data(200, jobDto(row), ctx.rid);
}

export async function patchJob(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const body = await readObject(ctx.request);
  if (typeof body.expectedRevision !== "number") throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  const current = await one(ctx.deps.query,
    "SELECT id, revision, company, title, source_kind, source_url, source_text, requirements, preferred, keywords, risks, deadline, language, archived, created_at FROM jobs WHERE id = $1 AND user_id = $2",
    [id, ctx.user.id]);
  if (!current) throw new HttpError(404, "NOT_FOUND", "resource not found");
  if (body.company != null) {
    if (typeof body.company !== "string" || body.company.length < 1 || body.company.length > 200) {
      throw new HttpError(400, "VALIDATION_ERROR", "company must be 1-200 characters", { field: "company" });
    }
    current.company = body.company;
  }
  if (body.title != null) {
    if (typeof body.title !== "string" || body.title.length < 1 || body.title.length > 300) {
      throw new HttpError(400, "VALIDATION_ERROR", "title must be 1-300 characters", { field: "title" });
    }
    current.title = body.title;
  }
  if (body.requirements != null) current.requirements = body.requirements;
  if (body.preferred != null) current.preferred = body.preferred;
  let deadline = current.deadline == null ? null : String(current.deadline).slice(0, 10);
  if ("deadline" in body) {
    if (body.deadline == null) deadline = null;
    else if (typeof body.deadline !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.deadline)) {
      throw new HttpError(400, "VALIDATION_ERROR", "must be YYYY-MM-DD", { field: "deadline" });
    } else deadline = body.deadline;
  }
  const now = ctx.now.toISOString();
  const updated = await revisionUpdate(ctx.deps.query, "jobs",
    "UPDATE jobs SET revision = revision + 1, company = $3, title = $4, source_kind = $5, source_url = $6, source_text = $7, requirements = $8::jsonb, preferred = $9::jsonb, keywords = $10::jsonb, risks = $11::jsonb, deadline = $12, language = $13, archived = $14, updated_at = $15 WHERE id = $1 AND user_id = $2 AND revision = $16 RETURNING id, revision, company, title, source_kind, source_url, source_text, requirements, preferred, keywords, risks, deadline, language, created_at, updated_at",
    [id, ctx.user.id, current.company, current.title, current.source_kind, current.source_url, current.source_text,
      JSON.stringify(jsonList(current.requirements)), JSON.stringify(jsonList(current.preferred)),
      JSON.stringify(jsonList(current.keywords)), JSON.stringify(jsonList(current.risks)),
      deadline, current.language, current.archived === true || current.archived === "t", now, body.expectedRevision],
    id, ctx.user.id);
  return data(200, jobDto(updated), ctx.rid);
}

export async function listAnalyses(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const job = await one(ctx.deps.query, "SELECT id FROM jobs WHERE id = $1 AND user_id = $2", [id, ctx.user.id]);
  if (!job) throw new HttpError(404, "NOT_FOUND", "resource not found");
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id, id];
  let sql = "SELECT id, application_id, job_id, job_revision, evidence_ids, matched, missing, preferred_missing, risks, fit_score, method, stale, created_at FROM gap_analyses WHERE user_id = $1 AND job_id = $2";
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (created_at, id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({
    item: {
      id: String(row.id),
      applicationId: String(row.application_id),
      jobId: String(row.job_id),
      jobRevision: Number(row.job_revision),
      evidenceIds: jsonList(row.evidence_ids).map(String),
      matched: jsonList(row.matched),
      missing: jsonList(row.missing),
      preferredMissing: jsonList(row.preferred_missing),
      risks: jsonList(row.risks),
      fitScore: row.fit_score == null ? null : Number(row.fit_score),
      method: String(row.method),
      stale: row.stale === true || row.stale === "t",
      createdAt: ts(row.created_at),
    },
    createdAt: row.created_at,
    id: String(row.id),
  }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}
