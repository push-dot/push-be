import { strictBody, strictObject } from "../body.ts";
import { one, query } from "../db.ts";
import {
  blocksOf, codePointSlice, computeQuality, hunkEdits, qualityOf, replaced, validateDocumentContent,
  type Block,
} from "../document-content.ts";
import { HttpError, data, fieldError, hashJson, pageBody, parseUuid, requireUuid } from "../http.ts";
import { pageOf, pageResult, ts, type Page } from "../page.ts";
import type { Ctx } from "../types.ts";

const DOC_COLS = "id, user_id, revision, application_id, title, kind, template, language, status, latest_version_id, finalized_version_id, created_at, updated_at";
const VERSION_COLS = "id, user_id, document_id, application_id, number, content, blocks, change_note, quality, created_at";
const PROPOSAL_COLS = "id, user_id, document_id, source_version_id, source_revision, selection, replacement, evidence_refs, claim_status, applied_at, created_at";
const EXPORT_COLS = "id, user_id, document_id, version_id, format, template, language, content, blocks, content_hash, status, renderer_version, result, created_at, updated_at";
const KINDS = new Set(["RESUME", "PORTFOLIO", "COVER_LETTER"]);
const TEMPLATE_ALIASES: Record<string, string> = { CLASSIC: "SIMPLE", COMPACT: "ATS" };
const TEMPLATES = new Set(["SIMPLE", "MODERN", "CREATIVE", "ATS", "CLASSIC", "COMPACT"]);
const TEMPLATE_MESSAGE = "must be SIMPLE, MODERN, CREATIVE, ATS, CLASSIC or COMPACT";

type Row = Record<string, unknown>;

const notFound = (): HttpError => new HttpError(404, "NOT_FOUND", "resource not found");
const conflict = (current: unknown): HttpError => new HttpError(409, "REVISION_CONFLICT", "resource was modified", { currentRevision: Number(current) });
const transition = (message: string): HttpError => new HttpError(409, "INVALID_TRANSITION", message);
const approvalRequired = (message: string): HttpError => new HttpError(409, "APPROVAL_REQUIRED", message);
const approvalStale = (message: string): HttpError => new HttpError(409, "APPROVAL_STALE", message);
const len = (value: string): number => Array.from(value).length;
const str = (value: unknown): string | null => (value == null ? null : String(value));

const documentDto = (row: Row): Row => ({
  id: String(row.id),
  revision: Number(row.revision),
  applicationId: str(row.application_id),
  title: String(row.title),
  kind: String(row.kind),
  template: String(row.template),
  language: String(row.language ?? ""),
  status: String(row.status),
  latestVersionId: str(row.latest_version_id),
  finalizedVersionId: str(row.finalized_version_id),
  createdAt: ts(row.created_at),
  updatedAt: ts(row.updated_at),
});

const versionDto = (row: Row): Row => ({
  id: String(row.id),
  documentId: String(row.document_id),
  applicationId: str(row.application_id),
  number: Number(row.number),
  content: row.content,
  blocks: blocksOf(row.blocks),
  changeNote: String(row.change_note ?? ""),
  quality: qualityOf(row.quality),
  createdAt: ts(row.created_at),
});

const exportResultOf = (value: unknown): Row | null => {
  if (!value || typeof value !== "object") return null;
  const r = value as Row;
  const v = (r.validation && typeof r.validation === "object" ? r.validation : {}) as Row;
  const pageCount = r.pageCount ?? r.page_count;
  const errorCode = r.errorCode ?? r.error_code;
  return {
    sha256: String(r.sha256),
    byteLength: Number(r.byteLength ?? r.byte_length),
    ...(pageCount == null ? {} : { pageCount: Number(pageCount) }),
    validation: { koreanText: Boolean(v.koreanText ?? v.korean_text), links: Boolean(v.links), atsText: Boolean(v.atsText ?? v.ats_text) },
    ...(errorCode == null ? {} : { errorCode: String(errorCode) }),
  };
};

const exportDto = (row: Row): Row => ({
  id: String(row.id),
  documentId: String(row.document_id),
  versionId: String(row.version_id),
  format: String(row.format),
  template: String(row.template),
  language: String(row.language ?? ""),
  content: row.content,
  blocks: blocksOf(row.blocks),
  contentHash: String(row.content_hash),
  status: String(row.status),
  rendererVersion: String(row.renderer_version),
  result: exportResultOf(row.result),
  createdAt: ts(row.created_at),
  updatedAt: ts(row.updated_at),
});

