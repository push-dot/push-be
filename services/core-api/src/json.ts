/** A value JSON.parse returns and a json/jsonb column decodes to. */
export type Json = string | number | boolean | null | Array<Json> | JsonObject;

export interface JsonObject {
  [key: string]: Json;
}
