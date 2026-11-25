import assert from "node:assert/strict";
import { test } from "node:test";

import { scheduleChatJob } from "../src/conversations/schedule-chat-job.ts";
import type { CoreEnv, Ctx, UserRow } from "../src/types.ts";

const JOB = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const USER: UserRow = {
  id: "33333333-3333-4333-8333-333333333333", displayName: "Ada", locale: "ko", email: "ada@example.test", provider: "email", plan: "PRO",
  subscriptionStatus: "active", stripeCustomerId: null, periodEndsAt: null, createdAt: "2026-01-02T03:04:05Z",
  accountType: "PERSONAL", companyId: null, companyRole: null,
};

const wake = async (env: CoreEnv, companyId?: string): Promise<Array<string>> => {
  const woke: Array<string> = [];
  const ctx: Ctx = {
    request: new Request("https://core.example/"),
    env,
    deps: {
      query: async () => ({ rows: [], rowCount: 0 }),
      fetch: async (input) => {
        woke.push(String(input));
        return new Response("ok");
      },
    },
    rid: "rid",
    url: new URL("https://core.example/"),
    user: USER,
    now: new Date("2026-11-26T00:00:00Z"),
  };
  await scheduleChatJob(ctx, JOB, companyId);
  return woke;
};

test("a personal conversation's job wakes push-bot", async () => {
  const env = { AI_ORIGIN: "https://bot.example.test/", AGENT_ORIGIN: "https://agent.example.test/" };
  assert.deepEqual(await wake(env), ["https://bot.example.test/internal/chat/schedule"]);
});

test("a company conversation's job wakes push-agent", async () => {
  const env = { AI_ORIGIN: "https://bot.example.test", AGENT_ORIGIN: "https://agent.example.test/" };
  assert.deepEqual(await wake(env, COMPANY), ["https://agent.example.test/internal/chat/schedule"]);
});

test("without AGENT_ORIGIN a company conversation's job still wakes AI_ORIGIN", async () => {
  assert.deepEqual(await wake({ AI_ORIGIN: "https://bot.example.test" }, COMPANY), ["https://bot.example.test/internal/chat/schedule"]);
  assert.deepEqual(await wake({ AI_ORIGIN: "https://bot.example.test", AGENT_ORIGIN: "  " }, COMPANY), ["https://bot.example.test/internal/chat/schedule"]);
});

test("no origin at all is a configuration error and wakes nothing", async () => {
  await assert.rejects(wake({ AGENT_ORIGIN: "https://agent.example.test" }), /ai origin is not configured/);
});