const pageOfRows = async (ctx: Ctx, cols: string, table: string, where: string[], params: unknown[], page: Page, dto: (row: Row) => Row): Promise<Response> => {
  const args = [...params];
  const conds = [...where];
  if (page.cursor) {
    args.push(page.cursor.createdAt, page.cursor.id);
    conds.push(`(created_at, id) < ($${args.length - 1}, $${args.length})`);
  }
  args.push(page.limit + 1);
  const rows = await query(ctx.deps.query,
    `SELECT ${cols} FROM ${table} WHERE ${conds.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${args.length}`, args);
  const paged = pageResult(rows.rows, page.limit, (row) => ({ createdAt: row.created_at, id: String(row.id) }));
  return pageBody(paged.items.map(dto), paged.nextCursor, paged.hasMore, ctx.rid);
};

const loadDocument = async (ctx: Ctx, id: string): Promise<Row> => {
  const row = await one(ctx.deps.query, `SELECT ${DOC_COLS} FROM documents WHERE id = $1 AND user_id = $2`, [id, ctx.user.id]);
  if (!row) throw notFound();
  return row;
};

/** `_get_mutable`: archived documents take no writes. */
const loadMutable = async (ctx: Ctx, id: string): Promise<Row> => {
  const row = await loadDocument(ctx, id);
  if (row.status === "ARCHIVED") throw transition("document is archived");
  return row;
};

const loadVersion = async (ctx: Ctx, docId: string, versionId: string): Promise<Row> => {
  const row = await one(ctx.deps.query, `SELECT ${VERSION_COLS} FROM document_versions WHERE id = $1 AND user_id = $2 AND document_id = $3`,
    [versionId, ctx.user.id, docId]);
  if (!row) throw notFound();
  return row;
};

const failedUpdate = async (ctx: Ctx, table: string, id: string): Promise<never> => {
  const current = await one(ctx.deps.query, `SELECT revision FROM ${table} WHERE id = $1 AND user_id = $2`, [id, ctx.user.id]);
  if (!current) throw notFound();
  throw conflict(current.revision);
};

/** `_verify_blocks`: sets each block's claim status; returns evidence ids in first-seen order. */
const verifyBlocks = async (ctx: Ctx, blocks: Block[]): Promise<string[]> => {
  const loaded = new Map<string, Row>();
  for (const b of blocks) {
    if (!b.evidenceRefs.length) {
      b.claimStatus = "UNSUPPORTED";
      continue;
    }
    let status = "SUPPORTED";
    for (const ref of b.evidenceRefs) {
      let e = loaded.get(ref.evidenceId);
      if (!e) {
        const row = await one(ctx.deps.query, "SELECT id, source_text, archived FROM career_evidence WHERE id = $1 AND user_id = $2", [ref.evidenceId, ctx.user.id]);
        if (!row) throw fieldError("blocks", "evidence " + ref.evidenceId + " not found");
        e = row;
        loaded.set(ref.evidenceId, row);
      }
      if (e.archived) throw fieldError("blocks", "evidence " + ref.evidenceId + " is archived");
      const span = codePointSlice(String(e.source_text), ref.start, ref.end);
      if (span === null) throw fieldError("blocks", "evidenceRef range out of bounds for " + ref.evidenceId);
      if (!span || !b.text.includes(span)) status = "NEEDS_REVIEW";
    }
    b.claimStatus = status;
  }
  return [...loaded.keys()];
};

/**
 * `_save_edit` / `create_version`: validate, verify, then write the version and move the
 * document to it in one statement, guarded by the document revision.
 */
