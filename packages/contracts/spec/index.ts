import { routes as accountRoutes, schemas as accountSchemas } from "./account.ts";
import { routes as careerRoutes, schemas as careerSchemas } from "./career.ts";
import { routes as conversationsRoutes, schemas as conversationsSchemas } from "./conversations.ts";
import { routes as documentsRoutes, schemas as documentsSchemas } from "./documents.ts";
import { routes as postingsRoutes, schemas as postingsSchemas } from "./postings.ts";
import { sharedSchemas } from './shared.ts';
import type { Route, Schema } from './shared.ts';
import { routes as socialRoutes, schemas as socialSchemas } from "./social.ts";
import { routes as botsRoutes, schemas as botsSchemas } from "./bots.ts";
import { routes as botApprovalsRoutes, schemas as botApprovalsSchemas } from "./bot-approvals.ts";
import { routes as botChatRoutes, schemas as botChatSchemas } from "./bot-chat.ts";
import { routes as botTranscriptRoutes, schemas as botTranscriptSchemas } from "./bot-transcript.ts";
import { routes as materialsRoutes, schemas as materialsSchemas } from "./materials.ts";

const areas = [
  { routes: accountRoutes, schemas: accountSchemas },
  { routes: botsRoutes, schemas: botsSchemas },
  { routes: botApprovalsRoutes, schemas: botApprovalsSchemas },
  { routes: botChatRoutes, schemas: botChatSchemas },
  { routes: botTranscriptRoutes, schemas: botTranscriptSchemas },
  { routes: careerRoutes, schemas: careerSchemas },
  { routes: conversationsRoutes, schemas: conversationsSchemas },
  { routes: documentsRoutes, schemas: documentsSchemas },
  { routes: materialsRoutes, schemas: materialsSchemas },
  { routes: postingsRoutes, schemas: postingsSchemas },
  { routes: socialRoutes, schemas: socialSchemas },
];

export const routes: Array<Route> = areas.flatMap((area) => area.routes);

const entries: Array<[string, Schema]> = [...Object.entries(sharedSchemas), ...areas.flatMap((area) => Object.entries(area.schemas))];
const seen = new Set<string>();
for (const [name] of entries) {
  if (seen.has(name)) {throw new Error(`duplicate schema ${name}`);}
  seen.add(name);
}

export const schemas = Object.fromEntries(entries);
