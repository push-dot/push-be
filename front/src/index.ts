import { neon } from "@neondatabase/serverless";

import { handle, type FrontEnv, type Query } from "./handler.ts";

export default {
  async fetch(request: Request, env: FrontEnv): Promise<Response> {
    try {
      const query: Query = env.DATABASE_URL
        ? neonQuery(env.DATABASE_URL)
        : async () => {
          throw new Error("DATABASE_URL is not configured");
        };
      return await handle(request, env, { query });
    } catch {
      return new Response(
        '{"error": {"code": "INTERNAL", "message": "internal error", "requestId": "", "details": null}}',
        { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
  },
};

function neonQuery(databaseUrl: string): Query {
  const sql = neon(databaseUrl);
  return async (text, params) => {
    const rows = await sql.query(text, params);
    return rows as unknown as Record<string, unknown>[];
  };
}
