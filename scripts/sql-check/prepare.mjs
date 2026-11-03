// Reads SQL captured by register.mjs and prints a psql script that PREPAREs every unique
// statement inside one DO block, collects failures, prints them, and exits non-zero if
// there are any. Nothing is executed: PREPARE only parses, resolves names and types.
import { readFileSync } from "node:fs";

// Usage: node prepare.mjs <statements.jsonl> [--source <fragments.jsonl>...]
// With --source, a statement is kept only if it contains one of the source's SQL
// fragments, so made-up SQL inside the tests' own fakes ("UPDATE t") is not checked.
const PREPARABLE = /^\s*(WITH|SELECT|INSERT|UPDATE|DELETE|VALUES)\b/i;
const [input, flag, ...sources] = process.argv.slice(2);
const read = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const norm = (s) => s.replace(/\s+/g, " ").trim();
const known = flag === "--source"
  ? sources.flatMap(read).flatMap((f) => norm(f.fragment).split(/\{[^}]*\}|\$\{[^}]*\}/)).map((p) => p.trim()).filter((p) => p.length >= 12)
  : null;
const statements = [...new Set(read(input))]
  .filter((sql) => PREPARABLE.test(sql))
  .filter((sql) => !known || known.some((part) => norm(sql).includes(part)))
  .sort();

const quote = (sql, n) => {
  const tag = "$s" + n + "$";
  if (sql.includes(tag)) throw new Error("statement contains " + tag);
  return tag + sql + tag;
};

const out = ["CREATE TEMP TABLE prepare_failures (statement text, sqlstate text, message text);", "DO $do$ BEGIN"];
statements.forEach((sql, i) => {
  const text = quote(sql, i);
  out.push(
    "  BEGIN EXECUTE 'PREPARE p" + i + " AS ' || " + text + "; EXECUTE 'DEALLOCATE p" + i + "';"
    + " EXCEPTION WHEN others THEN INSERT INTO prepare_failures VALUES (" + text + ", SQLSTATE, SQLERRM); END;",
  );
});
out.push("END $do$;");
out.push("\\echo checked " + statements.length + " statements");
out.push("SELECT sqlstate, message, left(regexp_replace(statement, '\\s+', ' ', 'g'), 400) AS statement FROM prepare_failures ORDER BY message;");
out.push("DO $$ BEGIN IF EXISTS (SELECT 1 FROM prepare_failures) THEN RAISE EXCEPTION '% statements failed PREPARE', (SELECT count(*) FROM prepare_failures); END IF; END $$;");
process.stdout.write(out.join("\n") + "\n");
