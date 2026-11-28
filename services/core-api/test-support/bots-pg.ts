import type { Query, Row } from "../src/db.ts";
import type { JsonObject } from "../src/json.ts";
import { handle } from '../src/handler.ts';
import type { CoreEnv, Deps } from '../src/handler.ts';
import { resetLimits } from "../src/ratelimit.ts";
import { livePg } from "../test/parity/pg.ts";

const NOW = "2026-11-12T00:00:00.000Z";
const env: CoreEnv = { APP_ENV: "production" };

export type Person = { id: string; plan: string };
type Answer = {
  status: number;
  data: Row;
  error: { code: string; details: Row } | undefined;
  /** The whole body, for the keys beside data: limit, page. */
  body: Row;
};

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
// A list route answers an array in data; tests read it through viaJson, so data keeps the Row type the object routes use.
const isData = (value: unknown): value is Row => typeof value === "object" && value !== null;
const errorOf = (value: unknown): Answer["error"] =>
  (isObject(value) && typeof value.code === "string" ? { code: value.code, details: isObject(value.details) ? value.details : {} } : undefined);

/** The bot routes on a migrated Postgres: sign-in, rate limit and idempotency are faked, every other statement is real. */
export const botsPg = async (url: string) => {
  const pg = await livePg(url, 20);
  const people: Array<string> = [];
  const companies: Array<string> = [];

  const queryAs = (user: Person): Query => async (sql, params = []) => {
    if (sql.includes("rate_limits")) {return { rows: [{ hits: 1 }], rowCount: 1 };}
    if (sql.includes("access_tokens")) {
      return {
        rows: [{
          id: user.id, display_name: "bot test", locale: "ko", plan: user.plan, subscription_status: "NONE",
          stripe_customer_id: null, period_ends_at: null, created_at: NOW, token_expires_at: "2099-01-01T00:00:00Z",
          is_employer: false, company_id: null, company_role: null,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("idempotency_keys") && sql.includes("INSERT")) {return { rows: [{ id: crypto.randomUUID() }], rowCount: 1 };}
    if (sql.includes("idempotency_keys")) {return { rows: [], rowCount: 0 };}
    return pg.query(sql, params);
  };

  const person = async (plan: string, consent = true): Promise<Person> => {
    const id = crypto.randomUUID();
    people.push(id);
    await pg.query(
      "INSERT INTO users (id, provider, provider_subject, display_name, plan, phone, contact_email, contact_email_verified_at) VALUES ($1::uuid, 'test', $1::uuid::text, 'bot test', $2, '+' || translate($1::uuid::text, '-abcdef', ''), 'bot@test.example', now())",
      [id, plan]);
    if (consent) {await pg.query("INSERT INTO user_consents (user_id, reference_data) VALUES ($1::uuid, true)", [id]);}
    return { id, plan };
  };

  const posting = async (company: string, status = "OPEN"): Promise<string> => {
    const companyId = crypto.randomUUID();
    const id = crypto.randomUUID();
    companies.push(companyId);
    await pg.query("INSERT INTO companies (id, name) VALUES ($1::uuid, $2)", [companyId, company]);
    await pg.query(
      `INSERT INTO job_postings (id, company_id, company, title, job_category, career_min, location, employment_type, description, status)
       VALUES ($1::uuid, $2::uuid, $3, 'Backend', 'dev', 0, 'Seoul', 'full_time', 'd', $4)`,
      [id, companyId, company, status]);
    return id;
  };

  const call = async (user: Person, method: string, path: string, body?: unknown, extra: Partial<Deps> = {}): Promise<Answer> => {
    resetLimits();
    const headers = new Headers({ authorization: "Bearer bots-pg", "content-type": "application/json" });
    if (method === "POST") {headers.set("idempotency-key", crypto.randomUUID());}
    const res = await handle(new Request("https://core.example/api/v1" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, { query: queryAs(user), transaction: pg.transaction, now: () => new Date(), ...extra });
    const parsed: unknown = res.status === 204 ? {} : await res.json();
    const json = isObject(parsed) ? parsed : {};
    return { status: res.status, data: isData(json.data) ? json.data : {}, error: errorOf(json.error), body: json };
  };

  const close = async (): Promise<void> => {
    await pg.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [people]);
    await pg.query("DELETE FROM companies WHERE id = ANY($1::uuid[])", [companies]);
    await pg.close();
  };

  return { pg, person, posting, call, close };
};

export type BotsPg = Awaited<ReturnType<typeof botsPg>>;
