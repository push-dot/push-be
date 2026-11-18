// What GET, DELETE and restore of /materials refuse before they read anything.
import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatch } from "../src/handler.ts";
import { HttpError } from "../src/http.ts";
import type { Ctx, UserRow } from "../src/types.ts";

const USER: UserRow = {
  id: "12345678-1234-5678-1234-567812345678", displayName: "u", locale: "ko", email: "u@example.com",
  provider: "email", plan: "PRO", subscriptionStatus: "ACTIVE", stripeCustomerId: null, periodEndsAt: null,
  createdAt: "", accountType: "PERSONAL", companyId: null, companyRole: null,
};
const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const refusal = async (method: string, path: string): Promise<[number, string, unknown]> => {
  const url = new URL("https://core.test/api/v1" + path);
  const ctx: Ctx = {
    request: new Request(url, { method }), env: {}, rid: "t", url, user: USER, now: new Date(),
    deps: { query: async () => { throw new Error("read before the request was checked"); } },
  };
  try {
    const res = await dispatch(ctx, url.pathname);
    return [res.status, "", null];
  } catch (err) {
    assert.ok(err instanceof HttpError, String(err));
    return [err.status, err.code, (err.details as { field?: string } | null)?.field ?? null];
  }
};

test("the list refuses an unknown tab, a long q, and a bad page", async () => {
  assert.deepEqual(await refusal("GET", "/materials?tab=files"), [400, "VALIDATION_ERROR", "tab"]);
  assert.deepEqual(await refusal("GET", `/materials?q=${"가".repeat(201)}`), [400, "VALIDATION_ERROR", "q"]);
  assert.deepEqual(await refusal("GET", "/materials?tab=doc&limit=0"), [400, "VALIDATION_ERROR", "limit"]);
  assert.deepEqual(await refusal("GET", "/materials?tab=doc&cursor=nope"), [400, "VALIDATION_ERROR", "cursor"]);
});

test("one material is addressed by a known kind and a uuid", async () => {
  for (const [method, suffix] of [["GET", ""], ["DELETE", ""], ["POST", "/restore"]]) {
    assert.deepEqual(await refusal(method, `/materials/bookmark/${ID}${suffix}`), [404, "NOT_FOUND", null], `${method} by section name`);
    assert.deepEqual(await refusal(method, `/materials/file/42${suffix}`), [400, "VALIDATION_ERROR", "id"], `${method} by a bad id`);
  }
});
