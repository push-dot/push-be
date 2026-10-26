import * as account from "./account.ts";
import * as career from "./career.ts";
import * as conversations from "./conversations.ts";
import * as documents from "./documents.ts";
import * as postings from "./postings.ts";
import { sharedSchemas, type Route, type Schema } from "./shared.ts";
import * as social from "./social.ts";

const areas = [account, career, conversations, documents, postings, social];

export const routes: Route[] = areas.flatMap((area) => area.routes);

export const schemas: Record<string, Schema> = { ...sharedSchemas };
for (const area of areas) {
  for (const [name, schema] of Object.entries(area.schemas)) {
    if (schemas[name]) throw new Error(`duplicate schema ${name}`);
    schemas[name] = schema;
  }
}
