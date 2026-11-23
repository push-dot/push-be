import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { createSmsSender, smsConfigured } from "../src/sms/sender.ts";

const SENS = {
  APP_ENV: "production",
  SENS_ACCESS_KEY: "access-key",
  SENS_SECRET_KEY: "secret-key",
  SENS_SERVICE_ID: "ncp:sms:kr:1:push",
  SMS_FROM: "010-1234-5678",
};

type Call = { url: string; init: RequestInit };

const jsonOf = <T>(res: Response): Promise<T> => res.json();

const recorder = (status = 202) => {
  const calls: Array<Call> = [];
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response("{}", { status });
  };
  return { calls, fetchImpl };
};

test("sens keys make sms configured in production", () => {
  assert.equal(smsConfigured(SENS), true);
  assert.equal(smsConfigured({ ...SENS, SMS_FROM: "" }), false);
  assert.equal(smsConfigured({ APP_ENV: "production", PHONE_SMS_MODE: "log" }), false);
  assert.equal(smsConfigured({ APP_ENV: "development", PHONE_SMS_MODE: "log" }), true);
});

test("sens send signs the request and sends a domestic number", async () => {
  const { calls, fetchImpl } = recorder();
  await createSmsSender(SENS, fetchImpl).send("+821012345678", "123456");
  assert.equal(calls.length, 1);
  const path = "/sms/v2/services/ncp%3Asms%3Akr%3A1%3Apush/messages";
  assert.equal(calls[0].url, `https://sens.apigw.ntruss.com${path}`);
  const headers = new Headers(calls[0].init.headers);
  const timestamp = headers.get("x-ncp-apigw-timestamp");
  const expected = createHmac("sha256", "secret-key").update(`POST ${path}\n${timestamp}\naccess-key`).digest("base64");
  assert.equal(headers.get("x-ncp-iam-access-key"), "access-key");
  assert.equal(headers.get("x-ncp-apigw-signature-v2"), expected);
  const body = await jsonOf<{ type: string; countryCode: string; from: string; content: string; messages: Array<{ to: string }> }>(new Response(String(calls[0].init.body)));
  assert.equal(body.type, "SMS");
  assert.equal(body.countryCode, "82");
  assert.equal(body.from, "01012345678");
  assert.equal(body.content.includes("123456"), true);
  assert.deepEqual(body.messages, [{ to: "01012345678" }]);
});

test("sens send rejects a failed response and a non-Korean number", async () => {
  const failed = recorder(401);
  await assert.rejects(createSmsSender(SENS, failed.fetchImpl).send("+821012345678", "123456"));
  const foreign = recorder();
  await assert.rejects(createSmsSender(SENS, foreign.fetchImpl).send("+14155550123", "123456"));
  assert.equal(foreign.calls.length, 0);
});
