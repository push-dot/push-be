import assert from "node:assert/strict";
import { test } from "node:test";

import { postJson, recorder, USER } from "../test-support/recorder.ts";

const NOW = new Date("2026-10-21T00:00:00Z");
const ENV = { APP_ENV: "production" };

const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const E3 = "e0000000-0000-4000-8000-000000000003";

test("create accepts HUB_PROFILE and a hub profile exports its latest version", async () => {
  const { handle } = await import("../src/handler.ts");
  const APP = "a0000000-0000-4000-8000-000000000001";
  const DOC = "d0000000-0000-4000-8000-000000000010";
  const VER = "d0000000-0000-4000-8000-000000000011";
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM applications")) return [{ id: APP }];
    if (sql.includes("FROM documents WHERE id")) return [{
      id: DOC, revision: 1, application_id: null, title: "Push 프로필", kind: "HUB_PROFILE",
      template: "SIMPLE", language: "ko", status: "DRAFT", latest_version_id: VER,
      finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.includes("FROM document_versions")) return [{
      id: VER, document_id: DOC, number: 1, content: { type: "doc" },
      blocks: [{ id: "b1", text: "허브 본문" }], created_at: "2026-10-01T00:00:00Z",
    }];
    return null;
  });
  const created = await handle(postJson("/api/v1/documents", {
    applicationId: APP, title: "Push 프로필", kind: "HUB_PROFILE", template: "SIMPLE", language: "ko",
  }, "00000000-0000-4000-8000-000000000010"), ENV, { query, now: () => NOW });
  assert.equal(created.status, 201);
  const exported = await handle(postJson(`/api/v1/documents/${DOC}/exports`, {
    versionId: VER, format: "PDF", rendererVersion: "1",
  }, "00000000-0000-4000-8000-000000000011"), ENV, { query, now: () => NOW });
  assert.equal(exported.status, 201);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO document_exports")), true);

  const { query: resumeQuery } = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [{
      id: DOC, revision: 1, application_id: APP, title: "이력서", kind: "RESUME",
      template: "SIMPLE", language: "ko", status: "DRAFT", latest_version_id: VER,
      finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.includes("FROM document_versions")) return [{
      id: VER, document_id: DOC, number: 1, content: {}, blocks: [], created_at: "2026-10-01T00:00:00Z",
    }];
    return null;
  });
  const blocked = await handle(postJson(`/api/v1/documents/${DOC}/exports`, {
    versionId: VER, format: "PDF", rendererVersion: "1",
  }, "00000000-0000-4000-8000-000000000012"), ENV, { query: resumeQuery, now: () => NOW });
  assert.equal(blocked.status, 422);
});

test("a hub profile converts to the default profile or an application profile", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-000000000020";
  const VER = "d0000000-0000-4000-8000-000000000021";
  const APP = "a0000000-0000-4000-8000-000000000021";
  const doc = {
    id: DOC, revision: 2, application_id: null, title: "Push 프로필", kind: "HUB_PROFILE",
    template: "SIMPLE", language: "ko", status: "DRAFT", latest_version_id: VER,
    finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  };
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [doc];
    if (sql.includes("FROM document_versions")) return [{
      id: VER, document_id: DOC, number: 1, content: {}, blocks: [{ id: "b1", text: "백엔드" }],
      created_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.includes("FROM profiles")) return [{ display_name: "Ada", skills: ["Go"] }];
    return null;
  });
  const hub = await handle(postJson(`/api/v1/documents/${DOC}/profile`, {
    target: "hub",
  }, "00000000-0000-4000-8000-000000000021"), ENV, { query, now: () => NOW });
  assert.equal(hub.status, 200);
  const hubBody = await hub.json() as { data: { target: string; documentId: string; profileUserId: string } };
  assert.equal(hubBody.data.target, "hub");
  assert.equal(hubBody.data.documentId, DOC);
  assert.equal(typeof hubBody.data.profileUserId, "string");
  const update = calls.find((call) => call.sql.includes("INSERT INTO profiles") && call.sql.includes("careers"));
  assert.equal(update?.params[1], "Push 프로필");
  assert.equal(update?.params[2], "백엔드");
  assert.equal(update?.params[9], false);
  assert.equal(update?.params[11], false);
  assert.equal(update?.params[12], false);
  assert.equal(update?.params[13], true);
  assert.equal(update?.sql.includes("ELSE profiles.careers"), true);
  assert.equal(update?.sql.includes("ELSE profiles.skills"), true);

  const { calls: appCalls, query: appQuery } = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [{ ...doc, revision: 2 }];
    if (sql.includes("FROM applications")) return [{ id: APP }];
    if (sql.startsWith("UPDATE documents")) return [{ id: DOC }];
    return null;
  });
  const linked = await handle(postJson(`/api/v1/documents/${DOC}/profile`, {
    target: "application", applicationId: APP, expectedRevision: 2,
  }, "00000000-0000-4000-8000-000000000022"), ENV, { query: appQuery, now: () => NOW });
  assert.equal(linked.status, 200);
  const linkedBody = await linked.json() as { data: { target: string; applicationId: string } };
  assert.equal(linkedBody.data.target, "application");
  assert.equal(linkedBody.data.applicationId, APP);
  const wrote = appCalls.find((call) => call.sql.startsWith("UPDATE documents"));
  assert.equal(wrote?.params.includes(APP), true);
  assert.equal(wrote?.sql.includes("kind"), false);
});

