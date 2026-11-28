import type { QueryResult } from "../src/db.ts";
import type { CoreEnv, Deps } from "../src/handler.ts";
import type { Ctx } from "../src/types.ts";

/** A database row, as the query helpers hand it out. */
export type Row = QueryResult["rows"][number];
type Call = { sql: string; params: Array<unknown> };

export const USER = "12345678-1234-4678-9234-567812345678";

export const recorder = (answer: (sql: string, params: Array<unknown>) => Array<Row> | null = () => null) => {
  const calls: Array<Call> = [];
  const query: Deps["query"] = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
    if (sql.startsWith("SELECT phone, contact_email")) {return { rows: [{ phone: "+821012345678", contact_email: "ada@push.app" }], rowCount: 1 };}
    if (sql.includes("access_tokens")) {
      return {
        rows: [{
          id: USER, display_name: "Ada", locale: "ko", plan: "FREE", subscription_status: "NONE",
          created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z",
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("INSERT INTO idempotency_keys")) {return { rows: [{ id: "idem" }], rowCount: 1 };}
    const rows = answer(sql, params) ?? [];
    return { rows, rowCount: rows.length };
  };
  return { calls, query };
};

export const postJson = (path: string, body: unknown, key: string): Request => new Request("https://core.example" + path, {
  method: "POST",
  headers: { authorization: "Bearer t", "idempotency-key": key, "content-type": "application/json" },
  body: JSON.stringify(body),
});

function assertBody<T>(_value: unknown): asserts _value is T { /* the test's own assertions check the shape it reads */ }

/** A response body typed by the test that reads it. */
export const readJson = async <T>(res: Pick<Response, "json">): Promise<T> => {
  const body: unknown = await res.json();
  assertBody<T>(body);
  return body;
};

/** JSON text typed by the test that reads it. */
export const parseJson = <T>(text: string): T => {
  const body: unknown = JSON.parse(text);
  assertBody<T>(body);
  return body;
};

/** A whole request context for calling a service function directly, with a placeholder signed-in user. */
export const ctxFor = (deps: Deps, env: CoreEnv = { APP_ENV: "production" }, now = new Date("2026-01-01T00:00:00Z")): Ctx => ({
  request: new Request("https://core.example"),
  env,
  deps,
  rid: "r",
  url: new URL("https://core.example"),
  user: {
    id: USER, displayName: "Test", locale: "ko", email: "", provider: "test", plan: "FREE", subscriptionStatus: "NONE",
    stripeCustomerId: null, periodEndsAt: null, createdAt: "2026-01-01T00:00:00Z", accountType: "PERSONAL", companyId: null, companyRole: null,
  },
  now,
});
