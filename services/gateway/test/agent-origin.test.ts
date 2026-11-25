// Which AI service a forwarded route reaches: push-agent for a company's conversation, push-bot for the rest.
import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, resetLimits } from "../src/handler.ts";
import type { Deps, FrontEnv, Query } from "../src/handler.ts";
import { isBotThreadProbe } from "./fakes.ts";

const COMPANY_CONVERSATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERSONAL_CONVERSATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BASE = "https://push-be.example/api/v1";
const BOT = "https://bot.example.test";
const AGENT = "https://agent.example.test";

const isCompanyProbe = (sql: string): boolean => sql.includes("company_id IS NOT NULL") && sql.includes("SELECT 1 FROM conversations");

const world = () => {
  const forwarded: Array<Request> = [];
  const probes: Array<string> = [];
  const query: Query = async (sql, params) => {
    if (isBotThreadProbe(sql)) {return [];}
    if (isCompanyProbe(sql)) {
      probes.push(String(params[0]));
      return params[0] === COMPANY_CONVERSATION ? [{ "?column?": 1 }] : [];
    }
    return [];
  };
  const deps: Deps = {
    query,
    now: () => new Date("2026-11-26T00:00:00Z"),
    fetch: async (input, init) => {
      forwarded.push(new Request(String(input), init));
      return new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  return { deps, forwarded, probes };
};

const env = (extra: Partial<FrontEnv> = {}): FrontEnv => ({
  APP_ENV: "production", AI_ORIGIN: BOT, AI_SHARED_SECRET: "secret", ...extra,
});

const get = (path: string, frontEnv: FrontEnv, deps: Deps): Promise<Response> => {
  resetLimits();
  return handle(new Request(BASE + path, { headers: { authorization: "Bearer secret-token" } }), frontEnv, deps);
};

test("a company conversation's AI routes go to push-agent with the shared secret", async () => {
  for (const tail of ["turns", "artifacts"]) {
    const { deps, forwarded } = world();
    const res = await get(`/conversations/${COMPANY_CONVERSATION}/${tail}?limit=5`, env({ AGENT_ORIGIN: AGENT + "/" }), deps);
    assert.equal(res.status, 200);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].url, `${AGENT}/api/v1/conversations/${COMPANY_CONVERSATION}/${tail}?limit=5`);
    assert.equal(forwarded[0].headers.get("x-push-ai-secret"), "secret");
  }
});

test("a personal conversation's AI routes stay on push-bot", async () => {
  const { deps, forwarded } = world();
  const res = await get(`/conversations/${PERSONAL_CONVERSATION}/turns`, env({ AGENT_ORIGIN: AGENT }), deps);
  assert.equal(res.status, 200);
  assert.equal(forwarded[0].url, `${BOT}/api/v1/conversations/${PERSONAL_CONVERSATION}/turns`);
});

test("AI routes that name no conversation stay on push-bot and ask nothing", async () => {
  for (const path of ["/bots/push/transcript", "/approvals", "/conversations/shared/some-token", "/operations/" + PERSONAL_CONVERSATION]) {
    const { deps, forwarded, probes } = world();
    const res = await get(path, env({ AGENT_ORIGIN: AGENT }), deps);
    assert.equal(res.status, 200, path);
    assert.equal(new URL(forwarded[0].url).origin, BOT, path);
    assert.deepEqual(probes, [], path);
  }
});

test("without AGENT_ORIGIN every AI route goes to AI_ORIGIN and the company probe never runs", async () => {
  for (const frontEnv of [env(), env({ AGENT_ORIGIN: "  " })]) {
    const { deps, forwarded, probes } = world();
    const res = await get(`/conversations/${COMPANY_CONVERSATION}/turns`, frontEnv, deps);
    assert.equal(res.status, 200);
    assert.equal(forwarded[0].url, `${BOT}/api/v1/conversations/${COMPANY_CONVERSATION}/turns`);
    assert.deepEqual(probes, []);
  }
});

test("a push-agent origin that is not HTTPS is refused like push-bot's", async () => {
  const { deps, forwarded } = world();
  const res = await get(`/conversations/${COMPANY_CONVERSATION}/turns`, env({ AGENT_ORIGIN: "http://agent.example.test" }), deps);
  assert.equal(res.status, 500);
  assert.equal(forwarded.length, 0);
});