const saveVersion = async (
  ctx: Ctx, doc: Row, expected: number, content: unknown, blocks: Block[], note: string,
  extra?: { proposalId: string },
): Promise<{ document: Row; version: Row }> => {
  validateDocumentContent(content, blocks);
  await verifyBlocks(ctx, blocks);
  const quality = computeQuality(blocks);
  const now = ts(ctx.now);
  const versionId = crypto.randomUUID();
  const docId = String(doc.id);
  const saved = await one(ctx.deps.query,
    `WITH upd AS (UPDATE documents SET revision = revision + 1, latest_version_id = $3, finalized_version_id = NULL,
         status = CASE WHEN status = 'FINALIZED' THEN 'DRAFT' ELSE status END, updated_at = $4
       WHERE id = $1 AND user_id = $2 AND revision = $5 RETURNING id),
     ins AS (INSERT INTO document_versions (${VERSION_COLS})
       SELECT $3, $2, $1, $6, (SELECT COALESCE(MAX(number), 0) + 1 FROM document_versions WHERE document_id = $1), $7::jsonb, $8::jsonb, $9, $10::jsonb, $4
       FROM upd RETURNING number),
     used AS (UPDATE revision_proposals SET applied_at = $4 FROM upd WHERE revision_proposals.id = $11 AND $11::uuid IS NOT NULL)
     SELECT number FROM ins`,
    [docId, ctx.user.id, versionId, now, expected, doc.application_id ?? null, JSON.stringify(content), JSON.stringify(blocks),
      note, JSON.stringify(quality), extra?.proposalId ?? null]);
  if (!saved) await failedUpdate(ctx, "documents", docId);
  const document = {
    ...doc, revision: expected + 1, latest_version_id: versionId, finalized_version_id: null,
    status: doc.status === "FINALIZED" ? "DRAFT" : doc.status, updated_at: now,
  };
  const version = {
    id: versionId, document_id: docId, application_id: doc.application_id ?? null, number: Number(saved?.number),
    content, blocks, change_note: note, quality, created_at: now,
  };
  return { document: documentDto(document), version: versionDto(version) };
};

const blockInputs = (value: unknown): Block[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  return value.map((raw) => {
    const b = strictObject(raw, { id: { kind: "str", required: true }, text: { kind: "str", required: true }, evidenceRefs: { kind: "any" } }).values;
    const refs = b.evidenceRefs === undefined ? [] : b.evidenceRefs;
    if (!Array.isArray(refs)) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
    return {
      id: String(b.id),
      text: String(b.text),
      evidenceRefs: refs.map((r) => {
        const ref = strictObject(r, { evidenceId: { kind: "uuid", required: true }, start: { kind: "int", required: true }, end: { kind: "int", required: true } }).values;
        return { evidenceId: String(ref.evidenceId), start: Number(ref.start), end: Number(ref.end) };
      }),
      claimStatus: "",
    };
  });
};

export const listDocuments = async (ctx: Ctx): Promise<Response> => {
  const page = pageOf(ctx.url);
  const appRaw = ctx.url.searchParams.get("applicationId");
  let applicationId: string | null = null;
  if (appRaw) {
    applicationId = parseUuid(appRaw);
    if (!applicationId) throw fieldError("applicationId", "must be a UUID");
  }
  const kind = ctx.url.searchParams.get("kind") || null;
  if (kind !== null && !KINDS.has(kind)) throw fieldError("kind", "unsupported kind");
  const where = ["user_id = $1"];
  const params: unknown[] = [ctx.user.id];
  for (const [value, column] of [[applicationId, "application_id"], [kind, "kind"]] as const) {
    if (value === null) continue;
    params.push(value);
    where.push(`${column} = $${params.length}`);
  }
  return pageOfRows(ctx, DOC_COLS, "documents", where, params, page, documentDto);
};

export const createDocument = async (ctx: Ctx): Promise<Response> => {
  const { values } = await strictBody(ctx.request, {
    applicationId: { kind: "uuid", required: true },
    title: { kind: "str", required: true },
    kind: { kind: "str", required: true },
    template: { kind: "str" },
    language: { kind: "str", required: true },
  });
  const app = await one(ctx.deps.query, "SELECT id FROM applications WHERE id = $1 AND user_id = $2", [values.applicationId, ctx.user.id]);
  if (!app) throw notFound();
  const title = String(values.title);
  const kind = String(values.kind);
  const template = String(values.template ?? "");
  if (len(title) < 1 || len(title) > 300) throw fieldError("title", "title must be 1-300 characters");
  if (!KINDS.has(kind)) throw fieldError("kind", "must be RESUME, PORTFOLIO or COVER_LETTER");
  if (!TEMPLATES.has(template)) throw fieldError("template", TEMPLATE_MESSAGE);
  const now = ts(ctx.now);
  const row: Row = {
    id: crypto.randomUUID(), revision: 1, application_id: values.applicationId, title, kind,
    template: TEMPLATE_ALIASES[template] ?? template, language: String(values.language), status: "DRAFT",
    latest_version_id: null, finalized_version_id: null, created_at: now, updated_at: now,
  };
  await query(ctx.deps.query,
    `INSERT INTO documents (${DOC_COLS}) VALUES ($1,$2,1,$3,$4,$5,$6,$7,'DRAFT',NULL,NULL,$8,$8)`,
    [row.id, ctx.user.id, row.application_id, title, kind, row.template, row.language, now]);
  return data(201, documentDto(row), ctx.rid);
};

