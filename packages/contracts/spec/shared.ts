export type Schema = Record<string, unknown>;
export type Owner = "gateway" | "core" | "ai";
export type Auth = "user" | "public" | "optional";
export type Method = "get" | "post" | "put" | "patch" | "delete";

export interface RouteSpec {
  tag: string;
  summary: string;
  auth?: Auth;
  params?: Schema[];
  body?: Schema;
  responses: Record<string, Schema>;
  description?: string;
}

export interface Route {
  method: Method;
  path: string;
  owner: Owner;
  spec: RouteSpec;
}

export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

export const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });

export const obj = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({
  type: "object",
  properties,
  required,
});

export const arr = (items: Schema): Schema => ({ type: "array", items });

export const str: Schema = { type: "string" };
export const int: Schema = { type: "integer" };
export const num: Schema = { type: "number" };
export const bool: Schema = { type: "boolean" };
export const uuid: Schema = { type: "string", format: "uuid" };
export const dateTime: Schema = { type: "string", format: "date-time" };
export const date: Schema = { type: "string", format: "date" };
export const any: Schema = {};
export const enumOf = (...values: string[]): Schema => ({ type: "string", enum: values });

const json = (schema: Schema): Schema => ({ content: { "application/json": { schema } } });

export const body = (schema: Schema, required = true): Schema => ({ required, ...json(schema) });

export const raw = (schema: Schema, description = "OK"): Schema => ({ description, ...json(schema) });

export const ok = (schema: Schema, description = "OK"): Schema => raw(obj({ data: schema }), description);

export const okPage = (item: Schema, description = "OK"): Schema => raw(obj({ data: arr(item), page: ref("Page") }), description);

export const okList = (item: Schema, description = "OK"): Schema => ok(arr(item), description);

export const noContent: Schema = { description: "No Content" };

export const redirect = (description: string): Schema => ({
  description,
  headers: { Location: { schema: str } },
});

export const binary = (mediaType: string, description = "File bytes"): Schema => ({
  description,
  content: { [mediaType]: { schema: { type: "string", format: "binary" } } },
});

export const sse = (events: Record<string, Schema>, description = "Server-sent events"): Schema => ({
  description: `${description}. Events: ${Object.keys(events).join(", ")}.`,
  content: { "text/event-stream": { schema: str } },
  "x-sse-events": events,
});

export const pathParam = (name: string, schema: Schema = uuid): Schema => ({ name, in: "path", required: true, schema });

export const query = (name: string, schema: Schema = str, description?: string): Schema => ({
  name,
  in: "query",
  required: false,
  schema,
  ...(description ? { description } : {}),
});

export const pageParams: Schema[] = [
  query("limit", { type: "integer", minimum: 1, maximum: 100, default: 50 }),
  query("cursor", str, "Opaque cursor from page.nextCursor"),
];

const route = (method: Method) => (owner: Owner, path: string, spec: RouteSpec): Route => ({ method, path, owner, spec });

export const get = route("get");
export const post = route("post");
export const put = route("put");
export const patch = route("patch");
export const del = route("delete");

export const sharedSchemas: Record<string, Schema> = {
  Error: obj({
    error: obj({
      code: { type: "string", description: "VALIDATION_ERROR, UNAUTHENTICATED, FORBIDDEN, CONSENT_REQUIRED, NOT_FOUND, CONFLICT, REVISION_CONFLICT, IDEMPOTENCY_CONFLICT, RATE_LIMITED, PHONE_CODE_INVALID, PHONE_CODE_EXPIRED, PHONE_TAKEN, NOT_CONFIGURED, INTERNAL, ..." },
      message: str,
      requestId: str,
      details: nullable({ type: "object", additionalProperties: true }),
    }),
  }),
  Page: obj({
    nextCursor: nullable(str),
    hasMore: bool,
    total: int,
  }, ["nextCursor", "hasMore"]),
};
