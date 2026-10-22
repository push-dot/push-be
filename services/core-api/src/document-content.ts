import { HttpError, fieldError } from "./http.ts";

/** TipTap document rules and edit helpers, ported from services/ai app/domain/content.py and document.py. */

export type EvidenceRef = { evidenceId: string; start: number; end: number };
export type Block = { id: string; text: string; evidenceRefs: EvidenceRef[]; claimStatus: string };
export type QualityIssue = { code: string; severity: string; blockId?: string; message: string };
export type Quality = {
  jobFit: number | null;
  evidenceFidelity: number | null;
  readability: number | null;
  ats: number | null;
  method: string;
  issues: QualityIssue[];
};

type Node = Record<string, unknown>;

const ALLOWED = new Set(["doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "text"]);
const BLOCK_NODES = new Set(["paragraph", "heading", "listItem"]);

const plain = (message: string): HttpError => new HttpError(400, "VALIDATION_ERROR", message);
const children = (n: Node): Node[] => (Array.isArray(n.content) ? n.content as Node[] : []);
const isObject = (v: unknown): v is Node => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Python `urlparse` checks from `_validate_url`. */
const validateUrl = (raw: string): void => {
  const scheme = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)?.[1].toLowerCase();
  if (scheme !== "http" && scheme !== "https") throw plain("url must be http(s)");
  const rest = raw.slice(scheme.length + 1);
  const netloc = rest.startsWith("//") ? rest.slice(2).split(/[/?#]/, 1)[0] : "";
  const at = netloc.lastIndexOf("@");
  if (at >= 0) {
    const [user, ...pass] = netloc.slice(0, at).split(":");
    if (user || pass.join(":")) throw plain("url must not contain credentials");
  }
  const hostPort = at >= 0 ? netloc.slice(at + 1) : netloc;
  const host = hostPort.startsWith("[") ? hostPort.slice(1, hostPort.indexOf("]")) : hostPort.split(":")[0];
  if (!host) throw plain("url must have a host");
};

export const nodeText = (n: Node): string => String(n.text ?? "") + children(n).map(nodeText).join("");

const walk = (n: Node, extracted: Map<string, string>, order: string[]): void => {
  const type = n.type;
  if (typeof type !== "string" || !ALLOWED.has(type)) throw fieldError("content", "unsupported node type " + (type == null ? "None" : String(type)));
  for (const m of Array.isArray(n.marks) ? n.marks as Node[] : []) {
    if (m.type !== "link") throw fieldError("content", "unsupported mark type " + (m.type == null ? "None" : String(m.type)));
    const href = isObject(m.attrs) ? m.attrs.href : undefined;
    if (typeof href !== "string" || !href) throw fieldError("content", "link mark requires href");
    validateUrl(href);
  }
  if (BLOCK_NODES.has(type)) {
    const attrs = n.attrs;
    if (!isObject(attrs) || !attrs.blockId) throw fieldError("content", `block node of type ${type} requires attrs.blockId`);
    const bid = String(attrs.blockId);
    if (extracted.has(bid)) throw fieldError("content", "duplicate blockId " + bid);
    extracted.set(bid, nodeText(n));
    order.push(bid);
  }
  for (const c of children(n)) walk(c, extracted, order);
};

export const validateDocumentContent = (content: unknown, blocks: Block[]): void => {
  if (!isObject(content)) throw plain("content must be valid TipTap JSON");
  if (content.type !== "doc") throw fieldError("content", "root node must be doc");
  const extracted = new Map<string, string>();
  const order: string[] = [];
  walk(content, extracted, order);
  const seen = new Set<string>();
  for (const b of blocks) {
    if (!b.id) throw fieldError("blocks", "block id is required");
    if (seen.has(b.id)) throw fieldError("blocks", "duplicate block id " + b.id);
    seen.add(b.id);
    if (!extracted.has(b.id)) throw fieldError("blocks", "block " + b.id + " has no matching content node");
    if (extracted.get(b.id) !== b.text) throw fieldError("blocks", "block " + b.id + " text does not match content node text");
  }
  for (const bid of order) if (!seen.has(bid)) throw fieldError("content", "content node " + bid + " has no matching block");
};

/** `code_point_slice`: None (null) when the range is empty or out of bounds. */
export const codePointSlice = (s: string, start: number, end: number): string | null => {
  const points = Array.from(s);
  if (start < 0 || end < 0 || start >= end) return null;
  if (end > points.length || start >= points.length) return null;
  return points.slice(start, end).join("");
};

export const computeQuality = (blocks: Block[]): Quality => {
  const issues: QualityIssue[] = [];
  let unsupported = 0;
  for (const b of blocks) {
    if (b.claimStatus === "UNSUPPORTED") {
      unsupported += 1;
      issues.push({ code: "UNSUPPORTED_CLAIM", severity: "ERROR", blockId: b.id, message: "block has no evidence references" });
    } else if (b.claimStatus === "NEEDS_REVIEW") {
      issues.push({ code: "NEEDS_REVIEW", severity: "WARN", blockId: b.id, message: "evidence span does not literally appear in block text" });
    }
  }
  const fidelity = blocks.length ? Math.floor(((blocks.length - unsupported) * 100) / blocks.length) : null;
  return { jobFit: null, evidenceFidelity: fidelity, readability: null, ats: null, method: "RULE_BASED", issues };
};

/** `hunk_edits`: diff hunks to (old, new) text replacements. */
export const hunkEdits = (hunks: unknown[]): [string, string][] => {
  const edits: [string, string][] = [];
  let anchor: string | null = null;
  let removed: string[] = [];
  let added: string[] = [];
  const flush = (): void => {
    if (removed.length) edits.push([removed.join("\n"), added.join("\n")]);
    else if (added.length) {
      if (anchor === null) throw fieldError("hunks", "an added line needs a context line before it");
      edits.push([anchor, anchor + "\n" + added.join("\n")]);
    }
    removed = [];
    added = [];
  };
  for (const raw of hunks) {
    const hunk = isObject(raw) ? raw : {};
    const sign = hunk.sign ? String(hunk.sign) : "";
    const text = hunk.text ? String(hunk.text) : "";
    if (sign === "-") {
      if (added.length) flush();
      removed.push(text);
    } else if (sign === "+") {
      added.push(text);
    } else {
      flush();
      anchor = text;
    }
  }
  flush();
  return edits;
};

const replaceInNode = (n: Node, old: string, next: string, state: { applied: boolean }): void => {
  if (state.applied) return;
  if (n.type === "text" && String(n.text ?? "").includes(old)) {
    n.text = String(n.text).replace(old, () => next);
    state.applied = true;
    return;
  }
  for (const c of children(n)) replaceInNode(c, old, next, state);
};

/** `_replaced`: apply edits to a copy of the content and blocks. */
export const replaced = (content: unknown, blocks: Block[], edits: [string, string][]): { content: Node; blocks: Block[]; applied: boolean } => {
  const copy = structuredClone(content) as Node;
  const copied = structuredClone(blocks);
  for (const [old, next] of edits) {
    const state = { applied: false };
    replaceInNode(copy, old, next, state);
    if (!state.applied) return { content: copy, blocks: copied, applied: false };
    for (const b of copied) if (b.text.includes(old)) b.text = b.text.replace(old, () => next);
  }
  return { content: copy, blocks: copied, applied: edits.length > 0 };
};

/** Blocks as Python's `Block` model reads them back from jsonb. */
export const blocksOf = (value: unknown): Block[] => (Array.isArray(value) ? value : []).map((raw) => {
  const b = isObject(raw) ? raw : {};
  const refs = (Array.isArray(b.evidenceRefs ?? b.evidence_refs) ? (b.evidenceRefs ?? b.evidence_refs) as unknown[] : []).map((r) => {
    const ref = isObject(r) ? r : {};
    return { evidenceId: String(ref.evidenceId ?? ref.evidence_id), start: Number(ref.start), end: Number(ref.end) };
  });
  return { id: String(b.id ?? ""), text: String(b.text ?? ""), evidenceRefs: refs, claimStatus: String(b.claimStatus ?? b.claim_status ?? "") };
});

const nullable = (value: unknown): number | null => (value == null ? null : Number(value));

/** `Quality` as Python's model reads it back from jsonb (issue `blockId` dropped when null). */
export const qualityOf = (value: unknown): Quality => {
  const q = isObject(value) ? value : {};
  const issues = (Array.isArray(q.issues) ? q.issues : []).map((raw) => {
    const i = isObject(raw) ? raw : {};
    const blockId = i.blockId ?? i.block_id;
    return { code: String(i.code), severity: String(i.severity), ...(blockId == null ? {} : { blockId: String(blockId) }), message: String(i.message) };
  });
  return {
    jobFit: nullable(q.jobFit ?? q.job_fit),
    evidenceFidelity: nullable(q.evidenceFidelity ?? q.evidence_fidelity),
    readability: nullable(q.readability),
    ats: nullable(q.ats),
    method: String(q.method ?? "RULE_BASED"),
    issues,
  };
};
