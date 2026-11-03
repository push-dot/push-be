// Fails unless every piece of SQL in the source is inside a statement that gets PREPAREd.
//   sites:     call arguments that build SQL at runtime (extract-ts / extract-py SITES)
//   fragments: every SQL-looking string in the source (extract-ts / extract-py FRAGMENTS)
// A piece is covered when a checked statement (constant-folded or captured from tests)
// contains it. Python format placeholders ({}) split a fragment into parts that must
// each appear.
// Usage: node coverage.mjs --sites <file>... --fragments <file>... --checked <file>...
import { existsSync, readFileSync } from "node:fs";

const lines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const norm = (s) => s.replace(/\s+/g, " ").trim();
const groups = { "--sites": [], "--fragments": [], "--checked": [] };
let current = null;
for (const arg of process.argv.slice(2)) {
  if (arg in groups) current = groups[arg];
  else current?.push(arg);
}
const checked = groups["--checked"].flatMap(lines).map(norm);
const covered = (text) => norm(text).split(/\{[^}]*\}|\$\{[^}]*\}/).map((p) => p.trim()).filter((p) => p.length >= 6)
  .every((part) => checked.some((sql) => sql.includes(part)));
let failed = 0;
for (const [label, paths] of [["dynamic site", groups["--sites"]], ["SQL fragment", groups["--fragments"]]]) {
  const items = paths.flatMap(lines);
  const missing = items.filter((item) => !covered(item.fragment));
  for (const item of missing) console.log(`${item.file}:${item.line}  ${label}  ${norm(item.fragment).slice(0, 110)}`);
  console.log(`sql-check coverage: ${items.length - missing.length}/${items.length} ${label}s are in a checked statement`);
  failed += missing.length;
}
if (failed > 0) {
  console.log("Run each line above from a test (see services/core-api/test/sql-paths.test.ts) or make the SQL constant.");
  process.exit(1);
}
