/** Timestamp formatting that matches the Python API (`jsonutil._ts`, cursors). */

export interface UtcParts {
  y: string;
  mo: string;
  d: string;
  h: string;
  mi: string;
  s: string;
  micros: number;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

export function parseUtc(value: unknown): UtcParts {
  if (value instanceof Date) {
    return fromEpoch(value.getTime(), value.getUTCMilliseconds() * 1000);
  }
  const s = String(value).trim();
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/,
  );
  if (!m) {
    const date = new Date(s);
    if (Number.isNaN(date.getTime())) {
      throw new Error("bad timestamp");
    }
    return fromEpoch(date.getTime(), date.getUTCMilliseconds() * 1000);
  }
  const frac = (m[7] || "").padEnd(6, "0").slice(0, 6);
  const micros = Number(frac || "0");
  const zone = m[8] || "Z";
  let offsetMin = 0;
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || "0"));
  }
  const ms = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]) - offsetMin, Number(m[6]),
    Math.floor(micros / 1000),
  );
  return fromEpoch(ms, micros);
}

function fromEpoch(ms: number, micros: number): UtcParts {
  const date = new Date(ms);
  return {
    y: String(date.getUTCFullYear()),
    mo: pad(date.getUTCMonth() + 1),
    d: pad(date.getUTCDate()),
    h: pad(date.getUTCHours()),
    mi: pad(date.getUTCMinutes()),
    s: pad(date.getUTCSeconds()),
    micros,
  };
}

function base(p: UtcParts): string {
  return `${p.y}-${p.mo}-${p.d}T${p.h}:${p.mi}:${p.s}`;
}

/** JSON timestamps keep 6 fractional digits when any microsecond is set. */
export function formatJsonTimestamp(value: unknown): string {
  const p = parseUtc(value);
  if (!p.micros) return base(p) + "Z";
  return base(p) + "." + pad(p.micros, 6) + "Z";
}

/** Cursors keep every microsecond. The id after the timestamp breaks ties. */
export function formatCursorTimestamp(value: unknown): string {
  return formatJsonTimestamp(value);
}

export function encodeCursor(createdAt: unknown, id: string): string {
  const raw = `${formatCursorTimestamp(createdAt)}|${id}`;
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeCursor(s: string): { createdAt: string; id: string } {
  try {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const raw = atob(s.replaceAll("-", "+").replaceAll("_", "/") + pad);
    const split = raw.indexOf("|");
    if (split <= 0) throw new Error("bad cursor");
    const createdAt = raw.slice(0, split);
    const id = raw.slice(split + 1);
    if (!createdAt || !id) throw new Error("bad cursor");
    parseUtc(createdAt);
    return { createdAt, id };
  } catch {
    throw new Error("bad cursor");
  }
}

/** `json.dumps` separators used by FastAPI (`", "` / `": "`). */
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (ch) => {
      return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
    });
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => pyJson(item)).join(", ") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return "{" + Object.keys(obj).map((k) => JSON.stringify(k) + ": " + pyJson(obj[k])).join(", ") + "}";
  }
  return "null";
}
