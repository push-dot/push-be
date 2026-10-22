import assert from "node:assert/strict";
import { test } from "node:test";

import { HttpError } from "../src/http.ts";
import { codePointSlice, computeQuality, hunkEdits, replaced, validateDocumentContent } from "../src/document-content.ts";

test("hunk edits pair removed and added lines like the python helper", () => {
  assert.deepEqual(hunkEdits([{ line: 1, sign: "-", text: "3년" }, { line: 1, sign: "+", text: "4년" }]), [["3년", "4년"]]);
  assert.deepEqual(hunkEdits([{ line: 1, sign: "", text: "백엔드 개발" }, { line: 2, sign: "+", text: "API 설계" }]),
    [["백엔드 개발", "백엔드 개발\nAPI 설계"]]);
  assert.throws(() => hunkEdits([{ sign: "+", text: "x" }]), (err) => err instanceof HttpError && err.status === 400);
});

test("replacements copy the version and touch only the first match", () => {
  const content = { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "b1" }, content: [{ type: "text", text: "a $& a" }] }] };
  const blocks = [{ id: "b1", text: "a $& a", evidenceRefs: [], claimStatus: "" }];
  const out = replaced(content, blocks, [["a", "$1"]]);
  assert.equal(out.applied, true);
  assert.equal(out.blocks[0].text, "$1 $& a");
  assert.equal(blocks[0].text, "a $& a");
  assert.equal(replaced(content, blocks, [["zzz", "y"]]).applied, false);
  assert.equal(replaced(content, blocks, []).applied, false);
});

test("content rules and code point ranges follow the python checks", () => {
  assert.equal(codePointSlice("😀ab", 0, 1), "😀");
  assert.equal(codePointSlice("ab", 1, 3), null);
  assert.throws(() => validateDocumentContent({ type: "doc", content: [{ type: "paragraph", attrs: { blockId: "a" }, content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "https://user:pw@x.example" } }] }] }] }, [{ id: "a", text: "x", evidenceRefs: [], claimStatus: "" }]),
    (err) => err instanceof HttpError && err.message === "url must not contain credentials");
  assert.deepEqual(computeQuality([]).evidenceFidelity, null);
});