test("omitted profile target is an application profile and does not write the hub profile", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-000000000030";
  const VER = "d0000000-0000-4000-8000-000000000031";
  const APP = "a0000000-0000-4000-8000-000000000031";
  const doc = {
    id: DOC, revision: 4, application_id: null, title: "올린 이력서", kind: "HUB_PROFILE",
    template: "SIMPLE", language: "ko", status: "DRAFT", latest_version_id: VER,
    finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  };
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [doc];
    return null;
  });
  const res = await handle(postJson(`/api/v1/documents/${DOC}/profile`, {}, "00000000-0000-4000-8000-000000000030"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { target: string; documentId: string; applicationId: string | null } };
  assert.equal(body.data.target, "application");
  assert.equal(body.data.documentId, DOC);
  assert.equal(body.data.applicationId, null);
  assert.equal(calls.some((call) => call.sql.includes("UPDATE profiles") || call.sql.startsWith("UPDATE documents")), false);

  const { calls: linkedCalls, query: linkedQuery } = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [doc];
    if (sql.includes("FROM applications")) return [{ id: APP }];
    if (sql.startsWith("UPDATE documents")) return [{ id: DOC }];
    return null;
  });
  const linked = await handle(postJson(`/api/v1/documents/${DOC}/profile`, {
    applicationId: APP, expectedRevision: 4,
  }, "00000000-0000-4000-8000-000000000031"), ENV, { query: linkedQuery, now: () => NOW });
  assert.equal(linked.status, 200);
  const linkedBody = await linked.json() as { data: { target: string; applicationId: string } };
  assert.equal(linkedBody.data.target, "application");
  assert.equal(linkedBody.data.applicationId, APP);
  assert.equal(linkedCalls.some((call) => call.sql.startsWith("UPDATE documents")), true);
  assert.equal(linkedCalls.some((call) => call.sql.includes("UPDATE profiles")), false);
});

test("setting the base profile copies the document onto the hub profile and repeats cleanly", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-000000000040";
  const VER = "d0000000-0000-4000-8000-000000000041";
  const doc = {
    id: DOC, revision: 3, application_id: "a0000000-0000-4000-8000-000000000041", title: "지원용 프로필", kind: "HUB_PROFILE",
    template: "SIMPLE", language: "ko", status: "DRAFT", latest_version_id: VER,
    finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  };
  const answer = (sql: string) => {
    if (sql.includes("FROM documents WHERE id")) return [doc];
    if (sql.includes("FROM document_versions")) return [{
      id: VER, document_id: DOC, number: 1, content: {}, blocks: [{ id: "b1", text: "소개 본문" }],
      created_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.includes("FROM profiles")) return [{ display_name: "Ada", skills: ["Go"] }];
    return null;
  };
  const first = recorder(answer);
  const once = await handle(postJson(`/api/v1/documents/${DOC}/base-profile`, {}, "00000000-0000-4000-8000-000000000040"), ENV, { query: first.query, now: () => NOW });
  assert.equal(once.status, 200);
  const onceBody = await once.json() as { data: { documentId: string; profileUserId: string } };
  assert.equal(onceBody.data.documentId, DOC);
  assert.equal(typeof onceBody.data.profileUserId, "string");
  const update = first.calls.find((call) => call.sql.includes("INSERT INTO profiles") && call.sql.includes("careers"));
  assert.equal(update?.params[1], "지원용 프로필");
  assert.equal(update?.params[2], "소개 본문");
  assert.equal(update?.params[11], false);
  assert.equal(update?.params[12], false);
  assert.equal(update?.params[13], true);
  assert.equal(update?.sql.includes("ELSE profiles.careers"), true);
  assert.equal(update?.sql.includes("ELSE profiles.skills"), true);
  assert.equal(first.calls.some((call) => call.sql.startsWith("UPDATE documents")), false);

  const second = recorder(answer);
  const again = await handle(postJson(`/api/v1/documents/${DOC}/base-profile`, {}, "00000000-0000-4000-8000-000000000041"), ENV, { query: second.query, now: () => NOW });
  assert.equal(again.status, 200);
  const againBody = await again.json() as { data: { documentId: string; profileUserId: string } };
  assert.equal(againBody.data.profileUserId, onceBody.data.profileUserId);
  const againUpdate = second.calls.find((call) => call.sql.includes("INSERT INTO profiles") && call.sql.includes("careers"));
  assert.deepEqual(againUpdate?.params.slice(1, 5), ["지원용 프로필", "소개 본문", "[]", "[]"]);

  const missing = recorder(() => null);
  const hidden = await handle(postJson(`/api/v1/documents/${DOC}/base-profile`, {}, "00000000-0000-4000-8000-000000000042"), ENV, { query: missing.query, now: () => NOW });
  assert.equal(hidden.status, 404);

  const resume = recorder((sql) => sql.includes("FROM documents WHERE id") ? [{ ...doc, kind: "RESUME" }] : null);
  const rejected = await handle(postJson(`/api/v1/documents/${DOC}/base-profile`, {}, "00000000-0000-4000-8000-000000000043"), ENV, { query: resume.query, now: () => NOW });
  assert.equal(rejected.status, 400);
});

const profileSections = () => {
  const nodes: [string, string][] = [
    ["heading", "소개"],
    ["paragraph", "새 소개"],
    ["heading", "경력"],
    ["paragraph", "Acme | Engineer | 2020-01-01 | 2022-06-01 | 백엔드"],
    ["heading", "기술 스택"],
    ["paragraph", "TypeScript, Go"],
    ["heading", "링크"],
    ["paragraph", "GitHub | https://github.com/ada"],
    ["paragraph", "not a url"],
    ["heading", "프로젝트"],
    ["paragraph", "Side project"],
    ["heading", "학력"],
    ["paragraph", "대학교"],
  ];
  return {
    content: {
      type: "doc",
      content: nodes.map(([type, text], i) => ({
        type, attrs: { blockId: "b" + i }, content: [{ type: "text", text }],
      })),
    },
    blocks: nodes.map(([, text], i) => ({ id: "b" + i, text })),
  };
};

