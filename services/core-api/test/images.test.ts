import assert from "node:assert/strict";
import { test } from "node:test";

import { recorder } from "../test-support/recorder.ts";

const NOW = new Date("2026-10-21T00:00:00Z");
const ENV = { APP_ENV: "production" };

{
const path = "/api/v1/uploads/images/%E0%A4%A";
  test(`a malformed percent-encoding in ${path.split("/")[3]} is a 400, not a 500`, async () => {
    const { handle } = await import("../src/handler.ts");
    const { query } = recorder();
    const res = await handle(new Request("https://core.example" + path, { headers: { authorization: "Bearer t" } }), ENV, { query, now: () => NOW });
    assert.equal(res.status, 400);
  });
}

{
const path = "/api/v1/uploads/images";
const limit = 10 << 20;
  test(`an upload to ${path} declaring more than the limit is refused with 413`, async () => {
    const { handle } = await import("../src/handler.ts");
    const { calls, query } = recorder();
    const request = new Request("https://core.example" + path, {
      method: "POST",
      headers: {
        authorization: "Bearer t", "idempotency-key": "00000000-0000-4000-8000-000000000001",
        "content-type": "multipart/form-data; boundary=x", "content-length": String(limit + (1 << 20)),
      },
      body: "--x--",
    });
    const res = await handle(request, ENV, { query, now: () => NOW });
    assert.equal(res.status, 413);
    assert.equal(calls.some((c) => c.sql.includes("INSERT INTO upload_images") || c.sql.includes("INSERT INTO sources")), false);
  });
}