export const getDocument = async (ctx: Ctx, idRaw: string): Promise<Response> =>
  data(200, documentDto(await loadDocument(ctx, requireUuid(idRaw, "id"))), ctx.rid);

export const patchDocument = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, {
    expectedRevision: { kind: "int", required: true },
    title: { kind: "str", nullable: true },
    template: { kind: "str", nullable: true },
    language: { kind: "str", nullable: true },
  });
  const expected = Number(values.expectedRevision);
  const doc = await loadMutable(ctx, id);
  if (Number(doc.revision) !== expected) throw conflict(doc.revision);
  if (values.title != null) {
    if (len(String(values.title)) < 1 || len(String(values.title)) > 300) throw fieldError("title", "title must be 1-300 characters");
    doc.title = values.title;
  }
  if (values.template != null) {
    const template = String(values.template);
    if (!TEMPLATES.has(template)) throw fieldError("template", TEMPLATE_MESSAGE);
    const stored = TEMPLATE_ALIASES[template] ?? template;
    if (stored !== doc.template) {
      doc.template = stored;
      doc.finalized_version_id = null;
      if (doc.status === "FINALIZED") doc.status = "DRAFT";
    }
  }
  if (values.language != null) doc.language = values.language;
  const now = ts(ctx.now);
  const updated = await one(ctx.deps.query,
    "UPDATE documents SET revision = revision + 1, title = $3, template = $4, language = $5, status = $6, latest_version_id = $7, finalized_version_id = $8, updated_at = $9 WHERE id = $1 AND user_id = $2 AND revision = $10 RETURNING id",
    [id, ctx.user.id, doc.title, doc.template, doc.language, doc.status, doc.latest_version_id ?? null, doc.finalized_version_id ?? null, now, expected]);
  if (!updated) await failedUpdate(ctx, "documents", id);
  return data(200, documentDto({ ...doc, revision: expected + 1, updated_at: now }), ctx.rid);
};

export const listVersions = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const page = pageOf(ctx.url);
  await loadDocument(ctx, id);
  return pageOfRows(ctx, VERSION_COLS, "document_versions", ["user_id = $1", "document_id = $2"], [ctx.user.id, id], page, versionDto);
};

export const getVersion = async (ctx: Ctx, idRaw: string, versionRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const versionId = requireUuid(versionRaw, "versionId");
  await loadDocument(ctx, id);
  return data(200, versionDto(await loadVersion(ctx, id, versionId)), ctx.rid);
};

export const createVersion = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, {
    expectedRevision: { kind: "int", required: true },
    content: { kind: "object", required: true },
    blocks: { kind: "any" },
    changeNote: { kind: "str" },
  });
  const blocks = blockInputs(values.blocks);
  const expected = Number(values.expectedRevision);
  const doc = await loadMutable(ctx, id);
  if (Number(doc.revision) !== expected) throw conflict(doc.revision);
  return data(201, await saveVersion(ctx, doc, expected, values.content, blocks, String(values.changeNote ?? "")), ctx.rid);
};

