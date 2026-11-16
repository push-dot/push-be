import { convertQwertyToHangul, disassemble, getChoseong } from "es-hangul";

export interface SearchFields {
  text: string;
  choseong: string;
  jamo: string;
}

function compact(value: string): string {
  return value.replace(/\s+/g, "");
}

/** Choseong and jamo columns filled the way feature-spec 0.1 describes. */
export function searchFields(text: string): SearchFields {
  const normalized = text.normalize("NFC");
  return {
    text: normalized,
    choseong: compact(getChoseong(normalized)),
    jamo: compact(disassemble(normalized)),
  };
}

export interface QueryForms {
  raw: string;
  choseong: string;
  jamo: string;
  hangul: string;
  hangulJamo: string;
}

/** Makes `s` literal for LIKE/ILIKE ... ESCAPE '\': the user's `%` and `_` stay characters, not wildcards. */
export const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => "\\" + c);

export const likeContains = (s: string): string => "%" + likeEscape(s) + "%";

/** Every field is escaped for LIKE/ILIKE ... ESCAPE '\'; an empty field stays empty. */
export function queryForms(q: string): QueryForms {
  const raw = q.normalize("NFC").trim();
  const ascii = /^[a-zA-Z]+$/.test(raw);
  const hangul = ascii ? convertQwertyToHangul(raw) : "";
  const basis = hangul || raw;
  const fields = searchFields(basis);
  return {
    raw: likeEscape(raw),
    choseong: likeEscape(fields.choseong),
    jamo: ascii ? "" : likeEscape(fields.jamo),
    hangul: likeEscape(hangul),
    hangulJamo: hangul ? likeEscape(searchFields(hangul).jamo) : "",
  };
}
