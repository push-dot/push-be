// Test-only. With SQL_CAPTURE=<file>, Node loads hooks.mjs, which appends every SQL
// statement the core and gateway tests send to <file> (one JSON string per line).
// prepare.mjs turns that file into a psql script that PREPAREs each statement on a
// migrated Postgres. The in-memory fakes accept any SQL; PREPARE does not, so this
// catches parameter type conflicts and missing tables or columns.
// Usage: SQL_CAPTURE=/tmp/sql.jsonl node --import <repo>/scripts/sql-check/register.mjs --test ...
import { register } from "node:module";

if (process.env.SQL_CAPTURE) register("./hooks.mjs", import.meta.url);
