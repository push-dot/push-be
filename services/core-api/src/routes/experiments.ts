import { strictBody } from "../body.ts";
import { one, query } from "../db.ts";
import { HttpError, data, fieldError } from "../http.ts";
import { ts } from "../page.ts";
import type { Ctx } from "../types.ts";

type Experiment = { key: string; variants: string[]; status: string; exclusionGroup: string };

const sha256Int = async (text: string): Promise<bigint> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return BigInt("0x" + [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""));
};

const pickBy = async (text: string, items: string[]): Promise<string> =>
  items[Number((await sha256Int(text)) % BigInt(items.length))];

const loadExperiment = async (ctx: Ctx, key: string): Promise<Experiment> => {
  const row = await one(ctx.deps.query, "SELECT key, variants, status, exclusion_group FROM experiments WHERE key = $1", [key]);
  if (!row) throw new HttpError(404, "NOT_FOUND", "resource not found");
  const variants = Array.isArray(row.variants) ? row.variants.map(String) : [];
  if (!variants.length) throw fieldError("variants", "must be non-empty");
  return { key: String(row.key), variants, status: String(row.status), exclusionGroup: String(row.exclusion_group ?? "") };
};

const enrolled = async (ctx: Ctx, key: string, group: string): Promise<boolean> => {
  const rows = await query(ctx.deps.query, "SELECT key FROM experiments WHERE exclusion_group = $1 ORDER BY key", [group]);
  const keys = rows.rows.map((row) => String(row.key));
  if (!keys.includes(key)) return true;
  return (await pickBy(`${ctx.user.id}:${group}`, keys)) === key;
};

type Assignment = { experimentKey: string; variant: string; enrolled: boolean; createdAt: string | null };

const assignmentFor = async (ctx: Ctx, key: string): Promise<Assignment> => {
  const exp = await loadExperiment(ctx, key);
  const now = ts(ctx.now);
  if (exp.status === "ended") return { experimentKey: key, variant: exp.variants[0], enrolled: true, createdAt: now };
  if (exp.exclusionGroup && !(await enrolled(ctx, key, exp.exclusionGroup))) {
    return { experimentKey: key, variant: exp.variants[0], enrolled: false, createdAt: now };
  }
  const select = "SELECT experiment_key, variant, created_at FROM experiment_assignments WHERE experiment_key = $1 AND user_id = $2";
  let row = await one(ctx.deps.query, select, [key, ctx.user.id]);
  if (!row) {
    await query(ctx.deps.query,
      "INSERT INTO experiment_assignments (experiment_key, user_id, variant, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [key, ctx.user.id, await pickBy(`${ctx.user.id}:${key}`, exp.variants), now]);
    row = await one(ctx.deps.query, select, [key, ctx.user.id]);
    if (!row) throw new HttpError(500, "INTERNAL", "internal error");
  }
  return { experimentKey: String(row.experiment_key), variant: String(row.variant), enrolled: true, createdAt: ts(row.created_at) };
};

export const getAssignment = async (ctx: Ctx, key: string): Promise<Response> => data(200, await assignmentFor(ctx, key), ctx.rid);

export const recordEvent = async (ctx: Ctx, key: string): Promise<Response> => {
  const { values } = await strictBody(ctx.request, { event: { kind: "str", required: true } });
  const event = String(values.event);
  const length = Array.from(event).length;
  if (length < 1 || length > 100) throw fieldError("event", "must be 1-100 characters");
  const assignment = await assignmentFor(ctx, key);
  if (assignment.enrolled) {
    await query(ctx.deps.query,
      "INSERT INTO experiment_events (id, experiment_key, user_id, variant, event, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [crypto.randomUUID(), key, ctx.user.id, assignment.variant, event, ts(ctx.now)]);
  }
  return data(201, { recorded: true }, ctx.rid);
};

export const experimentStats = async (ctx: Ctx, key: string): Promise<Response> => {
  const exp = await loadExperiment(ctx, key);
  const rows = await query(ctx.deps.query,
    "SELECT variant, event, COUNT(*) AS n FROM experiment_events WHERE experiment_key = $1 GROUP BY variant, event", [key]);
  const counts: Record<string, Record<string, number>> = {};
  for (const row of rows.rows) (counts[String(row.variant)] ||= {})[String(row.event)] = Number(row.n);
  return data(200, {
    key, status: exp.status, variants: Object.fromEntries(exp.variants.map((v) => [v, counts[v] ?? {}])),
  }, ctx.rid);
};

export const experimentResults = async (ctx: Ctx, key: string): Promise<Response> => {
  const exp = await loadExperiment(ctx, key);
  const rows = await query(ctx.deps.query,
    "SELECT variant, COUNT(DISTINCT user_id) FILTER (WHERE event = 'exposure') AS exposed, COUNT(DISTINCT user_id) FILTER (WHERE event = 'conversion') AS converted FROM experiment_events WHERE experiment_key = $1 GROUP BY variant",
    [key]);
  const counts = new Map(rows.rows.map((row) => [String(row.variant), row]));
  return data(200, {
    key,
    status: exp.status,
    variants: exp.variants.map((variant) => {
      const exposed = Number(counts.get(variant)?.exposed ?? 0);
      const converted = Number(counts.get(variant)?.converted ?? 0);
      return { variant, exposed, converted, rate: exposed ? converted / exposed : 0 };
    }),
  }, ctx.rid);
};

export const dispatchExperiments = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const m = path.match(/^\/api\/v1\/experiments\/([^/]+)\/(assignment|events|stats|results)$/);
  if (!m) return null;
  const key = decodeURIComponent(m[1]);
  const method = ctx.request.method;
  if (m[2] === "assignment" && method === "GET") return getAssignment(ctx, key);
  if (m[2] === "events" && method === "POST") return recordEvent(ctx, key);
  if (m[2] === "stats" && method === "GET") return experimentStats(ctx, key);
  if (m[2] === "results" && method === "GET") return experimentResults(ctx, key);
  return null;
};