export const applyRevision = async (ctx: Ctx, idRaw: string, proposalRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const proposalId = requireUuid(proposalRaw, "revisionId");
  const { values } = await strictBody(ctx.request, { expectedRevision: { kind: "int", required: true } });
  const expected = Number(values.expectedRevision);
  const doc = await loadMutable(ctx, id);
  if (Number(doc.revision) !== expected) throw conflict(doc.revision);
  const proposal = await one(ctx.deps.query, `SELECT ${PROPOSAL_COLS} FROM revision_proposals WHERE id = $1 AND user_id = $2 AND document_id = $3`,
    [proposalId, ctx.user.id, id]);
  if (!proposal) throw notFound();
  if (proposal.applied_at != null) throw transition("proposal already applied");
  if (doc.latest_version_id == null || String(doc.latest_version_id) !== String(proposal.source_version_id) || Number(proposal.source_revision) !== Number(doc.revision)) {
    throw approvalStale("document changed since the proposal was created");
  }
  const src = await loadVersion(ctx, id, String(proposal.source_version_id));
  const selection = (proposal.selection ?? {}) as Row;
  const edit = replaced(src.content, blocksOf(src.blocks), [[String(selection.text ?? ""), String(proposal.replacement)]]);
  if (!edit.applied) throw approvalStale("selection text no longer present in the version");
  return data(200, await saveVersion(ctx, doc, expected, edit.content, edit.blocks, "applied proposal " + proposalId, { proposalId }), ctx.rid);
};

/** Chat edits (the harness `edit_document` tool): `DocumentService.apply_hunks`. */
export const applyEdits = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  let body: Row;
  try { body = JSON.parse(await ctx.request.text()) as Row; } catch { throw new HttpError(400, "VALIDATION_ERROR", "invalid request body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "VALIDATION_ERROR", "invalid request body");
  const edits = hunkEdits(Array.isArray(body.hunks) ? body.hunks : []);
  const doc = await loadMutable(ctx, id);
  const expectedVersion = body.revisionId ? String(body.revisionId) : "";
  if (doc.latest_version_id == null || (expectedVersion && expectedVersion !== String(doc.latest_version_id))) throw conflict(doc.revision);
  const src = await loadVersion(ctx, id, String(doc.latest_version_id));
  const edit = replaced(src.content, blocksOf(src.blocks), edits);
  if (!edit.applied) throw conflict(doc.revision);
  return data(200, await saveVersion(ctx, doc, Number(doc.revision), edit.content, edit.blocks, "applied chat edit"), ctx.rid);
};

export const reviewDocument = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, { versionId: { kind: "uuid", required: true } });
  await loadDocument(ctx, id);
  const version = await loadVersion(ctx, id, String(values.versionId));
  const blocks = blocksOf(version.blocks);
  await verifyBlocks(ctx, blocks);
  return data(200, { quality: computeQuality(blocks), blocks }, ctx.rid);
};

export const finalizeDocument = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, {
    expectedRevision: { kind: "int", required: true },
    versionId: { kind: "uuid", required: true },
    approvalId: { kind: "uuid", required: true },
  });
  const expected = Number(values.expectedRevision);
  const versionId = String(values.versionId);
  const approvalId = String(values.approvalId);
  const doc = await loadMutable(ctx, id);
  if (Number(doc.revision) !== expected) throw conflict(doc.revision);
  const version = await loadVersion(ctx, id, versionId);
  const blocks = blocksOf(version.blocks);
  const evidenceIds = await verifyBlocks(ctx, blocks);
  for (const b of blocks) if (b.claimStatus !== "SUPPORTED") throw new HttpError(409, "UNSUPPORTED_CLAIM", "block " + b.id + " is " + b.claimStatus);
  const appId = doc.application_id == null ? null : String(doc.application_id);
  for (const eid of evidenceIds) {
    const use = await one(ctx.deps.query,
      "SELECT status FROM approvals WHERE user_id = $1 AND kind = 'EVIDENCE_USE' AND application_id IS NOT DISTINCT FROM $2::uuid AND target_id = $3 AND status IN ('APPROVED','PENDING') AND (expires_at IS NULL OR expires_at > $4) ORDER BY created_at DESC LIMIT 1",
      [ctx.user.id, appId, eid, ts(ctx.now)]);
    if (!use || use.status !== "APPROVED") throw approvalRequired("EVIDENCE_USE approval required for evidence " + eid);
  }
  const approval = await one(ctx.deps.query,
    "SELECT revision, kind, application_id, target_id, payload_hash, status, expires_at FROM approvals WHERE id = $1 AND user_id = $2",
    [approvalId, ctx.user.id]);
  if (!approval) throw approvalRequired("approval not found");
  if (approval.kind !== "DOCUMENT_FINALIZE" || str(approval.application_id) !== appId || String(approval.target_id) !== versionId) {
    throw approvalRequired("approval does not cover this target");
  }
  if (approval.expires_at != null && ctx.now.getTime() > Date.parse(String(ts(approval.expires_at)))) throw approvalRequired("approval expired");
  if (approval.status !== "APPROVED") throw approvalRequired("approval is not approved");
  const hash = await hashJson({ kind: "DOCUMENT_FINALIZE", versionId, content: version.content, blocks });
  if (approval.payload_hash !== hash) throw approvalStale("approved content has changed");
  const now = ts(ctx.now);
  const done = await one(ctx.deps.query,
    `WITH ap AS (UPDATE approvals SET revision = revision + 1, status = 'CONSUMED', consumed_at = $3, updated_at = $3
       WHERE id = $1 AND user_id = $2 AND revision = $4
         AND EXISTS (SELECT 1 FROM documents WHERE id = $5 AND user_id = $2 AND revision = $6) RETURNING id),
     doc AS (UPDATE documents SET revision = revision + 1, status = 'FINALIZED', finalized_version_id = $7, updated_at = $3
       FROM ap WHERE documents.id = $5 AND documents.user_id = $2 AND documents.revision = $6 RETURNING documents.id),
     ev AS (INSERT INTO application_events (id, user_id, application_id, type, payload, created_at)
       SELECT $8, $2, $9::uuid, 'DOCUMENT_FINALIZED', $10::jsonb, $3 FROM doc WHERE $9::uuid IS NOT NULL)
     SELECT id FROM doc`,
    [approvalId, ctx.user.id, now, Number(approval.revision), id, expected, versionId, crypto.randomUUID(), appId,
      JSON.stringify({ documentId: id, versionId })]);
  if (!done) {
    const latest = await loadDocument(ctx, id);
    if (Number(latest.revision) !== expected) throw conflict(latest.revision);
    await failedUpdate(ctx, "approvals", approvalId);
  }
  return data(200, documentDto({ ...doc, revision: expected + 1, status: "FINALIZED", finalized_version_id: versionId, updated_at: now }), ctx.rid);
};

