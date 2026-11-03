// Rewrites one known line per service inside the test process only. If a line moves,
// the hook throws so the capture never silently records nothing.
const APPEND = "(await import(\"node:fs\")).appendFileSync(process.env.SQL_CAPTURE, JSON.stringify(text) + \"\\n\");";

const TARGETS = [
  {
    // core: every statement goes through query() in src/db.ts
    suffix: "/services/core-api/src/db.ts",
    mark: "const result = await q(text, params);",
    inject: (mark) => APPEND + " " + mark,
  },
  {
    // gateway: routes call deps.query directly, so wrap it where requests enter
    suffix: "/services/gateway/src/handler.ts",
    mark: "export async function handle(request: Request, env: FrontEnv, deps: Deps): Promise<Response> {",
    inject: (mark) => mark + " { const inner = deps.query; deps = { ...deps, query: (async (text: string, params?: unknown[]) => { "
      + APPEND + " return inner(text, params); }) as Deps[\"query\"] }; }",
  },
];

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const target = TARGETS.find((t) => url.endsWith(t.suffix));
  if (!target) return result;
  const source = String(result.source);
  if (!source.includes(target.mark)) throw new Error("sql-check: " + target.suffix + " changed; update scripts/sql-check/hooks.mjs");
  return { ...result, source: source.replace(target.mark, target.inject(target.mark)) };
}