const profileWrite = (calls: { sql: string; params: unknown[] }[]) =>
  calls.find((call) => call.sql.includes("INSERT INTO profiles") && call.sql.includes("careers"));

test("setting the base profile replaces careers, skills, and links from the document", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-000000000050";
  const VER = "d0000000-0000-4000-8000-000000000051";
  const doc = {
    id: DOC, revision: 3, application_id: "a0000000-0000-4000-8000-000000000051", title: "지원용 프로필", kind: "HUB_PROFILE",
    template: "SIMPLE", language: "ko", status: "DRAFT", latest_version_id: VER,
    finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  };
  const version = { id: VER, document_id: DOC, number: 1, ...profileSections(), created_at: "2026-10-01T00:00:00Z" };
  const answer = (sql: string) => {
    if (sql.includes("FROM documents WHERE id")) return [doc];
    if (sql.includes("FROM document_versions")) return [version];
    if (sql.includes("FROM profiles")) return [{ display_name: "Ada", skills: ["Rust"] }];
    return null;
  };
  const careers = [{ company: "Acme", role: "Engineer", startedOn: "2020-01-01", endedOn: "2022-06-01", description: "백엔드" }];
  const skills = ["TypeScript", "Go"];
  const first = recorder(answer);
  const once = await handle(postJson(`/api/v1/documents/${DOC}/base-profile`, {}, "00000000-0000-4000-8000-000000000050"), ENV, { query: first.query, now: () => NOW });
  assert.equal(once.status, 200);
  const write = profileWrite(first.calls);
  assert.equal(write?.params[1], "지원용 프로필");
  assert.equal(write?.params[2], "새 소개");
  assert.deepEqual(JSON.parse(String(write?.params[3])), careers);
  assert.deepEqual(JSON.parse(String(write?.params[4])), skills);
  assert.equal(write?.params[9], true);
  assert.equal(write?.params[11], true);
  assert.equal(write?.params[12], true);
  assert.equal(write?.params[13], true);
  assert.equal(write?.sql.includes("DELETE FROM user_links"), true);
  assert.equal(write?.sql.includes(";"), false);
  assert.equal(first.calls.filter((call) => call.sql.includes("INSERT INTO profiles") || call.sql.includes("UPDATE profiles")).length, 1);
  const links = JSON.parse(String(write?.params[10])) as { kind: string; url: string; title: string }[];
  assert.deepEqual(links.map((link) => ({ kind: link.kind, url: link.url, title: link.title })), [
    { kind: "github", url: "https://github.com/ada", title: "GitHub" },
  ]);
  assert.equal(String(write?.params[3]).includes("Side project"), false);
  assert.equal(String(write?.params[2]).includes("대학교"), false);

  const second = recorder(answer);
  const again = await handle(postJson(`/api/v1/documents/${DOC}/base-profile`, {}, "00000000-0000-4000-8000-000000000051"), ENV, { query: second.query, now: () => NOW });
  assert.equal(again.status, 200);
  const againWrite = profileWrite(second.calls);
  assert.deepEqual(againWrite?.params.slice(1, 5), write?.params.slice(1, 5));
  const againLinks = JSON.parse(String(againWrite?.params[10])) as { url: string }[];
  assert.deepEqual(againLinks.map((link) => link.url), links.map((link) => link.url));

  const { calls: hubCalls, query: hubQuery } = recorder(answer);
  const hub = await handle(postJson(`/api/v1/documents/${DOC}/profile`, { target: "hub" }, "00000000-0000-4000-8000-000000000052"), ENV, { query: hubQuery, now: () => NOW });
  assert.equal(hub.status, 200);
  const hubWrite = profileWrite(hubCalls);
  assert.deepEqual(hubWrite?.params.slice(1, 5), write?.params.slice(1, 5));
});

test("a document without a career heading keeps the existing careers", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-000000000080";
  const VER = "d0000000-0000-4000-8000-000000000081";
  const doc = {
    id: DOC, revision: 1, application_id: null, title: "올린 이력서", kind: "HUB_PROFILE",
    template: "SIMPLE", language: "ko", status: "DRAFT", latest_version_id: VER,
    finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  };
  const nodes: [string, string][] = [
    ["heading", "프로젝트"],
    ["paragraph", "Side project"],
  ];
  const kept = [{ company: "Kept", role: "Eng", startedOn: null, endedOn: null, description: "" }];
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [doc];
    if (sql.includes("FROM document_versions")) return [{
      id: VER, document_id: DOC, number: 1,
      content: { type: "doc", content: nodes.map(([type, text], i) => ({ type, attrs: { blockId: "b" + i }, content: [{ type: "text", text }] })) },
      blocks: nodes.map(([, text], i) => ({ id: "b" + i, text })),
      created_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.includes("FROM profiles")) return [{ skills: ["Rust"], careers: kept }];
    return null;
  });
  const res = await handle(postJson(`/api/v1/documents/${DOC}/base-profile`, {}, "00000000-0000-4000-8000-000000000080"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const write = profileWrite(calls);
  assert.equal(write?.params[1], "올린 이력서");
  assert.equal(write?.params[11], false);
  assert.equal(write?.params[12], false);
  assert.equal(write?.params[13], false);
  assert.equal(write?.sql.includes("ELSE profiles.careers"), true);
  assert.equal(write?.sql.includes("ELSE profiles.skills"), true);
  assert.equal(write?.sql.includes("ELSE profiles.intro"), true);
  assert.equal(JSON.parse(String(write?.params[3])).some((career: { company?: string }) => career.company === "Kept"), false);
  assert.equal(String(write?.params[5]).includes("Rust"), true);
});