export const archiveDocument = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, { expectedRevision: { kind: "int", required: true } });
  const expected = Number(values.expectedRevision);
  const doc = await loadDocument(ctx, id);
  if (Number(doc.revision) !== expected) throw conflict(doc.revision);
  if (doc.status === "ARCHIVED") return data(200, documentDto(doc), ctx.rid);
  const now = ts(ctx.now);
  const updated = await one(ctx.deps.query,
    "UPDATE documents SET revision = revision + 1, status = 'ARCHIVED', updated_at = $3 WHERE id = $1 AND user_id = $2 AND revision = $4 RETURNING id",
    [id, ctx.user.id, now, expected]);
  if (!updated) await failedUpdate(ctx, "documents", id);
  return data(200, documentDto({ ...doc, revision: expected + 1, status: "ARCHIVED", updated_at: now }), ctx.rid);
};

export const createExport = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const { values } = await strictBody(ctx.request, {
    versionId: { kind: "uuid", required: true },
    format: { kind: "str", required: true },
    rendererVersion: { kind: "str", required: true },
  });
  const format = String(values.format);
  if (format !== "PDF" && format !== "DOCX") throw fieldError("format", "must be PDF or DOCX");
  if (!values.rendererVersion) throw fieldError("rendererVersion", "required");
  const doc = await loadDocument(ctx, id);
  const version = await loadVersion(ctx, id, String(values.versionId));
  if (doc.finalized_version_id == null || String(doc.finalized_version_id) !== String(version.id)) {
    throw new HttpError(422, "DOCUMENT_NOT_FINALIZED", "only the finalized version can be exported");
  }
  const now = ts(ctx.now);
  const blocks = blocksOf(version.blocks);
  const row: Row = {
    id: crypto.randomUUID(), document_id: id, version_id: version.id, format, template: doc.template, language: doc.language ?? "",
    content: version.content, blocks, content_hash: await hashJson(version.content), status: "READY_TO_RENDER",
    renderer_version: values.rendererVersion, result: null, created_at: now, updated_at: now,
  };
  await query(ctx.deps.query,
    `INSERT INTO document_exports (${EXPORT_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,'READY_TO_RENDER',$11,NULL,$12,$12)`,
    [row.id, ctx.user.id, id, version.id, format, row.template, row.language, JSON.stringify(version.content), JSON.stringify(blocks),
      row.content_hash, row.renderer_version, now]);
  return data(201, exportDto(row), ctx.rid);
};

