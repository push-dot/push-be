import { neon, types } from "@neondatabase/serverless";

import type { QueryResult } from "./db.ts";
import { handle, type CoreEnv } from "./handler.ts";

types.setTypeParser(1114, (value: string) => value);
types.setTypeParser(1184, (value: string) => value);

const queryOf = (env: CoreEnv) => (env.DATABASE_URL
  ? neonQuery(env.DATABASE_URL)
  : async () => {
    throw new Error("DATABASE_URL is not configured");
  });

export default {
  async fetch(request: Request, env: CoreEnv): Promise<Response> {
    try {
      return await handle(request, env, { query: queryOf(env) });
    } catch {
      return new Response(
        '{"error": {"code": "INTERNAL", "message": "internal error", "requestId": "", "details": null}}',
        { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
  },
  async scheduled(_event: unknown, env: CoreEnv, ctx: { waitUntil: (promise: Promise<unknown>) => void }): Promise<void> {
    const request = new Request("https://core.internal/api/v1/internal/notifications/run", {
      method: "POST",
      headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN ?? ""}` },
    });
    ctx.waitUntil(handle(request, env, { query: queryOf(env) }).then(() => undefined, () => undefined));
  },
};

function neonQuery(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return async (text: string, params: unknown[] = []): Promise<QueryResult> => {
    const result = await sql.query(text, params, { fullResults: true });
    const rows = (result.rows || []) as Record<string, unknown>[];
    return { rows, rowCount: result.rowCount ?? rows.length };
  };
}
