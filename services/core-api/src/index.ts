import { Client, neon, types } from "@neondatabase/serverless";

import { inTransaction } from './db.ts';
import type { QueryResult, Transaction } from './db.ts';
import { handle } from './handler.ts';
import type { CoreEnv } from './handler.ts';
import { ReadCache } from "./read-cache.ts";

types.setTypeParser(1082, (value: string) => value);
types.setTypeParser(1114, (value: string) => value);
types.setTypeParser(1184, (value: string) => value);

const readCache = new ReadCache<QueryResult>();

const queryOf = (env: CoreEnv) => (env.DATABASE_URL
  ? neonQuery(env.DATABASE_URL)
  : async () => {
    throw new Error("DATABASE_URL is not configured");
  });

export default {
  async fetch(request: Request, env: CoreEnv, ctx?: { waitUntil?: (promise: Promise<unknown>) => void }): Promise<Response> {
    try {
      const waitUntil = ctx?.waitUntil;
      return await handle(request, env, {
        query: queryOf(env),
        cache: readCache,
        ...(env.DATABASE_URL ? { transaction: neonTransaction(env.DATABASE_URL) } : undefined),
        ...(waitUntil ? { waitUntil: (promise: Promise<unknown>) => waitUntil.call(ctx, promise) } : undefined),
      });
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
    const deps = { query: queryOf(env), ...(env.DATABASE_URL ? { transaction: neonTransaction(env.DATABASE_URL) } : undefined) };
    const renewal = new Request("https://core.internal/api/v1/internal/billing/toss-renew", {
      method: "POST",
      headers: { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN ?? ""}` },
    });
    ctx.waitUntil(handle(request, env, deps).then(() => undefined, () => undefined));
    ctx.waitUntil(handle(renewal, env, deps).then(() => undefined, () => undefined));
  },
};

function neonQuery(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return async (text: string, params: Array<unknown> = []): Promise<QueryResult> => {
    const result = await sql.query(text, params, { fullResults: true });
    const rows: QueryResult["rows"] = result.rows || [];
    return { rows, rowCount: result.rowCount ?? rows.length };
  };
}

// Neon's HTTP queries are one statement each; an interactive transaction needs a WebSocket client, opened and closed per transaction.
function neonTransaction(databaseUrl: string): Transaction {
  return async (work) => {
    const client = new Client(databaseUrl);
    await client.connect();
    try {
      return await inTransaction(client, work);
    } finally {
      await client.end();
    }
  };
}
