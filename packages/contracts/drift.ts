import { readFileSync } from "node:fs";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const SAMPLE_ID = "12345678-1234-5678-1234-567812345678";

interface Parameter {
  in?: string;
  name?: string;
  schema?: { example?: string };
}

interface Operation {
  "x-owner": "gateway" | "core" | "ai";
  parameters?: Parameter[];
}

export interface SpecRoute {
  method: string;
  template: string;
  owner: Operation["x-owner"];
  path: string;
}

const spec = JSON.parse(readFileSync(new URL("./openapi.json", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
};

const concretize = (template: string, params: Parameter[] = []): string =>
  template.replace(/\{(\w+)\}/g, (_, name: string) => params.find((p) => p.in === "path" && p.name === name)?.schema?.example ?? SAMPLE_ID);

export const specRoutes: SpecRoute[] = Object.entries(spec.paths).flatMap(([template, item]) =>
  Object.entries(item).map(([method, op]) => ({
    method: method.toUpperCase(),
    template,
    owner: op["x-owner"],
    path: concretize(template, op.parameters),
  })));

export const shapeOf = (template: string): string => template.replace(/\{[^}]*\}/g, "{}");

const templateRegex = (template: string): RegExp =>
  new RegExp(`^${shapeOf(template).split("{}").map((part) => part.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join("[^/]+")}$`);

const matches = (template: string, path: string): boolean => template === path || templateRegex(template).test(path);

export const specRouteFor = (method: string, path: string): SpecRoute | undefined =>
  specRoutes.find((r) => r.method === method && matches(r.template, path));

export const INTERNAL_ROUTES: [string, string][] = [
  ["POST", "/api/v1/billing/webhook"],
  ["POST", "/api/v1/billing/webhook/app-store"],
  ["POST", "/api/v1/billing/webhook/google-play"],
  ["POST", "/api/v1/conversations/{id}/resume-jobs"],
  ["POST", "/api/v1/documents/{id}/edits"],
];

export const isInternal = (method: string, path: string): boolean =>
  path.startsWith("/api/v1/internal/") || INTERNAL_ROUTES.some(([m, template]) => m === method && matches(template, path));

const expand = (pattern: string): string[] => {
  const open = pattern.indexOf("(");
  if (open < 0) return [pattern];
  let depth = 0;
  let close = open;
  for (; close < pattern.length; close++) {
    if (pattern[close] === "(") depth++;
    if (pattern[close] === ")" && --depth === 0) break;
  }
  const optional = pattern[close + 1] === "?";
  const inner = pattern.slice(open + 1, close);
  const alternatives: string[] = [];
  let level = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "(") level++;
    if (inner[i] === ")") level--;
    if (inner[i] === "|" && level === 0) {
      alternatives.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  alternatives.push(inner.slice(start));
  if (optional) alternatives.push("");
  const rest = pattern.slice(close + (optional ? 2 : 1));
  return alternatives.flatMap((alt) => expand(pattern.slice(0, open) + alt + rest));
};

const shapesOfRegex = (source: string): string[] =>
  expand(source
    .replace(/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/g, "{}")
    .replace(/\(\[\^\/\]\+\)|\[\^\/\]\+|\(\[a-z-\]\+\)/g, "{}")
    .replace(/\\\//g, "/")
    .replace(/\(\?:/g, "("));

// shortcut: reads `/^\/api\/v1...$/` regexes and "/api/v1..." strings from source; a route built another way is only seen through the spec side.
export const sourceShapes = (files: string[]): string[] => {
  const shapes = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\/\^((?:\\.|\[[^\]\n]*\]|[^/\\[\n])*)\$\/[a-z]*/g)) {
      for (const shape of shapesOfRegex(m[1])) if (shape.startsWith("/api/v1/") || shape === "/healthz") shapes.add(shape);
    }
    for (const m of text.matchAll(/"(\/api\/v1\/[^"]*[^/"]|\/healthz)"/g)) shapes.add(m[1]);
  }
  return [...shapes].sort();
};

export const candidatePaths = (files: string[]): string[] => {
  const paths = new Set(specRoutes.map((r) => r.path));
  for (const shape of sourceShapes(files)) {
    const known = specRoutes.find((r) => shapeOf(r.template) === shape);
    paths.add(known ? known.path : shape.replaceAll("{}", SAMPLE_ID));
  }
  return [...paths].sort();
};