test("a failed base profile write does not send a second profile write", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-000000000060";
  const VER = "d0000000-0000-4000-8000-000000000061";
  const doc = {
    id: DOC, revision: 1, application_id: null, title: "지원용 프로필", kind: "HUB_PROFILE",
    template: "SIMPLE", language: "ko", status: "DRAFT", latest_version_id: VER,
    finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  };
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [doc];
    if (sql.includes("FROM document_versions")) return [{
      id: VER, document_id: DOC, number: 1, ...profileSections(), created_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.includes("DELETE FROM user_links")) throw new Error("db down");
    return null;
  });
  const res = await handle(postJson(`/api/v1/documents/${DOC}/base-profile`, {}, "00000000-0000-4000-8000-000000000060"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 500);
  const writes = calls.filter((call) => call.sql.includes("INSERT INTO profiles") || call.sql.includes("UPDATE profiles"));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sql.includes("DELETE FROM user_links"), true);
  assert.equal(writes[0].sql.includes("careers"), true);
});

test("only the document owner can set the base profile", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-000000000070";
  const bare = new Request(`https://core.example/api/v1/documents/${DOC}/base-profile`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "00000000-0000-4000-8000-000000000070" },
    body: "{}",
  });
  const denied = await handle(bare, ENV, { query: recorder().query, now: () => NOW });
  assert.equal(denied.status, 401);

  const doc = {
    id: DOC, revision: 1, application_id: null, title: "지원용 프로필", kind: "HUB_PROFILE",
    template: "SIMPLE", language: "ko", status: "DRAFT", latest_version_id: null,
    finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  };
  const owned = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [doc];
    if (sql.includes("FROM profiles")) return [{ display_name: "Ada", skills: ["Go"] }];
    return null;
  });
  const ok = await handle(postJson(`/api/v1/documents/${DOC}/base-profile`, {}, "00000000-0000-4000-8000-000000000071"), ENV, { query: owned.query, now: () => NOW });
  assert.equal(ok.status, 200);
  const load = owned.calls.find((call) => call.sql.includes("FROM documents WHERE id"));
  assert.equal(load?.sql.includes("user_id"), true);
  assert.equal(load?.params[1], USER);
  const write = profileWrite(owned.calls);
  assert.equal(write?.params[0], USER);

  const hidden = await handle(postJson(`/api/v1/documents/${DOC}/base-profile`, {}, "00000000-0000-4000-8000-000000000072"), ENV, { query: recorder(() => null).query, now: () => NOW });
  assert.equal(hidden.status, 404);
});

test("create accepts CAREER_STATEMENT and rejects an unknown kind", async () => {
  const { handle } = await import("../src/handler.ts");
  const APP = "a0000000-0000-4000-8000-000000000001";
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM applications")) return [{ id: APP }];
    return null;
  });
  const created = await handle(postJson("/api/v1/documents", {
    applicationId: APP, title: "경력기술서", kind: "CAREER_STATEMENT", template: "SIMPLE", language: "ko",
  }, "00000000-0000-4000-8000-000000000008"), ENV, { query, now: () => NOW });
  assert.equal(created.status, 201);
  const body = await created.json() as { data: { kind: string } };
  assert.equal(body.data.kind, "CAREER_STATEMENT");
  const insert = calls.find((call) => call.sql.includes("INSERT INTO documents"));
  assert.equal(insert?.params.includes("CAREER_STATEMENT"), true);

  const { query: rejectQuery } = recorder((sql) => {
    if (sql.includes("FROM applications")) return [{ id: APP }];
    return null;
  });
  const rejected = await handle(postJson("/api/v1/documents", {
    applicationId: APP, title: "경력기술서", kind: "LETTER", template: "SIMPLE", language: "ko",
  }, "00000000-0000-4000-8000-000000000009"), ENV, { query: rejectQuery, now: () => NOW });
  assert.equal(rejected.status, 400);
});

test("an export result can be recorded only once even when two reports race", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-000000000001";
  const EXP = "d0000000-0000-4000-8000-000000000002";
  const { query } = recorder((sql) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM document_exports")) {
      return [{ id: EXP, document_id: DOC, version_id: E1, format: "PDF", template: "SIMPLE", content: {}, blocks: [], content_hash: "h", status: "READY_TO_RENDER", renderer_version: "1", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }];
    }
    // The other report already moved the row out of READY_TO_RENDER.
    if (sql.startsWith("UPDATE document_exports")) return sql.includes("status = 'READY_TO_RENDER'") ? [] : [{ id: EXP }];
    return null;
  });
  const res = await handle(postJson(`/api/v1/documents/${DOC}/exports/${EXP}/result`, {
    sha256: "x", byteLength: 1, status: "SUCCEEDED",
  }, "00000000-0000-4000-8000-000000000006"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 409);
});

