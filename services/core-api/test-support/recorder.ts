import type { Deps } from "../src/handler.ts";

type Call = { sql: string; params: unknown[] };

export const USER = "12345678-1234-4678-9234-567812345678";

export const recorder = (answer: (sql: string, params: unknown[]) => Record<string, unknown>[] | null = () => null) => {
  const calls: Call[] = [];
  const query: Deps["query"] = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes("rate_limits")) return { rows: [{ hits: 1 }], rowCount: 1 };
    if (sql.includes("access_tokens")) {
      return {
        rows: [{
          id: USER, display_name: "Ada", locale: "ko", plan: "FREE", subscription_status: "NONE",
          created_at: "2026-01-02T03:04:05Z", token_expires_at: "2099-01-01T00:00:00Z",
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("INSERT INTO idempotency_keys")) return { rows: [{ id: "idem" }], rowCount: 1 };
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
