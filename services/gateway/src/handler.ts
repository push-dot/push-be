/**
 * Gateway request pipeline.
 *
 * index.ts is the Worker entry. This module dispatches the routes the
 * gateway answers itself and forwards AI routes to AI_ORIGIN.
 */

import type { Deps, FrontEnv } from "./types.ts";
import { errorResponse, fieldError, parseUuid, preflight, requestIdOf, withCors } from "./http.ts";
import { authMe } from "./routes/auth.ts";
import { health } from "./routes/health.ts";
import {
  getConversation, isBotThread, listConversations, listMessages, streamActive, streamBotActive, streamBotCancel,
  streamCancel, streamMessage,
} from "./routes/conversations.ts";
import { aiModels, jobSites } from "./routes/catalog.ts";
import { ownerOf } from "./routes/owner.ts";
import { invalidateAfterWrite, isInternalCall, proxy, proxyPython } from "./routes/proxy.ts";

export type { Deps, FrontEnv, Query } from "./types.ts";
export { releaseExpired, resetLimits } from "./middleware/ratelimit.ts";

export async function handle(request: Request, env: FrontEnv, deps: Deps): Promise<Response> {
  const rid = requestIdOf(request);
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return errorResponse(400, "VALIDATION_ERROR", "invalid url", rid);
  }
  const path = url.pathname;
  if (request.method === "OPTIONS") {
    try {
      return withCors(request, preflight(request));
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
  try {
    const response = await route(request, env, deps, url, path, rid);
    return withCors(request, response);
  } catch {
    try {
      return withCors(request, errorResponse(500, "INTERNAL", "internal error", rid));
    } catch {
      return errorResponse(500, "INTERNAL", "internal error", rid);
    }
  }
}

async function route(request: Request, env: FrontEnv, deps: Deps, url: URL, path: string, rid: string): Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const limits = deps.limits ?? { user: 600, public: 60, windowMs: 60_000 };
  if (request.method === "GET" && (path === "/healthz" || path === "/api/v1/healthz")) {
    return health(request, deps, path, rid, limits, now);
  }
  if (request.method === "GET" && path === "/api/v1/auth/me") {
    return authMe(request, env, deps, rid, limits, now);
  }
  // A bot's thread is stored as a conversation and is not one to any client. Every route under
  // /conversations/{id}, in this worker, core and the AI service, is reached through here, so the
  // rule sits here once. An id this parser cannot read goes no further: the AI service reads other
  // spellings of one id, such as {…} and urn:uuid:…, and the probe below would not see them.
  const named = path.match(/^\/api\/v1\/conversations\/([^/]+)/);
  if (named && named[1] !== "shared") {
    const conversationId = parseUuid(named[1]);
    if (!conversationId) return fieldError("id", "must be a UUID", rid);
    if (await isBotThread(deps, conversationId)) return errorResponse(404, "NOT_FOUND", "resource not found", rid);
  }
  if (request.method === "GET" && path === "/api/v1/conversations") {
    return listConversations(request, env, deps, url, rid, limits, now);
  }
  const one = path.match(/^\/api\/v1\/conversations\/([^/]+)$/);
  if (request.method === "GET" && one) {
    return getConversation(request, env, deps, one[1], rid, limits, now);
  }
  const messages = path.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/);
  if (request.method === "GET" && messages) {
    return listMessages(request, env, deps, url, messages[1], rid, limits, now);
  }
  const active = path.match(/^\/api\/v1\/conversations\/([^/]+)\/messages\/stream\/active$/);
  if (request.method === "GET" && active) {
    return streamActive(request, env, deps, url, active[1], rid, limits, now);
  }
  if (request.method === "POST" && /^\/api\/v1\/conversations\/[^/]+\/messages\/stream$/.test(path)) {
    return streamMessage(request, env, deps, rid);
  }
  const cancel = path.match(/^\/api\/v1\/conversations\/([^/]+)\/stream\/cancel$/);
  if (request.method === "POST" && cancel) {
    return streamCancel(request, env, deps, cancel[1], rid, limits, now);
  }
  if (request.method === "POST" && /^\/api\/v1\/bots\/[^/]+\/messages\/stream$/.test(path)) {
    return streamMessage(request, env, deps, rid, true);
  }
  const botStream = path.match(/^\/api\/v1\/bots\/([^/]+)\/stream$/);
  if (request.method === "GET" && botStream) {
    return streamBotActive(request, env, deps, url, botStream[1], rid, limits, now);
  }
  const botCancel = path.match(/^\/api\/v1\/bots\/([^/]+)\/stream\/cancel$/);
  if (request.method === "POST" && botCancel) {
    return streamBotCancel(request, env, deps, botCancel[1], rid, limits, now);
  }
  if (request.method === "GET" && path === "/api/v1/ai/models") {
    return aiModels(request, env, deps, url, rid, limits, now);
  }
  if (request.method === "GET" && path === "/api/v1/integrations/job-sites") {
    return jobSites(request, env, deps, rid, limits, now);
  }
  const owner = ownerOf(request.method, path);
  if (owner === "deny") return errorResponse(404, "NOT_FOUND", "resource not found", rid);
  const proxied = owner === "core"
    ? await proxy(request, env.CORE, rid, await isInternalCall(request, env))
    : await proxyPython(request, env, deps, rid);
  if (proxied.status >= 200 && proxied.status < 300) {
    const method = request.method;
    if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
      await invalidateAfterWrite(request, path, deps);
    }
  }
  return proxied;
}