test("a new document version verifies all cited evidence in one query", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-000000000003";
  const { calls, query } = recorder((sql, params) => {
    if (sql.startsWith("SELECT") && sql.includes("FROM documents WHERE id = $1")) return [{ id: DOC, revision: 1, status: "DRAFT", title: "t", kind: "RESUME", template: "SIMPLE", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }];
    if (sql.includes("FROM career_evidence")) return [E1, E2, E3].map((id) => ({ id, source_text: "Go and Postgres", archived: false }));
    if (sql.startsWith("WITH upd AS")) return [{ number: 2 }];
    if (sql.includes("INSERT INTO ai_jobs")) return [{ id: params[0], queue: params[2] }];
    return null;
  });
  const blocks = [E1, E2, E3].map((eid, i) => ({ id: "b" + i, text: "Go", evidenceRefs: [{ evidenceId: eid, start: 0, end: 2 }, { evidenceId: E1, start: 3, end: 6 }] }));
  const content = { type: "doc", content: blocks.map((b) => ({ type: "paragraph", attrs: { blockId: b.id }, content: [{ type: "text", text: b.text }] })) };
  const res = await handle(postJson(`/api/v1/documents/${DOC}/versions`, { expectedRevision: 1, content, blocks }, "00000000-0000-4000-8000-000000000007"),
    ENV, { query, now: () => NOW });
  assert.equal(res.status, 201);
  assert.equal(calls.filter((c) => c.sql.includes("FROM career_evidence")).length, 1);
});

const SOURCE = "50000000-0000-4000-8000-0000000000a1";
const OTHER_SOURCE = "50000000-0000-4000-8000-0000000000a2";

test("a source the caller owns becomes an application profile document", async () => {
  const { handle } = await import("../src/handler.ts");
  const text = "# 경력\n백엔드";
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [];
    if (sql.includes("FROM sources WHERE id")) return [{
      id: SOURCE, file_name: "이력서.md", mime_type: "text/markdown",
      content: Buffer.from(text, "utf8").toString("base64"),
    }];
    return null;
  });
  const res = await handle(postJson(`/api/v1/documents/${SOURCE}/profile`, {}, "00000000-0000-4000-8000-0000000000a1"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { target: string; documentId: string; applicationId: string | null } };
  assert.equal(body.data.target, "application");
  assert.equal(body.data.applicationId, null);
  assert.notEqual(body.data.documentId, SOURCE);
  const insert = calls.find((call) => call.sql.includes("INSERT INTO documents"));
  assert.equal(insert?.params.includes("HUB_PROFILE"), true);
  assert.equal(insert?.sql.includes("INSERT INTO document_versions"), true);
  assert.equal(calls.some((call) => call.sql.includes("UPDATE profiles") || call.sql.includes("INSERT INTO profiles")), false);
  const version = calls.find((call) => call.sql.includes("document_versions"));
  assert.match(JSON.stringify(version?.params), /백엔드/);
});

test("a pdf source returns 202 and a job the app can follow", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql, params) => {
    if (sql.includes("FROM documents WHERE id")) return [];
    if (sql.includes("FROM sources WHERE id")) return [{
      id: SOURCE, file_name: "이력서.pdf", mime_type: "application/pdf", content: "",
    }];
    if (sql.includes("INSERT INTO ai_jobs")) return [{ id: params[0], queue: params[2] }];
    return null;
  });
  const res = await handle(postJson(`/api/v1/documents/${SOURCE}/profile`, {}, "00000000-0000-4000-8000-0000000000a2"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 202);
  const body = await res.json() as { data: { documentId: string; jobId: string } };
  assert.ok(body.data.documentId);
  assert.notEqual(body.data.documentId, SOURCE);
  assert.ok(body.data.jobId);
  const job = calls.find((call) => call.sql.includes("INSERT INTO ai_jobs"));
  assert.match(String(job?.params[7]), /profileDocumentId/);
  assert.match(String(job?.params[7]), new RegExp(SOURCE));
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO document_versions")), false);
});

test("another user's source is 404", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [];
    if (sql.includes("FROM sources WHERE id")) return [];
    return null;
  });
  const res = await handle(postJson(`/api/v1/documents/${OTHER_SOURCE}/profile`, {}, "00000000-0000-4000-8000-0000000000a3"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 404);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO documents")), false);
  const lookup = calls.find((call) => call.sql.includes("FROM sources"));
  assert.equal(lookup?.params[1], USER);
});

const heading = (id: string, text: string) => ({ type: "heading", attrs: { blockId: id }, content: [{ type: "text", text }] });
const paragraph = (id: string, text: string) => ({ type: "paragraph", attrs: { blockId: id }, content: [{ type: "text", text }] });

const profileContent = {
  type: "doc",
  content: [
    heading("h1", "헤드라인"),
    paragraph("p1", "한 줄"),
    heading("h2", "소개"),
    paragraph("p2", "소개 본문"),
    heading("h3", "경력"),
    paragraph("p3", "Acme | Backend | 2020-01-01 | 2021-01-01 | api"),
    heading("h4", "기술"),
    paragraph("p4", "Kotlin"),
    heading("h5", "링크"),
    paragraph("p5", "https://example.com"),
  ],
};

const profileDoc = (kind = "HUB_PROFILE") => ({
  id: "d0000000-0000-4000-8000-000000000090",
  revision: 2,
  application_id: null,
  title: "문서 제목",
  kind,
  template: "SIMPLE",
  language: "ko",
  status: "DRAFT",
  latest_version_id: "d0000000-0000-4000-8000-000000000091",
  finalized_version_id: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
});

const profileQuery = (kind = "HUB_PROFILE") => (sql: string) => {
  if (sql.includes("FROM documents WHERE id")) return [profileDoc(kind)];
  if (sql.includes("FROM document_versions")) return [{
    id: "d0000000-0000-4000-8000-000000000091",
    content: profileContent,
    blocks: [],
    created_at: "2026-10-01T00:00:00Z",
  }];
  if (sql.includes("FROM profiles")) return [{ skills: ["Go"] }];
  return null;
};

