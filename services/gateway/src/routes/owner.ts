/**
 * Which worker answers a path the gateway does not handle itself.
 * `core` is push-be-core. `python` keeps AI work and the CRUD that
 * has not moved yet. `deny` is never forwarded.
 */

export type Owner = "core" | "python" | "deny";

export function ownerOf(method: string, path: string): Owner {
  if (path === "/internal" || path.startsWith("/internal/")) return "deny";
  if (isAi(method, path)) return "python";
  if (isCore(method, path)) return "core";
  return "python";
}

function isAi(method: string, path: string): boolean {
  if (method === "POST" && path === "/api/v1/ai/generate") return true;
  if (method === "POST" && /^\/api\/v1\/conversations\/[^/]+\/messages\/stream$/.test(path)) return true;
  if (method === "POST" && /^\/api\/v1\/applications\/[^/]+\/resume-run$/.test(path)) return true;
  if (method === "POST" && /^\/api\/v1\/jobs\/[^/]+\/analyze$/.test(path)) return true;
  if (method === "POST" && /^\/api\/v1\/interviews\/[^/]+\/prepare$/.test(path)) return true;
  if (method === "POST" && /^\/api\/v1\/documents\/[^/]+\/generate$/.test(path)) return true;
  if (method === "POST" && /^\/api\/v1\/documents\/[^/]+\/revisions$/.test(path)) return true;
  if (method === "POST" && path === "/api/v1/career-evidence/import") return true;
  if (method === "POST" && path === "/api/v1/projects/blueprints") return true;
  if (method === "POST" && /^\/api\/v1\/projects\/[^/]+\/evidence\/[^/]+\/verify$/.test(path)) return true;
  if (path.startsWith("/api/v1/operations")) return true;
  return false;
}

function isCore(method: string, path: string): boolean {
  if (/^\/api\/v1\/auth\/[^/]+\/(start|callback)$/.test(path)) return method === "GET";
  if (path === "/api/v1/auth/exchange" || path === "/api/v1/auth/refresh" || path === "/api/v1/auth/logout") {
    return method === "POST";
  }
  if (method === "POST" && (
    path === "/api/v1/auth/email/signup"
    || path === "/api/v1/auth/email/verify"
    || path === "/api/v1/auth/email/login"
    || path === "/api/v1/auth/email/password-reset"
    || path === "/api/v1/auth/email/password-reset/confirm"
  )) return true;
  if (path === "/api/v1/auth/me") return false;
  if (path === "/api/v1/conversations") return method === "POST";
  if (/^\/api\/v1\/conversations\/[^/]+$/.test(path)) return method === "PATCH";
  if (/^\/api\/v1\/conversations\/[^/]+\/archive$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/conversations\/[^/]+\/messages$/.test(path)) return method === "POST";
  if (path === "/api/v1/billing" || path === "/api/v1/billing/ledger") return method === "GET";
  if (path === "/api/v1/billing/checkout" || path === "/api/v1/billing/portal" || path === "/api/v1/billing/webhook") {
    return method === "POST";
  }
  if (path === "/api/v1/ai/keys") return method === "GET";
  if (/^\/api\/v1\/ai\/keys\/[^/]+$/.test(path)) return method === "PUT" || method === "DELETE";
  if (/^\/api\/v1\/ai\/keys\/[^/]+\/test$/.test(path)) return method === "POST";
  if (path === "/api/v1/ai/usage") return method === "GET";
  if (path === "/api/v1/jobs") return method === "GET" || method === "POST";
  if (/^\/api\/v1\/jobs\/[^/]+\/analyses$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/jobs\/[^/]+$/.test(path)) return method === "GET" || method === "PATCH";
  if (path === "/api/v1/calendar/events") return method === "GET" || method === "POST";
  if (/^\/api\/v1\/calendar\/events\/[^/]+$/.test(path)) return method === "PATCH" || method === "DELETE";
  if (isRecruiting(path)) return true;
  return false;
}

function isRecruiting(path: string): boolean {
  if (path === "/api/v1/postings" || path.startsWith("/api/v1/postings/")) return true;
  if (path === "/api/v1/search") return true;
  if (path === "/api/v1/profiles" || path.startsWith("/api/v1/profiles/")) return true;
  if (/^\/api\/v1\/users\/[^/]+\/follow$/.test(path)) return true;
  if (path === "/api/v1/me" || path.startsWith("/api/v1/me/")) return true;
  if (path === "/api/v1/posts" || path.startsWith("/api/v1/posts/")) return true;
  return false;
}
