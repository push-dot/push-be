import assert from "node:assert/strict";
import { test } from "node:test";

import { HttpError } from "../src/http.ts";
import { assertPlanAllows, type Gate, type Plan } from "../src/jobs/config.ts";

const outcome = (plan: unknown, gate: Gate): string => {
  try {
    assertPlanAllows(plan, gate);
    return "ok";
  } catch (err) {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 403);
    assert.equal(err.code, "PLAN_REQUIRED");
    return String((err.details as { requiredPlan: Plan }).requiredPlan);
  }
};

test("plan gates match the python behavior", () => {
  assert.equal(outcome("BASIC", "employer_interview"), "PRO");
  assert.equal(outcome(null, "employer_interview"), "PRO");
  assert.equal(outcome("", "employer_interview"), "PRO");
  assert.equal(outcome("PRO", "employer_interview"), "ok");
  assert.equal(outcome("ultra", "employer_interview"), "ok");
  assert.equal(outcome("PRO", "pdf_attachment"), "ULTRA");
  assert.equal(outcome("ULTRA", "pdf_attachment"), "ok");
});
