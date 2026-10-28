import { isMissingRelation, isUndefinedColumn, one, query } from "../db.ts";
import { queryForms, searchFields } from "../hangul.ts";
import { asBool, codePoints, data, fieldError, jsonList, pageBody, requireUuid } from "../http.ts";
import { pageOf, pageResult, ts } from "../page.ts";
import type { Ctx } from "../types.ts";
import {
  unprocessable,
  notFound,
  readObject,
  rejectFields,
  textOf,
  imageKeyOf,
  imageUrl,
  countWhere,
  relevance,
  NOT_DELETING,
  notify,
} from "./recruiting-shared.ts";

const POST_CATEGORIES = new Set(["work", "dev", "daily", "career", "talk", "coffeechat", "marketing"]);

function appendTextSearch(sql: string, params: unknown[], q: string, columns: string[]): string {
  if (!q) return sql;
  if (codePoints(q) > 200) throw fieldError("q", "must be at most 200 characters");
  const forms = queryForms(q);
  params.push(forms.raw, forms.choseong, forms.jamo, forms.hangul, forms.hangulJamo);
  const raw = params.length - 4;
  const cho = params.length - 3;
  const jamo = params.length - 2;
  const hangul = params.length - 1;
  const hangulJamo = params.length;
  const parts = columns.map((column) => `${column} ILIKE '%' || $${raw} || '%'`).join(" OR ");
  const hangulParts = columns.map((column) => `${column} ILIKE '%' || $${hangul} || '%'`).join(" OR ");
  sql += ` AND ((${parts})
    OR ($${cho} <> '' AND search_choseong LIKE '%' || $${cho} || '%')
    OR ($${jamo} <> '' AND search_jamo LIKE $${jamo} || '%')
    OR ($${hangul} <> '' AND ((${hangulParts}) OR search_jamo LIKE $${hangulJamo} || '%')))`;
  return sql;
}

function postDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    author: {
      id: String(row.user_id ?? ""),
      displayName: String(row.display_name ?? ""),
      employer: asBool(row.is_employer),
      companyName: row.company_name == null || row.company_name === "" ? null : String(row.company_name),
    },
    category: String(row.category ?? ""),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    imageUrls: jsonList(row.image_keys).map((key) => imageUrl(key)).filter((url) => url != null),
    commentCount: Number(row.comment_count ?? 0),
    viewCount: Number(row.view_count ?? 0),
    createdAt: ts(row.created_at),
  };
}

const POST_SQL = `p.id, p.user_id, u.display_name, u.is_employer, co.name AS company_name, p.category, p.title, p.body, p.image_keys, p.view_count, p.created_at,
  (SELECT count(*)::int FROM post_comments c WHERE c.post_id = p.id) AS comment_count
  FROM posts p JOIN users u ON u.id = p.user_id AND ${NOT_DELETING}
  LEFT JOIN company_members cm ON cm.user_id = u.id
  LEFT JOIN companies co ON co.id = cm.company_id`;

const withoutCompanyJoin = (sql: string): string => sql
  .replaceAll("co.name AS company_name", "NULL::text AS company_name")
  .replaceAll(" LEFT JOIN company_members cm ON cm.user_id = u.id", "")
  .replaceAll(" LEFT JOIN companies co ON co.id = cm.company_id", "");

const queryPosts = async (ctx: Ctx, sql: string, params: unknown[]) => {
  try {
    return await query(ctx.deps.query, sql, params);
  } catch (err) {
    if (!sql.includes("company_members") || !(isMissingRelation(err) || isUndefinedColumn(err))) throw err;
    const fallback = withoutCompanyJoin(sql);
    if (fallback === sql || fallback.includes("company_members") || fallback.includes("companies")) throw err;
    return query(ctx.deps.query, fallback, params);
  }
};

const onePost = async (ctx: Ctx, sql: string, params: unknown[]) => {
  const result = await queryPosts(ctx, sql, params);
  return result.rows[0] ?? null;
};

