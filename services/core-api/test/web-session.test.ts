import assert from "node:assert/strict";
import { test } from "node:test";

import { giveRefreshCookie, takeRefreshCookie } from "../src/web-session.ts";

const jsonOf = async <T>(res: Response): Promise<T> => {
  const value: T = await res.json();
  return value;
};

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request("https://core.example" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const session = (): Response =>
  new Response(JSON.stringify({ data: { accessToken: "a", refreshToken: "r-1", expiresIn: 900 } }), {
    status: 200, headers: { "content-type": "application/json", "x-request-id": "rid" },
  });

test("a web login keeps the refresh token out of the body and in an HttpOnly cookie", async () => {
  const res = await giveRefreshCookie(post("/api/v1/auth/email/login", {}, { "x-csrf": "1" }), session());

  const body = await jsonOf<{ data: { refreshToken?: string; accessToken?: string } }>(res);
  assert.equal(body.data.refreshToken, undefined);
  assert.equal(body.data.accessToken, "a");
  assert.equal(res.headers.get("content-length"), String(JSON.stringify(body).length));
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^push_rt=r-1; /);
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/api/v1/auth", "Max-Age=2592000"]) {
    assert.ok(cookie.includes(flag), flag);
  }
});

test("a client without the header (the mobile app) still gets the token in the body and no cookie", async () => {
  const res = await giveRefreshCookie(post("/api/v1/auth/email/login", {}), session());

  assert.equal(((await jsonOf<{ data: { refreshToken: string } }>(res))).data.refreshToken, "r-1");
  assert.equal(res.headers.get("set-cookie"), null);
});

test("only a header equal to 1 asks for the cookie", async () => {
  for (const value of ["0", "true", ""]) {
    const res = await giveRefreshCookie(post("/api/v1/auth/exchange", {}, { "x-csrf": value }), session());
    assert.equal(res.headers.get("set-cookie"), null, value);
  }
});

test("a response that carries no session (a pending social login, an error) is left alone", async () => {
  const pending = new Response(JSON.stringify({ data: { pendingToken: "p" } }), { status: 200 });
  const refused = new Response("{}", { status: 400 });
  for (const response of [pending, refused]) {
    const res = await giveRefreshCookie(post("/api/v1/auth/exchange", {}, { "x-csrf": "1" }), response);
    assert.equal(res.headers.get("set-cookie"), null);
  }
});

test("a refresh from the web reads the token from the cookie", async () => {
  const request = await takeRefreshCookie(post("/api/v1/auth/refresh", undefined, { "x-csrf": "1", cookie: "a=b; push_rt=r-1; c=d" }));

  assert.deepEqual(await request.json(), { refreshToken: "r-1" });
});

test("a refresh without the header never reads the cookie, so a cross-site form cannot spend it", async () => {
  const request = await takeRefreshCookie(post("/api/v1/auth/refresh", {}, { cookie: "push_rt=r-1" }));

  assert.deepEqual(await request.json(), {});
});

test("a token in the body wins over the cookie", async () => {
  const request = await takeRefreshCookie(post("/api/v1/auth/logout", { refreshToken: "body" }, { "x-csrf": "1", cookie: "push_rt=cookie" }));

  assert.deepEqual(await request.json(), { refreshToken: "body" });
});

test("a refused refresh and a logout clear the cookie", async () => {
  const refused = await giveRefreshCookie(post("/api/v1/auth/refresh", {}, { "x-csrf": "1" }), new Response("{}", { status: 401 }));
  const out = await giveRefreshCookie(post("/api/v1/auth/logout", {}, { "x-csrf": "1" }), new Response(null, { status: 204 }));

  for (const res of [refused, out]) {assert.match(res.headers.get("set-cookie") ?? "", /^push_rt=; Max-Age=0; Path=\/api\/v1\/auth/);}
  assert.equal(out.status, 204);
});
