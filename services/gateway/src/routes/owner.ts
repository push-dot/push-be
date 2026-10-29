/**
 * Which worker answers a path the gateway does not handle itself.
 * `core` is push-be-core. `python` is the AI work the FastAPI app still
 * mounts. Anything else is `deny` and never forwarded, so FastAPI's
 * /docs and /openapi.json and any unlisted route stay unreachable.
 */

export type Owner = "core" | "python" | "deny";

export function ownerOf(method: string, path: string): Owner {
  if (ambiguous(path)) return "deny";
  if (path === "/internal" || path.startsWith("/internal/")) return "deny";
  if (isPython(method, path)) return "python";
  if (isCore(method, path)) return "core";
  return "deny";
}

// The URL parser already resolves dot segments. Uvicorn decodes %2F and
// %5C into separators and Traefik may merge `//`, so a path routed here by
// one shape could reach a different route behind the proxy.
function ambiguous(path: string): boolean {
  return path.includes("//") || /%2f|%5c/i.test(path);
}

// Mirrors the routers in services/ai/src/app/main.py.
function isPython(method: string, path: string): boolean {
  if (method === "POST" && path === "/api/v1/ai/generate") return true;
  if (method === "POST" && /^\/api\/v1\/applications\/[^/]+\/resume-run$/.test(path)) return true;
  if (method === "POST" && /^\/api\/v1\/jobs\/[^/]+\/analyze$/.test(path)) return true;
  if (method === "POST" && /^\/api\/v1\/interviews\/[^/]+\/prepare$/.test(path)) return true;
  if (method === "POST" && /^\/api\/v1\/documents\/[^/]+\/revisions$/.test(path)) return true;
  if (method === "GET" && /^\/api\/v1\/documents\/[^/]+\/versions\/[^/]+\/export$/.test(path)) return true;
  if (method === "POST" && path === "/api/v1/career-evidence/import") return true;
  if (method === "GET" && /^\/api\/v1\/sources\/[^/]+\/profile-draft$/.test(path)) return true;
  if (method === "POST" && path === "/api/v1/projects/blueprints") return true;
  if (method === "POST" && /^\/api\/v1\/projects\/[^/]+\/evidence\/[^/]+\/verify$/.test(path)) return true;
  if (method === "GET" && /^\/api\/v1\/operations\/[^/]+(\/events)?$/.test(path)) return true;
  if (method === "POST" && /^\/api\/v1\/operations\/[^/]+\/(input|cancel)$/.test(path)) return true;
  if (path === "/api/v1/approvals") return method === "GET" || method === "POST";
  if (method === "GET" && /^\/api\/v1\/approvals\/[^/]+$/.test(path)) return true;
  if (method === "POST" && /^\/api\/v1\/approvals\/[^/]+\/decision$/.test(path)) return true;
  if (method === "POST" && /^\/api\/v1\/conversations\/[^/]+\/share$/.test(path)) return true;
  if (method === "GET" && /^\/api\/v1\/conversations\/shared\/[^/]+$/.test(path)) return true;
  if (method === "GET" && /^\/api\/v1\/conversations\/[^/]+\/artifacts$/.test(path)) return true;
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
    || path === "/api/v1/auth/phone/send"
    || path === "/api/v1/auth/phone/verify"
  )) return true;
  if (path === "/api/v1/auth/me") return false;
  if (path === "/api/v1/conversations") return method === "POST";
  if (/^\/api\/v1\/conversations\/[^/]+$/.test(path)) return method === "PATCH" || method === "DELETE";
  if (/^\/api\/v1\/conversations\/[^/]+\/(archive|unarchive)$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/conversations\/[^/]+\/messages(\/stream)?$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/conversations\/[^/]+\/attachments$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/conversations\/[^/]+\/approvals\/[^/]+$/.test(path)) return method === "POST";
  if (path === "/api/v1/billing" || path === "/api/v1/billing/ledger") return method === "GET";
  if (
    path === "/api/v1/billing/checkout"
    || path === "/api/v1/billing/portal"
    || path === "/api/v1/billing/webhook"
    || path === "/api/v1/billing/topup"
    || path === "/api/v1/billing/iap/verify"
    || path === "/api/v1/billing/webhook/app-store"
    || path === "/api/v1/billing/webhook/google-play"
  ) {
    return method === "POST";
  }
  if (path === "/api/v1/ai/usage") return method === "GET";
  if (/^\/api\/v1\/ai\/jobs\/[^/]+$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/documents\/[^/]+\/generate$/.test(path)) return method === "POST";
  // AI worker act-as routes; core checks document ownership and rejects resume-jobs without act-as.
  if (/^\/api\/v1\/documents\/[^/]+\/edits$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/conversations\/[^/]+\/resume-jobs$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/conversations\/[^/]+\/artifacts\/[^/]+$/.test(path)) return method === "GET";
  if (path === "/api/v1/documents") return method === "GET" || method === "POST";
  if (/^\/api\/v1\/documents\/[^/]+$/.test(path)) return method === "GET" || method === "PATCH";
  if (/^\/api\/v1\/documents\/[^/]+\/(versions|exports)$/.test(path)) return method === "GET" || method === "POST";
  if (/^\/api\/v1\/documents\/[^/]+\/versions\/[^/]+$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/documents\/[^/]+\/(review|finalize|archive)$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/documents\/[^/]+\/revisions\/[^/]+\/apply$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/documents\/[^/]+\/exports\/[^/]+\/result$/.test(path)) return method === "POST";
  if (path === "/api/v1/sources") return method === "GET" || method === "POST";
  if (/^\/api\/v1\/sources\/[^/]+$/.test(path)) return method === "GET" || method === "DELETE";
  if (/^\/api\/v1\/sources\/[^/]+\/content$/.test(path)) return method === "GET";
  if (path === "/api/v1/uploads/images") return method === "POST";
  if (/^\/api\/v1\/uploads\/images\/[^/]+$/.test(path)) return method === "GET";
  if (path === "/api/v1/career-evidence") return method === "GET" || method === "POST";
  if (/^\/api\/v1\/career-evidence\/[^/]+$/.test(path)) return method === "GET" && path !== "/api/v1/career-evidence/import";
  if (/^\/api\/v1\/career-evidence\/[^/]+\/archive$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/experiments\/[^/]+\/(assignment|stats|results)$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/experiments\/[^/]+\/events$/.test(path)) return method === "POST";
  if (path === "/api/v1/interviews") return method === "GET" || method === "POST";
  if (/^\/api\/v1\/interviews\/[^/]+$/.test(path)) return method === "GET" || method === "PATCH";
  if (path === "/api/v1/projects") return method === "GET";
  if (/^\/api\/v1\/projects\/[^/]+$/.test(path)) return method === "GET" && path !== "/api/v1/projects/blueprints";
  if (/^\/api\/v1\/projects\/[^/]+\/select$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/projects\/[^/]+\/(runs|evidence)$/.test(path)) return method === "GET" || method === "POST";
  if (/^\/api\/v1\/projects\/[^/]+\/runs\/[^/]+\/(start|launch|recover|result)$/.test(path)) return method === "POST";
  if (path === "/api/v1/integrations/google") return method === "GET" || method === "DELETE";
  if (/^\/api\/v1\/integrations\/google\/(connect|complete|sync)$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/integrations\/google\/(callback|messages|events)$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/integrations\/google\/messages\/[^/]+\/link$/.test(path)) return method === "POST";
  if (path === "/api/v1/applications") return method === "GET" || method === "POST";
  if (path === "/api/v1/applications/import") return method === "POST";
  if (/^\/api\/v1\/applications\/[^/]+$/.test(path)) return method === "GET" || method === "PATCH";
  if (/^\/api\/v1\/applications\/[^/]+\/(timeline|checklist)$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/applications\/[^/]+\/submission-drafts$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/applications\/[^/]+\/submissions$/.test(path)) return method === "GET" || method === "POST";
  if (path === "/api/v1/jobs") return method === "GET" || method === "POST";
  if (/^\/api\/v1\/jobs\/[^/]+\/analyses$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/jobs\/[^/]+$/.test(path)) return method === "GET" || method === "PATCH";
  if (path === "/api/v1/calendar/events") return method === "GET" || method === "POST";
  if (/^\/api\/v1\/calendar\/events\/[^/]+$/.test(path)) return method === "PATCH" || method === "DELETE";
  if (method === "POST" && (path === "/api/v1/internal/notifications/ai-done" || path === "/api/v1/internal/notifications/run")) return true;
  if (path === "/api/v1/companies" || path.startsWith("/api/v1/companies/")) return true;
  if (isRecruiting(path)) return true;
  return false;
}

function isRecruiting(path: string): boolean {
  if (path === "/api/v1/postings" || path.startsWith("/api/v1/postings/")) return true;
  if (path === "/api/v1/search" || path === "/api/v1/search/counts" || path === "/api/v1/search/trending") return true;
  if (path === "/api/v1/profiles" || path.startsWith("/api/v1/profiles/")) return true;
  if (/^\/api\/v1\/users\/[^/]+\/follow$/.test(path)) return true;
  if (path === "/api/v1/me" || path.startsWith("/api/v1/me/")) return true;
  if (path === "/api/v1/posts" || path.startsWith("/api/v1/posts/")) return true;
  return false;
}
