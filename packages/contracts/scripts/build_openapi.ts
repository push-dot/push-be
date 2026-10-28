import { writeFileSync } from "node:fs";

import { routes, schemas } from "../spec/index.ts";
import type { Route, Schema } from "../spec/shared.ts";

const IDEMPOTENCY_KEY = { $ref: "#/components/parameters/IdempotencyKey" };

const sortDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortDeep(record[key])]));
  }
  return value;
};

const operationIdOf = (method: string, path: string): string => {
  const scoped = path.startsWith("/api/v1/") ? path.slice("/api/v1".length) : `/root${path}`;
  const words = scoped.replace(/\{(\w+)\}/g, "By-$1").split(/[/_-]/).filter(Boolean);
  return method + words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
};

const operationOf = ({ method, path, owner, spec }: Route): Schema => {
  const auth = spec.auth ?? "user";
  const needsKey = method === "post" && auth === "user" && !path.endsWith("/stream");
  const params = [...(spec.params ?? []), ...(needsKey ? [IDEMPOTENCY_KEY] : [])];
  return {
    operationId: operationIdOf(method, path),
    tags: [spec.tag],
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    "x-owner": owner,
    ...(auth === "public" ? { security: [] } : auth === "optional" ? { security: [{}, { bearer: [] }] } : {}),
    ...(params.length ? { parameters: params } : {}),
    ...(spec.body ? { requestBody: spec.body } : {}),
    responses: { ...spec.responses, default: { $ref: "#/components/responses/Error" } },
  };
};

const danglingRefs = (spec: Schema): string[] => {
  const text = JSON.stringify(spec);
  const names = new Set(Object.keys(schemas));
  return [...text.matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]).filter((name) => !names.has(name));
};

export const buildSpec = (): Schema => {
  const paths: Record<string, Record<string, Schema>> = {};
  const operationIds = new Set<string>();
  for (const r of routes) {
    const item = (paths[r.path] ??= {});
    if (item[r.method]) throw new Error(`duplicate route ${r.method.toUpperCase()} ${r.path}`);
    item[r.method] = operationOf(r);
    const id = String(item[r.method].operationId);
    if (operationIds.has(id)) throw new Error(`duplicate operationId ${id}`);
    operationIds.add(id);
  }
  const spec = sortDeep({
    openapi: "3.1.0",
    info: {
      title: "Push API",
      version: "1.0.0",
      description: "Every route a client can call through the gateway. x-owner names the worker that answers it. Webhooks, /internal and AI worker act-as routes are not listed.",
    },
    servers: [{ url: "/" }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      parameters: {
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          description: "UUID. A retry with the same key and body replays the first response.",
          schema: { type: "string", format: "uuid" },
        },
      },
      responses: {
        Error: {
          description: "Error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
      schemas,
    },
  }) as Schema;
  const dangling = danglingRefs(spec);
  if (dangling.length) throw new Error(`unknown schemas: ${[...new Set(dangling)].join(", ")}`);
  return spec;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL("../openapi.json", import.meta.url);
  writeFileSync(out, JSON.stringify(buildSpec(), null, 2) + "\n");
  console.log(`wrote ${out.pathname} (${routes.length} operations)`);
}