test("omitted sections on target hub still copies every present heading", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder(profileQuery());
  const res = await handle(postJson("/api/v1/documents/d0000000-0000-4000-8000-000000000090/profile", { target: "hub" }, "00000000-0000-4000-8000-000000000090"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { applied: string[] } };
  assert.deepEqual(body.data.applied, ["headline", "intro", "careers", "skills", "links"]);
  const update = profileWrite(calls);
  assert.equal(update?.params[1], "한 줄");
  assert.equal(update?.params[9], true);
  assert.equal(update?.params[11], true);
  assert.equal(update?.params[12], true);
  assert.equal(update?.params[13], true);
  assert.equal(update?.params[14], true);
  assert.equal(update?.sql.includes("ELSE profiles.careers"), true);
  assert.equal(update?.sql.includes("ELSE profiles.skills"), true);
  assert.equal(update?.sql.includes("ELSE profiles.intro"), true);
});

test("sections skills replaces skills only", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder(profileQuery());
  const res = await handle(postJson("/api/v1/documents/d0000000-0000-4000-8000-000000000090/profile", {
    target: "hub", sections: ["skills"],
  }, "00000000-0000-4000-8000-000000000091"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { applied: string[] } };
  assert.deepEqual(body.data.applied, ["skills"]);
  const update = profileWrite(calls);
  assert.equal(update?.params[9], false);
  assert.equal(update?.params[11], false);
  assert.equal(update?.params[12], true);
  assert.equal(update?.params[13], false);
  assert.equal(update?.params[14], false);
  assert.match(update?.sql ?? "", /ELSE profiles\.headline/);
  assert.match(update?.sql ?? "", /ELSE profiles\.intro/);
  assert.match(update?.sql ?? "", /ELSE profiles\.careers/);
  assert.match(update?.sql ?? "", /ELSE profiles\.skills/);
});

test("empty sections leaves the profile unchanged", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder(profileQuery());
  const res = await handle(postJson("/api/v1/documents/d0000000-0000-4000-8000-000000000090/profile", {
    target: "hub", sections: [],
  }, "00000000-0000-4000-8000-000000000092"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { applied: string[] } };
  assert.deepEqual(body.data.applied, []);
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO profiles") || call.sql.includes("UPDATE profiles")), false);
});

