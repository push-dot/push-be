// Reads SQL captured by register.mjs and prints a psql script that PREPAREs every unique
// statement inside one DO block, collects failures, prints them, and exits non-zero if
// there are any. Nothing is executed: PREPARE only parses, resolves names and types.
// Usage: node prepare.mjs /tmp/sql.jsonl | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f -
import { readFileSync } from "node:fs";

const PREPARABLE = /^\s*(WITH|SELECT|INSERT|UPDATE|DELETE|VALUES)\b/i;
const statements = [...new Set(
  readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
)].filter((sql) => PREPARABLE.test(sql)).sort();

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
