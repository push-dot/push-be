import { HttpError, fieldError, parseUuid } from "./http.ts";
import { formatJsonTimestamp } from "./time.ts";

export type FieldKind = "str" | "int" | "num" | "bool" | "uuid" | "uuid[]" | "str[]" | "object" | "any";

export type FieldSpec = { kind: FieldKind; required?: boolean; nullable?: boolean };

export type Body = { values: Record<string, unknown>; present: Set<string> };

const invalid = (): HttpError => new HttpError(400, "VALIDATION_ERROR", "invalid request body");

const fits = (kind: FieldKind, value: unknown): unknown => {
  if (kind === "any") return value;
  if (kind === "str") return typeof value === "string" ? value : undefined;
  if (kind === "int") return typeof value === "number" && Number.isInteger(value) ? value : undefined;
  if (kind === "num") return typeof value === "number" ? value : undefined;
  if (kind === "bool") return typeof value === "boolean" ? value : undefined;
  if (kind === "uuid") return value == null ? undefined : parseUuid(String(value)) ?? undefined;
  if (kind === "object") return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => fits(kind === "uuid[]" ? "uuid" : "str", item));
  return items.some((item) => item === undefined) ? undefined : items;
};

/** Pydantic `extra="forbid", strict=True` for a JSON object body, as `bind_json` reads it. */
export const strictBody = async (request: Request, spec: Record<string, FieldSpec>): Promise<Body> => {
  const raw = await request.text();
  if (!raw) throw new HttpError(400, "VALIDATION_ERROR", "request body required");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw invalid(); }
  return strictObject(parsed, spec);
};

/** The same rules for a nested object (a sub-model of the request). */
export const strictObject = (parsed: unknown, spec: Record<string, FieldSpec>): Body => {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
  const input = parsed as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  const present = new Set<string>();
  for (const key of Object.keys(input)) if (!(key in spec)) throw invalid();
  for (const [key, field] of Object.entries(spec)) {
    if (!(key in input)) {
      if (field.required) throw invalid();
      continue;
    }
    present.add(key);
    const value = input[key];
    if (value === null) {
      if (!field.nullable) throw invalid();
      values[key] = null;
      continue;
    }
    const ok = fits(field.kind, value);
    if (ok === undefined) throw invalid();
    values[key] = ok;
  }
  return { values, present };
};

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/** `parse_time_field`: Python `datetime.fromisoformat`, naive means UTC. Returns the JSON timestamp. */
export const parseTimeField = (value: unknown, field: string): string => {
  const m = typeof value === "string" ? value.match(RFC3339) : null;
  if (!m) throw fieldError(field, "must be RFC3339");
  const [, y, mo, d, h = "00", mi = "00", s = "00", frac, zone = "Z"] = m;
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const valid = day.getUTCFullYear() === Number(y) && day.getUTCMonth() === Number(mo) - 1
    && day.getUTCDate() === Number(d) && Number(h) < 24 && Number(mi) < 60 && Number(s) < 60;
  if (!valid) throw fieldError(field, "must be RFC3339");
  return formatJsonTimestamp(`${y}-${mo}-${d}T${h}:${mi}:${s}${frac ? "." + frac : ""}${zone.toUpperCase()}`);
};