export const listExports = async (ctx: Ctx, idRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const page = pageOf(ctx.url);
  await loadDocument(ctx, id);
  return pageOfRows(ctx, EXPORT_COLS, "document_exports", ["user_id = $1", "document_id = $2"], [ctx.user.id, id], page, exportDto);
};

export const recordExportResult = async (ctx: Ctx, idRaw: string, exportRaw: string): Promise<Response> => {
  const id = requireUuid(idRaw, "id");
  const exportId = requireUuid(exportRaw, "exportId");
  const { values } = await strictBody(ctx.request, {
    sha256: { kind: "str", required: true },
    byteLength: { kind: "int", required: true },
    pageCount: { kind: "int", nullable: true },
    validation: { kind: "any" },
    status: { kind: "str", required: true },
    errorCode: { kind: "str", nullable: true },
  });
  const validation = values.validation === undefined ? {} : strictObject(values.validation, {
    koreanText: { kind: "bool" }, links: { kind: "bool" }, atsText: { kind: "bool" },
  }).values;
  const status = String(values.status);
  if (status !== "SUCCEEDED" && status !== "FAILED") throw fieldError("status", "must be SUCCEEDED or FAILED");
  if (!values.sha256 || Number(values.byteLength) < 0) throw fieldError("sha256", "sha256 and non-negative byteLength are required");
  const row = await one(ctx.deps.query, `SELECT ${EXPORT_COLS} FROM document_exports WHERE id = $1 AND user_id = $2 AND document_id = $3`,
    [exportId, ctx.user.id, id]);
  if (!row) throw notFound();
  if (row.status !== "READY_TO_RENDER") throw transition("export result already recorded");
  const result = exportResultOf({
    sha256: values.sha256, byteLength: values.byteLength, pageCount: values.pageCount ?? null,
    validation: { koreanText: validation.koreanText === true, links: validation.links === true, atsText: validation.atsText === true },
    errorCode: values.errorCode ?? null,
  });
  const now = ts(ctx.now);
  await query(ctx.deps.query, "UPDATE document_exports SET status = $2, result = $3::jsonb, updated_at = $4 WHERE id = $1",
    [exportId, status, JSON.stringify(result), now]);
  return data(200, exportDto({ ...row, status, result, updated_at: now }), ctx.rid);
};

export const isDocumentEdit = (method: string, path: string): boolean =>
  method === "POST" && /^\/api\/v1\/documents\/[^/]+\/edits$/.test(path);

export const dispatchDocuments = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === "/api/v1/documents") {
    if (method === "GET") return listDocuments(ctx);
    if (method === "POST") return createDocument(ctx);
    return null;
  }
  const versions = path.match(/^\/api\/v1\/documents\/([^/]+)\/versions(?:\/([^/]+))?$/);
  if (versions) {
    if (!versions[2] && method === "GET") return listVersions(ctx, versions[1]);
    if (!versions[2] && method === "POST") return createVersion(ctx, versions[1]);
    if (versions[2] && method === "GET") return getVersion(ctx, versions[1], versions[2]);
    return null;
  }
  const apply = path.match(/^\/api\/v1\/documents\/([^/]+)\/revisions\/([^/]+)\/apply$/);
  if (apply && method === "POST") return applyRevision(ctx, apply[1], apply[2]);
  const result = path.match(/^\/api\/v1\/documents\/([^/]+)\/exports\/([^/]+)\/result$/);
  if (result && method === "POST") return recordExportResult(ctx, result[1], result[2]);
  const m = path.match(/^\/api\/v1\/documents\/([^/]+)(?:\/(edits|review|finalize|archive|exports))?$/);
  if (!m) return null;
  const [, id, sub] = m;
  if (!sub && method === "GET") return getDocument(ctx, id);
  if (!sub && method === "PATCH") return patchDocument(ctx, id);
  if (sub === "edits" && method === "POST") return applyEdits(ctx, id);
  if (sub === "review" && method === "POST") return reviewDocument(ctx, id);
  if (sub === "finalize" && method === "POST") return finalizeDocument(ctx, id);
  if (sub === "archive" && method === "POST") return archiveDocument(ctx, id);
  if (sub === "exports" && method === "GET") return listExports(ctx, id);
  if (sub === "exports" && method === "POST") return createExport(ctx, id);
  return null;
};
