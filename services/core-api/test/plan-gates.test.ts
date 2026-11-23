import assert from "node:assert/strict";
import { test } from "node:test";

import { HttpError } from "../src/http.ts";
import { assertPlanAllows } from '../src/jobs/config.ts';
import type { Gate } from '../src/jobs/config.ts';

const outcome = (plan: unknown, gate: Gate): string => {
  try {
    assertPlanAllows(plan, gate);
    return "ok";
  } catch (error) {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 403);
    assert.equal(error.code, "PLAN_REQUIRED");
    assert.ok(typeof error.details === "object" && error.details !== null && "requiredPlan" in error.details);
    return String(error.details.requiredPlan);
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
