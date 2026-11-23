type SchemaValue = string | number | boolean | null | Array<SchemaValue> | { [key: string]: SchemaValue };
export type Schema = Record<string, SchemaValue>;
export type Owner = "gateway" | "core" | "ai";
export type Auth = "user" | "public" | "optional";
export type Method = "get" | "post" | "put" | "patch" | "delete";

export interface RouteSpec {
  tag: string;
  summary: string;
  auth?: Auth;
  params?: Array<Schema>;
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

export const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export const nullable = (schema: Schema) => ({ anyOf: [schema, { type: "null" }] });

export const obj = (properties: Record<string, Schema>, required: Array<string> = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
});

export const closed = (properties: Record<string, Schema>, required?: Array<string>) => ({
  ...obj(properties, required),
  additionalProperties: false,
});

export const arr = (items: Schema) => ({ type: "array", items });

export const str = { type: "string" };
export const int = { type: "integer" };
export const num = { type: "number" };
export const bool = { type: "boolean" };
export const uuid = { type: "string", format: "uuid" };
export const dateTime = { type: "string", format: "date-time" };
export const date = { type: "string", format: "date" };
export const any = {};
export const enumOf = (...values: Array<string>) => ({ type: "string", enum: values });

const json = (schema: Schema) => ({ content: { "application/json": { schema } } });

export const body = (schema: Schema, required = true) => ({ required, ...json(schema) });

export const raw = (schema: Schema, description = "OK") => ({ description, ...json(schema) });

export const ok = (schema: Schema, description = "OK") => raw(obj({ data: schema }), description);

export const okPage = (item: Schema, description = "OK") => raw(obj({ data: arr(item), page: ref("Page") }), description);

export const okList = (item: Schema, description = "OK") => ok(arr(item), description);

export const noContent = { description: "No Content" };

export const redirect = (description: string) => ({
  description,
  headers: { Location: { schema: str } },
});

export const binary = (mediaType: string, description = "File bytes") => ({
  description,
  content: { [mediaType]: { schema: { type: "string", format: "binary" } } },
});

export const sse = (events: Record<string, Schema>, description = "Server-sent events") => ({
  description: `${description}. Events: ${Object.keys(events).join(", ")}.`,
  content: { "text/event-stream": { schema: str } },
  "x-sse-events": events,
});

export const pathParam = (name: string, schema: Schema = uuid) => ({ name, in: "path", required: true, schema });

export const query = (name: string, schema: Schema = str, description?: string) => {
  const param = { name, in: "query", required: false, schema };
  return description ? { ...param, description } : param;
};

export const pageParams: Array<Schema> = [
  query("limit", { type: "integer", minimum: 1, maximum: 100, default: 50 }, "1 to 100. A larger integer is clamped to 100. Zero or a non-integer is 400."),
  query("cursor", str, "Opaque cursor from page.nextCursor"),
];

const route = (method: Method) => (owner: Owner, path: string, spec: RouteSpec): Route => ({ method, path, owner, spec });

export const get = route("get");
export const post = route("post");
export const put = route("put");
export const patch = route("patch");
export const del = route("delete");

export const sharedSchemas = {
  Error: obj({
    error: obj({
      code: { type: "string", description: "VALIDATION_ERROR, UNAUTHENTICATED, INVALID_CREDENTIALS, FORBIDDEN, CONSENT_REQUIRED, FEATURE_DISABLED, BUSINESS_NOT_VERIFIED, PLAN_REQUIRED, NOT_FOUND, CONFLICT, REVISION_CONFLICT, IDEMPOTENCY_CONFLICT, APPROVAL_ALREADY_RESOLVED, APPROVAL_EXPIRED, APPROVAL_REQUIRED, APPROVAL_STALE, UNSUPPORTED_CLAIM, INVALID_TRANSITION, ALREADY_SUBSCRIBED, ADMIN_TRANSFER_REQUIRED, REAUTH_REQUIRED, EMAIL_NOT_VERIFIED, EMAIL_TAKEN, COMPANY_EXISTS, INTEGRATION_REQUIRED, DOCUMENT_NOT_FINALIZED, RATE_LIMITED, QUEUE_BUSY, PAYLOAD_TOO_LARGE, INSUFFICIENT_CREDITS, PHONE_CODE_INVALID, PHONE_CODE_EXPIRED, PHONE_TAKEN, NOT_CONFIGURED, PROVIDER_ERROR, TOKEN_EXPIRED, BLOCKED, INTERNAL, BOT_LIMIT, DEFAULT_BOT_PROTECTED, ..." },
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