async function listPosts(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const sort = ctx.url.searchParams.get("sort") || "latest";
  if (sort !== "latest" && sort !== "popular") throw unprocessable("sort", "unsupported sort");
  const period = ctx.url.searchParams.get("period") || "";
  if (period !== "" && period !== "week") throw unprocessable("period", "unsupported period");
  const category = ctx.url.searchParams.get("category");
  if (category && !POST_CATEGORIES.has(category)) throw unprocessable("category", "unsupported category");
  const params: unknown[] = [];
  let sql = "SELECT " + POST_SQL + " WHERE 1=1";
  if (category) {
    params.push(category);
    sql += ` AND p.category = $${params.length}`;
  }
  const q = ctx.url.searchParams.get("q") || "";
  sql = appendTextSearch(sql, params, q, ["p.title", "p.body"]);
  if (period === "week") {
    params.push(new Date(ctx.now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
    sql += ` AND p.created_at >= $${params.length}::timestamptz`;
  }
  // shortcut: popular ignores the cursor; (created_at, id) is not its rank
  if (sort === "latest" && page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  const order = sort === "popular" ? "p.view_count DESC, p.created_at DESC, p.id DESC" : "p.created_at DESC, p.id DESC";
  sql += ` ORDER BY ${order} LIMIT $${params.length}`;
  const rows = await queryPosts(ctx, sql, params);
  const mapped = rows.rows.map((row) => ({ item: postDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

export async function searchPosts(ctx: Ctx, q: string): Promise<Response> {
  const page = pageOf(ctx.url);
  const forms = queryForms(q);
  const params: unknown[] = [forms.raw, forms.choseong, forms.jamo, forms.hangul, forms.hangulJamo];
  let sql = `SELECT ${POST_SQL} WHERE (
      p.title ILIKE '%' || $1 || '%' OR p.body ILIKE '%' || $1 || '%'
      OR ($2 <> '' AND p.search_choseong LIKE '%' || $2 || '%')
      OR ($3 <> '' AND p.search_jamo LIKE $3 || '%')
      OR ($4 <> '' AND (p.title ILIKE '%' || $4 || '%' OR p.body ILIKE '%' || $4 || '%' OR p.search_jamo LIKE $5 || '%'))
    )`;
  const total = await countWhere(ctx, sql, " FROM posts p", params.slice());
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY ${relevance("p.title", "p.body", "$1", "$2", "$4")}, p.created_at DESC, p.id DESC LIMIT $${params.length}`;
  const rows = await queryPosts(ctx, sql, params);
  const mapped = rows.rows.map((row) => ({ item: postDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid, total);
}

async function createPost(ctx: Ctx): Promise<Response> {
  const body = await readObject(ctx.request);
  rejectFields(body, ["userId", "createdAt", "id", "viewCount", "author"]);
  if (typeof body.category !== "string" || !POST_CATEGORIES.has(body.category)) {
    throw unprocessable("category", "unsupported category");
  }
  const title = textOf(body.title, "title", 1, 100);
  const text = textOf(body.body, "body", 1, 5000);
  const imageKeys = body.imageKeys == null ? [] : body.imageKeys;
  if (!Array.isArray(imageKeys) || imageKeys.length > 4) throw fieldError("imageKeys", "at most 4 images");
  const keys = imageKeys.map((key) => imageKeyOf(key, "imageKeys")).filter((key): key is string => key != null);
  const fields = searchFields(`${title}\n${text}`);
  const id = crypto.randomUUID();
  const now = ctx.now.toISOString();
  await query(ctx.deps.query,
    `INSERT INTO posts (id, user_id, category, title, body, image_keys, view_count, search_text, search_choseong, search_jamo, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,0,$7,$8,$9,$10)`,
    [id, ctx.user.id, body.category, title, text, JSON.stringify(keys), fields.text, fields.choseong, fields.jamo, now]);
  const author = await onePost(ctx,
    `SELECT u.is_employer, co.name AS company_name FROM users u
     LEFT JOIN company_members cm ON cm.user_id = u.id
     LEFT JOIN companies co ON co.id = cm.company_id WHERE u.id = $1`,
    [ctx.user.id]);
  return data(201, postDto({
    id, user_id: ctx.user.id, display_name: ctx.user.displayName, category: body.category, title, body: text,
    image_keys: keys, view_count: 0, comment_count: 0, created_at: now,
    is_employer: author ? author.is_employer : ctx.user.accountType === "EMPLOYER",
    company_name: author?.company_name ?? null,
  }), ctx.rid);
}

async function getPost(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const row = await one(ctx.deps.query,
    `UPDATE posts SET view_count = view_count + 1 WHERE id = $1 RETURNING id`,
    [id]);
  if (!row) throw notFound();
  const full = await onePost(ctx, "SELECT " + POST_SQL + " WHERE p.id = $1", [id]);
  if (!full) throw notFound();
  return data(200, postDto(full), ctx.rid);
}

async function listComments(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const post = await one(ctx.deps.query, "SELECT id FROM posts WHERE id = $1", [id]);
  if (!post) throw notFound();
  const page = pageOf(ctx.url);
  const params: unknown[] = [id];
  let sql = `SELECT c.id, c.user_id, u.display_name, c.body, c.created_at, to_jsonb(c) ->> 'parent_id' AS parent_id
    FROM post_comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = $1`;
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (c.created_at, c.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY c.created_at DESC, c.id DESC LIMIT $${params.length}`;
  const rows = await query(ctx.deps.query, sql, params);
  const mapped = rows.rows.map((row) => ({
    item: {
      id: String(row.id),
      author: { id: String(row.user_id), displayName: String(row.display_name ?? "") },
      body: String(row.body ?? ""),
      parentId: row.parent_id == null || row.parent_id === "" ? null : String(row.parent_id),
      createdAt: ts(row.created_at),
    },
    createdAt: row.created_at,
    id: String(row.id),
  }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid);
}

async function createComment(ctx: Ctx, idRaw: string): Promise<Response> {
  const id = requireUuid(idRaw, "id");
  const post = await one(ctx.deps.query, "SELECT id, user_id, title FROM posts WHERE id = $1", [id]);
  if (!post) throw notFound();
  const body = await readObject(ctx.request);
  const text = textOf(body.body, "body", 1, 1000);
  let parentId: string | null = null;
  let parentAuthor = "";
  if (body.parentId != null && body.parentId !== "") {
    parentId = requireUuid(String(body.parentId), "parentId");
    const parent = await one(ctx.deps.query,
      "SELECT id, user_id FROM post_comments WHERE id = $1 AND post_id = $2",
      [parentId, id]);
    if (!parent) throw notFound();
    parentAuthor = String(parent.user_id);
  }
  const commentId = crypto.randomUUID();
  const now = ctx.now.toISOString();
  try {
    await query(ctx.deps.query,
      "INSERT INTO post_comments (id, post_id, user_id, body, created_at, parent_id) VALUES ($1,$2,$3,$4,$5,$6)",
      [commentId, id, ctx.user.id, text, now, parentId]);
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    await query(ctx.deps.query,
      "INSERT INTO post_comments (id, post_id, user_id, body, created_at) VALUES ($1,$2,$3,$4,$5)",
      [commentId, id, ctx.user.id, text, now]);
  }
  await notify(ctx, String(post.user_id), "COMMENT", "새 댓글", text, { kind: "post", id });
  if (parentAuthor) await notify(ctx, parentAuthor, "COMMENT", "답글을 남겼어요", text, { kind: "post", id });
  return data(201, {
    id: commentId,
    author: { id: ctx.user.id, displayName: ctx.user.displayName },
    body: text,
    parentId,
    createdAt: ts(now),
  }, ctx.rid);
}

async function listMyPosts(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  let sql = "SELECT " + POST_SQL + " WHERE p.user_id = $1";
  const total = await countWhere(ctx, sql, " FROM posts p", params.slice());
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`;
  const rows = await queryPosts(ctx, sql, params);
  const mapped = rows.rows.map((row) => ({ item: postDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid, total);
}

async function listCommentedPosts(ctx: Ctx): Promise<Response> {
  const page = pageOf(ctx.url);
  const params: unknown[] = [ctx.user.id];
  let sql = `SELECT ${POST_SQL}
    WHERE p.id IN (SELECT post_id FROM post_comments WHERE user_id = $1)`;
  const total = await countWhere(ctx, sql, " FROM posts p", params.slice());
  if (page.cursor) {
    params.push(page.cursor.createdAt, page.cursor.id);
    sql += ` AND (p.created_at, p.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(page.limit + 1);
  sql += ` ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`;
  const rows = await queryPosts(ctx, sql, params);
  const mapped = rows.rows.map((row) => ({ item: postDto(row), createdAt: row.created_at, id: String(row.id) }));
  const paged = pageResult(mapped, page.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  return pageBody(paged.items.map((row) => row.item), paged.nextCursor, paged.hasMore, ctx.rid, total);
}

export const dispatchPosts = async (ctx: Ctx, path: string): Promise<Response | null> => {
  const method = ctx.request.method;
  if (path === "/api/v1/me/posts" && method === "GET") return listMyPosts(ctx);
  if (path === "/api/v1/me/commented-posts" && method === "GET") return listCommentedPosts(ctx);
  if (path === "/api/v1/posts" && method === "GET") return listPosts(ctx);
  if (path === "/api/v1/posts" && method === "POST") return createPost(ctx);
  const comments = path.match(/^\/api\/v1\/posts\/([^/]+)\/comments$/);
  if (comments && method === "GET") return listComments(ctx, comments[1]);
  if (comments && method === "POST") return createComment(ctx, comments[1]);
  const post = path.match(/^\/api\/v1\/posts\/([^/]+)$/);
  if (post && method === "GET") return getPost(ctx, post[1]);
  return null;
};
