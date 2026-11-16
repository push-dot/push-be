// The web app keeps the refresh token in an HttpOnly cookie, so script on the page never reads it. A client
// asks for that with `x-csrf: 1` (a cross-origin page cannot send the header without passing the gateway's
// CORS preflight); a client without the header (the mobile app) still gets the token in the JSON body.
const COOKIE = "push_rt";
const HEADER = "x-csrf";
const MAX_AGE_SEC = 30 * 24 * 60 * 60;
const ISSUING = new Set([
  "/api/v1/auth/exchange",
  "/api/v1/auth/refresh",
  "/api/v1/auth/email/login",
  "/api/v1/auth/email/verify",
  "/api/v1/auth/phone/verify",
]);
const TAKING = new Set(["/api/v1/auth/refresh", "/api/v1/auth/logout"]);

const asksForCookie = (request: Request): boolean => request.method === "POST" && request.headers.get(HEADER) === "1";

const cookieOf = (request: Request): string => {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return "";
};

const setCookie = (value: string, maxAge: number): string =>
  `${COOKIE}=${value}; Max-Age=${maxAge}; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax`;

/** A refresh or logout from the web carries no token in its body: the cookie's goes in. */
export async function takeRefreshCookie(request: Request): Promise<Request> {
  const path = new URL(request.url).pathname;
  if (!asksForCookie(request) || !TAKING.has(path)) return request;
  const text = await request.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed = text ? JSON.parse(text) as unknown : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch { /* the handler answers an unreadable body */ }
  const token = cookieOf(request);
  if (typeof body.refreshToken !== "string" && token) body = { ...body, refreshToken: token };
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: request.method, headers, body: JSON.stringify(body) });
}

/** A web session moves the refresh token from the JSON body to the cookie; a refused refresh or a logout clears it. */
export async function giveRefreshCookie(request: Request, response: Response): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!asksForCookie(request)) return response;
  const headers = new Headers(response.headers);
  if (path === "/api/v1/auth/logout" || (path === "/api/v1/auth/refresh" && response.status === 401)) {
    headers.append("set-cookie", setCookie("", 0));
    return new Response(response.body, { status: response.status, headers });
  }
  if (!ISSUING.has(path) || response.status !== 200) return response;
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { data?: Record<string, unknown> };
    const token = parsed.data?.refreshToken;
    if (typeof token !== "string") return new Response(text, { status: 200, headers });
    delete parsed.data?.refreshToken;
    const body = JSON.stringify(parsed);
    headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
    headers.append("set-cookie", setCookie(token, MAX_AGE_SEC));
    return new Response(body, { status: 200, headers });
  } catch {
    return new Response(text, { status: 200, headers });
  }
}
