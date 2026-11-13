import { isMissingRelation, isUndefinedColumn, query } from "../db.ts";
import { HttpError, codePoints, data, fieldError } from "../http.ts";
import type { Ctx } from "../types.ts";
import { GUEST_ID, unprocessable, searchSortMode } from "./recruiting-shared.ts";
import { skillRows, searchPostings } from "./postings.ts";
import { searchPeople } from "./profiles.ts";
import { searchPosts } from "./posts.ts";

const recordSearch = async (ctx: Ctx, term: string): Promise<void> => {
  const trimmed = term.trim();
  if (!trimmed) return;
  try {
    await query(ctx.deps.query,
      "INSERT INTO search_queries (id, term, created_at) VALUES ($1,$2,$3)",
      [crypto.randomUUID(), trimmed.slice(0, 200), ctx.now.toISOString()]);
  } catch (err) {
    if (!isMissingRelation(err) && !isUndefinedColumn(err)) throw err;
  }
};

async function search(ctx: Ctx): Promise<Response> {
  const q = ctx.url.searchParams.get("q") || "";
  if (!q.trim()) throw fieldError("q", "required");
  const type = ctx.url.searchParams.get("type") || "postings";
  if (type !== "postings" && type !== "people" && type !== "posts") throw unprocessable("type", "unsupported type");
  if (ctx.user.id === GUEST_ID && (type === "people" || type === "posts")) {
    throw new HttpError(401, "UNAUTHENTICATED", "missing bearer token");
  }
  searchSortMode(ctx.url);
  await recordSearch(ctx, q);
  if (type === "people") return searchPeople(ctx, q);
  if (type === "posts") return searchPosts(ctx, q);
  return searchPostings(ctx, q);
}

// A tab count is the `page.total` of the list behind that tab, so a count and its list can never disagree.
const listTotal = async (ctx: Ctx, list: (ctx: Ctx, q: string) => Promise<Response>, q: string): Promise<number> => {
  const url = new URL("/api/v1/search", ctx.url);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "1");
  const body = await (await list({ ...ctx, url }, q)).json() as { page: { total?: number } };
  return Number(body.page.total ?? 0);
};

const searchCounts = async (ctx: Ctx): Promise<Response> => {
  const q = ctx.url.searchParams.get("q") || "";
  if (!q.trim()) throw fieldError("q", "required");
  if (codePoints(q) > 200) throw fieldError("q", "must be at most 200 characters");
  const guest = ctx.user.id === GUEST_ID;
  const [postings, people, posts] = await Promise.all([
    listTotal(ctx, searchPostings, q),
    guest ? 0 : listTotal(ctx, searchPeople, q),
    guest ? 0 : listTotal(ctx, searchPosts, q),
  ]);
  return data(200, { postings, people, posts }, ctx.rid);
};

const searchTrending = async (ctx: Ctx): Promise<Response> => {
  let terms: { term: string; count: number }[] = [];
  try {
    const since = new Date(ctx.now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = await query(ctx.deps.query,
      "SELECT term, count(*)::int AS count FROM search_queries WHERE created_at >= $1::timestamptz GROUP BY term ORDER BY count DESC, term ASC LIMIT 8",
      [since]);
    terms = rows.rows.map((row) => ({ term: String(row.term ?? ""), count: Number(row.count ?? 0) }));
  } catch (err) {
    if (!isMissingRelation(err) && !isUndefinedColumn(err)) throw err;
  }
  const skills = await skillRows(ctx, false);
  return data(200, { terms, skills }, ctx.rid);
};

export const dispatchSearch = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (method === "GET" && path === "/api/v1/search/counts") return searchCounts(ctx);
  if (method === "GET" && path === "/api/v1/search/trending") return searchTrending(ctx);
  if (method === "GET" && path === "/api/v1/search") return search(ctx);
  return null;
};