test("unknown section is 422 field sections", async () => {
  const { handle } = await import("../src/handler.ts");
  const { query } = recorder(profileQuery());
  const res = await handle(postJson("/api/v1/documents/d0000000-0000-4000-8000-000000000090/profile", {
    target: "hub", sections: ["projects"],
  }, "00000000-0000-4000-8000-000000000093"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 422);
  const body = await res.json() as { error: { details: { field: string } } };
  assert.equal(body.error.details.field, "sections");
});

test("sections without target hub is 422 field sections", async () => {
  const { handle } = await import("../src/handler.ts");
  const { query } = recorder(profileQuery());
  const res = await handle(postJson("/api/v1/documents/d0000000-0000-4000-8000-000000000090/profile", {
    sections: ["skills"],
  }, "00000000-0000-4000-8000-000000000094"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 422);
  const body = await res.json() as { error: { details: { field: string } } };
  assert.equal(body.error.details.field, "sections");
});

test("non hub profile kind still errors on kind", async () => {
  const { handle } = await import("../src/handler.ts");
  const { query } = recorder(profileQuery("RESUME"));
  const res = await handle(postJson("/api/v1/documents/d0000000-0000-4000-8000-000000000090/profile", {
    target: "hub", sections: ["skills"],
  }, "00000000-0000-4000-8000-000000000095"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: { details: { field: string } } };
  assert.equal(body.error.details.field, "kind");
});

test("base-profile sections intro does not overwrite headline", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder(profileQuery());
  const res = await handle(postJson("/api/v1/documents/d0000000-0000-4000-8000-000000000090/base-profile", {
    sections: ["intro"],
  }, "00000000-0000-4000-8000-000000000096"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { applied: string[] } };
  assert.deepEqual(body.data.applied, ["intro"]);
  const update = profileWrite(calls);
  assert.equal(update?.params[13], true);
  assert.equal(update?.params[14], false);
  assert.match(update?.sql ?? "", /ELSE profiles\.headline/);
});

test("empty base-profile body still sets headline from the title", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [profileDoc()];
    if (sql.includes("FROM document_versions")) return [{
      id: "d0000000-0000-4000-8000-000000000091",
      content: { type: "doc", content: [heading("h2", "소개"), paragraph("p2", "소개 본문")] },
      blocks: [],
      created_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.includes("FROM profiles")) return [{ skills: ["Go"] }];
    return null;
  });
  const res = await handle(postJson("/api/v1/documents/d0000000-0000-4000-8000-000000000090/base-profile", {}, "00000000-0000-4000-8000-000000000097"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { applied: string[] } };
  assert.equal(body.data.applied.includes("headline"), true);
  const update = profileWrite(calls);
  assert.equal(update?.params[1], "문서 제목");
  assert.equal(update?.params[14], true);
});

test("a version post that changes the intro keeps the career nodes", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-0000000000b0";
  let revision = 3;
  const { query } = recorder((sql, params) => {
    if (sql.includes("FROM documents WHERE id")) return [{
      id: DOC, revision, application_id: null, title: "서류", kind: "RESUME", template: "SIMPLE", language: "ko",
      status: "DRAFT", latest_version_id: null, finalized_version_id: null,
      created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.startsWith("WITH upd AS")) {
      revision += 1;
      return [{ number: 2 }];
    }
    if (sql.includes("INSERT INTO ai_jobs")) return [{ id: params[0], queue: params[2] }];
    return null;
  });
  const kept = "기존 경력";
  const content = {
    type: "doc",
    content: [
      heading("h-intro", "소개"),
      paragraph("p-intro", "새 소개"),
      heading("h-career", "경력"),
      paragraph("p-career", kept),
    ],
  };
  const blocks = [
    { id: "h-intro", text: "소개", evidenceRefs: [] },
    { id: "p-intro", text: "새 소개", evidenceRefs: [] },
    { id: "h-career", text: "경력", evidenceRefs: [] },
    { id: "p-career", text: kept, evidenceRefs: [] },
  ];
  const res = await handle(postJson(`/api/v1/documents/${DOC}/versions`, {
    expectedRevision: 3, content, blocks, changeNote: "intro",
  }, "00000000-0000-4000-8000-0000000000b0"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 201);
  const body = await res.json() as { data: { document: { revision: number }; version: { content: { content: { content: { text: string }[] }[] } } } };
  const texts = body.data.version.content.content.map((node) => node.content[0].text);
  assert.equal(texts[1], "새 소개");
  assert.equal(texts[3], kept);
  assert.equal(body.data.document.revision, 4);
  const again = await handle(postJson(`/api/v1/documents/${DOC}/versions`, {
    expectedRevision: 3, content, blocks, changeNote: "intro",
  }, "00000000-0000-4000-8000-0000000000b1"), ENV, { query, now: () => NOW });
  assert.equal(again.status, 409);
  const err = await again.json() as { error: { code: string; details: { currentRevision: number } } };
  assert.equal(err.error.code, "REVISION_CONFLICT");
  assert.equal(err.error.details.currentRevision, 4);
});

test("share returns the raw token once and a later GET returns the pinned version", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-0000000000c0";
  const VER = "d0000000-0000-4000-8000-0000000000c1";
  const pinned = { type: "doc", content: [{ type: "paragraph", text: "pinned" }] };
  const shares: { hash: string; versionId: string; revoked: boolean }[] = [];
  const query = recorder((sql, params) => {
    if (sql.includes("FROM documents WHERE id")) return [{
      id: DOC, user_id: USER, revision: 1, application_id: "a0000000-0000-4000-8000-0000000000c0", title: "이력서",
      kind: "RESUME", template: "SIMPLE", language: "ko", status: "DRAFT", latest_version_id: VER,
      finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.includes("FROM document_versions")) return [{ id: VER, content: pinned, blocks: [], created_at: "2026-10-01T00:00:00Z" }];
    if (sql.includes("INSERT INTO document_shares")) {
      for (const share of shares) share.revoked = true;
      shares.push({ hash: String(params[3]), versionId: String(params[2]), revoked: false });
      return [{ id: params[0] }];
    }
    if (sql.includes("token_hash")) {
      const hit = shares.find((share) => share.hash === String(params[0]) && !share.revoked);
      if (!hit) return [];
      return [{ title: "현재 제목", kind: "RESUME", content: pinned, blocks: [], userId: USER, applicationId: "a0000000-0000-4000-8000-0000000000c0" }];
    }
    return null;
  }).query;
  const created = await handle(postJson(`/api/v1/documents/${DOC}/share`, {}, "00000000-0000-4000-8000-0000000000c0"), ENV, { query, now: () => NOW });
  assert.equal(created.status, 200);
  const share = await created.json() as { data: { token: string; path: string; versionId: string } };
  assert.equal(share.data.path, `/api/v1/documents/shared/${share.data.token}`);
  assert.equal(share.data.versionId, VER);
  assert.notEqual(share.data.token, shares[0]?.hash);
  const read = await handle(new Request("https://core.example" + share.data.path), ENV, { query, now: () => NOW });
  assert.equal(read.status, 200);
  const body = await read.json() as { data: Record<string, unknown> };
  assert.deepEqual(body.data.content, pinned);
  assert.equal(body.data.title, "현재 제목");
  assert.equal("userId" in body.data, false);
  assert.equal("applicationId" in body.data, false);
});

test("a second share revokes the first token", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-0000000000d0";
  const VER = "d0000000-0000-4000-8000-0000000000d1";
  const shares: { hash: string; revoked: boolean }[] = [];
  const query = recorder((sql, params) => {
    if (sql.includes("FROM documents WHERE id")) return [{
      id: DOC, revision: 1, title: "이력서", kind: "RESUME", template: "SIMPLE", language: "ko", status: "DRAFT",
      latest_version_id: VER, application_id: null, finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.includes("FROM document_versions")) return [{ id: VER, content: { type: "doc", content: [] }, blocks: [] }];
    if (sql.includes("INSERT INTO document_shares")) {
      for (const share of shares) share.revoked = true;
      shares.push({ hash: String(params[3]), revoked: false });
      return [{ id: params[0] }];
    }
    if (sql.includes("token_hash")) {
      const hit = shares.find((share) => share.hash === String(params[0]) && !share.revoked);
      return hit ? [{ title: "이력서", kind: "RESUME", content: { type: "doc", content: [] }, blocks: [] }] : [];
    }
    return null;
  }).query;
  const first = await handle(postJson(`/api/v1/documents/${DOC}/share`, {}, "00000000-0000-4000-8000-0000000000d0"), ENV, { query, now: () => NOW });
  const firstBody = await first.json() as { data: { token: string } };
  const second = await handle(postJson(`/api/v1/documents/${DOC}/share`, {}, "00000000-0000-4000-8000-0000000000d1"), ENV, { query, now: () => NOW });
  const secondBody = await second.json() as { data: { token: string } };
  const oldRead = await handle(new Request(`https://core.example/api/v1/documents/shared/${firstBody.data.token}`), ENV, { query, now: () => NOW });
  assert.equal(oldRead.status, 404);
  assert.equal((await oldRead.json() as { error: { code: string } }).error.code, "NOT_FOUND");
  const newRead = await handle(new Request(`https://core.example/api/v1/documents/shared/${secondBody.data.token}`), ENV, { query, now: () => NOW });
  assert.equal(newRead.status, 200);
});

test("DELETE revokes and a second DELETE returns revoked false", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-0000000000e0";
  const VER = "d0000000-0000-4000-8000-0000000000e1";
  let active = false;
  const query = recorder((sql) => {
    if (sql.includes("FROM documents WHERE id")) return [{
      id: DOC, revision: 1, title: "이력서", kind: "RESUME", template: "SIMPLE", language: "ko", status: "DRAFT",
      latest_version_id: VER, application_id: null, finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.includes("FROM document_versions")) return [{ id: VER, content: {}, blocks: [] }];
    if (sql.includes("INSERT INTO document_shares")) {
      active = true;
      return [{ id: DOC }];
    }
    if (sql.includes("UPDATE document_shares")) {
      if (!active) return [];
      active = false;
      return [{ id: DOC }];
    }
    return null;
  }).query;
  const created = await handle(postJson(`/api/v1/documents/${DOC}/share`, {}, "00000000-0000-4000-8000-0000000000e0"), ENV, { query, now: () => NOW });
  assert.equal(created.status, 200);
  const once = await handle(new Request(`https://core.example/api/v1/documents/${DOC}/share`, {
    method: "DELETE", headers: { authorization: "Bearer t" },
  }), ENV, { query, now: () => NOW });
  assert.equal(once.status, 200);
  assert.equal((await once.json() as { data: { revoked: boolean } }).data.revoked, true);
  const twice = await handle(new Request(`https://core.example/api/v1/documents/${DOC}/share`, {
    method: "DELETE", headers: { authorization: "Bearer t" },
  }), ENV, { query, now: () => NOW });
  assert.equal(twice.status, 200);
  assert.equal((await twice.json() as { data: { revoked: boolean } }).data.revoked, false);
});

test("non-owner POST is 404", async () => {
  const { handle } = await import("../src/handler.ts");
  const { calls, query } = recorder(() => null);
  const res = await handle(postJson("/api/v1/documents/d0000000-0000-4000-8000-0000000000f0/share", {}, "00000000-0000-4000-8000-0000000000f0"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 404);
  assert.equal((await res.json() as { error: { code: string } }).error.code, "NOT_FOUND");
  assert.equal(calls.some((call) => call.sql.includes("document_shares")), false);
});

test("public GET does not include userId or applicationId", async () => {
  const { handle } = await import("../src/handler.ts");
  const { query } = recorder((sql) => {
    if (sql.includes("token_hash")) return [{
      title: "이력서", kind: "COVER_LETTER", content: { type: "doc", content: [] }, blocks: [],
      userId: USER, applicationId: "a0000000-0000-4000-8000-0000000000f1", documentId: "d0",
    }];
    return null;
  });
  const res = await handle(new Request("https://core.example/api/v1/documents/shared/tok"), ENV, { query, now: () => NOW });
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Record<string, unknown> };
  assert.deepEqual(Object.keys(body.data).sort(), ["blocks", "content", "kind", "title"]);
  assert.equal(body.data.kind, "COVER_LETTER");
});

test("missing document_shares returns SHARING_UNAVAILABLE", async () => {
  const { handle } = await import("../src/handler.ts");
  const DOC = "d0000000-0000-4000-8000-0000000000f2";
  const VER = "d0000000-0000-4000-8000-0000000000f3";
  const missing = Object.assign(new Error('relation "document_shares" does not exist'), { code: "42P01" });
  const query = recorder((sql) => {
    if (sql.includes("document_shares")) throw missing;
    if (sql.includes("FROM documents WHERE id")) return [{
      id: DOC, revision: 1, title: "이력서", kind: "RESUME", template: "SIMPLE", language: "ko", status: "DRAFT",
      latest_version_id: VER, application_id: null, finalized_version_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    }];
    if (sql.includes("FROM document_versions")) return [{ id: VER, content: {}, blocks: [] }];
    return null;
  }).query;
  const post = await handle(postJson(`/api/v1/documents/${DOC}/share`, {}, "00000000-0000-4000-8000-0000000000f2"), ENV, { query, now: () => NOW });
  assert.equal(post.status, 404);
  assert.equal((await post.json() as { error: { code: string; details: unknown } }).error.code, "SHARING_UNAVAILABLE");
  const del = await handle(new Request(`https://core.example/api/v1/documents/${DOC}/share`, {
    method: "DELETE", headers: { authorization: "Bearer t" },
  }), ENV, { query, now: () => NOW });
  assert.equal(del.status, 404);
  assert.equal((await del.json() as { error: { code: string } }).error.code, "SHARING_UNAVAILABLE");
  const get = await handle(new Request("https://core.example/api/v1/documents/shared/tok"), ENV, { query, now: () => NOW });
  assert.equal(get.status, 404);
  const got = await get.json() as { error: { code: string; details: unknown } };
  assert.equal(got.error.code, "SHARING_UNAVAILABLE");
  assert.equal(got.error.details, null);
});
