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
