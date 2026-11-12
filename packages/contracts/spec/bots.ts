import type { Route, Schema } from "./shared.ts";
import {
  get, post, patch, del, ref, obj, closed, arr, str, bool, uuid, dateTime, date, nullable, int, num, enumOf,
  body, ok, raw, noContent, pathParam, query,
} from "./shared.ts";

const id = pathParam("id", { type: "string", description: "A bot id, or the literal push for the caller's Push Bot." });

const botColor = ref("BotColor");
const botKind = enumOf("push", "company");
const displayName = { type: "string", minLength: 1, maxLength: 120, description: "Outer spaces are dropped. A name of spaces only is 400." };
const phase = (name: string): Schema => ({ type: "string", const: name });

const botStatus = { type: "string", enum: ["DONE", "RUNNING", "NEEDS_APPROVAL"] };

const botActivity = {
  description: "What the bot's thread is doing. since is the run's start for queued, thinking and working, and the card's asking time for waiting.",
  oneOf: [
    obj({ phase: phase("queued"), since: dateTime, ahead: { ...int, description: "The caller's own chat runs that started before this one and are not finished." } }),
    obj({ phase: phase("thinking"), since: dateTime, label: { ...nullable(str), description: "The newest working sentence of this run." } }),
    obj({ phase: phase("working"), since: dateTime, label: str }),
    obj({ phase: phase("waiting"), since: dateTime, for: enumOf("answer", "confirm"), cardId: uuid, cardTitle: str, expiresAt: nullable(dateTime) }),
  ],
};

const bot = obj({
  id: uuid,
  kind: botKind,
  displayName: str,
  companyName: str,
  color: { ...nullable(botColor), description: "null exactly when kind is push." },
  postingId: nullable(uuid),
  notificationsMuted: bool,
  revision: int,
  createdAt: dateTime,
  lastActivityAt: { ...dateTime, description: "The newest of: the bot was made, its newest message, its open card. The list is ordered by it." },
  lastMessage: nullable(obj({ preview: { type: "string", maxLength: 140 }, at: dateTime, fromBot: bool })),
  unread: { ...bool, description: "The bot wrote a message or asked a card after the caller last read it." },
  activity: { ...nullable(botActivity), description: "null when nothing runs and no card is open." },
  companyId: { ...nullable(uuid), deprecated: true, description: "Always null." },
  postingUrl: { ...nullable(str), deprecated: true },
  avatarKey: { ...nullable(str), deprecated: true },
  mascotKey: { ...nullable(str), deprecated: true },
  updatedAt: { ...dateTime, deprecated: true },
  lastMessagePreview: { ...str, deprecated: true, description: "lastMessage.preview, or an empty string." },
  status: { ...botStatus, deprecated: true, description: "NEEDS_APPROVAL for a waiting activity, RUNNING for any other activity, else DONE." },
});

const planLimit = { ...nullable(int), description: "null is unlimited." };

const botLimit = obj({
  plan: enumOf("FREE", "PRO", "ULTRA"),
  max: planLimit,
  used: { ...int, description: "The caller's company bots. The Push Bot is not counted." },
  table: obj({ FREE: int, PRO: int, ULTRA: planLimit }),
});

const botList = obj({ data: arr(ref("Bot")), limit: ref("BotLimit") }, ["data"]);

const botDetail = {
  allOf: [
    ref("Bot"),
    obj({
      posting: { ...nullable(obj({ id: uuid, title: str, deadline: nullable(date), closed: bool })), description: "null for the Push Bot and when the posting is gone." },
      fit: { ...nullable(obj({ score: num })), description: "The newest fit score computed for this posting, 0 to 10. null until one exists." },
      materialCount: { ...int, description: "The bot's materials: made by it or attached in its chat. GET /materials?bot= lists them." },
    }),
  ],
};

const botRef = obj({ id: uuid, kind: botKind, displayName: str, color: nullable(botColor) });

const botSearch = obj({
  bots: arr({ allOf: [ref("Bot"), obj({ line: { ...str, description: "Company and posting title joined by a middle dot, or the display name when the bot has no posting." } })] }),
  botTotal: int,
  messages: arr(obj({
    bot: ref("BotRef"),
    messageId: uuid,
    at: dateTime,
    role: enumOf("USER", "ASSISTANT"),
    snippet: { ...str, description: "Up to 30 characters before the first match and 60 after it. Starts with an ellipsis when the text before it was cut." },
  })),
  messageTotal: int,
});

const linkPreview = {
  oneOf: [
    closed({
      status: { type: "string", const: "found" },
      postingId: uuid,
      company: str,
      title: str,
      deadline: nullable(date),
      careerMin: int,
      careerMax: nullable(int),
      location: nullable(str),
      host: { ...str, description: "The host of the url that was sent." },
    }),
    closed({ status: { type: "string", const: "not_a_posting" } }, ["status"]),
  ],
};

const createBotBody = closed({ postingId: uuid, displayName, color: botColor }, ["postingId"]);

const updateBotBody = closed({
  expectedRevision: int,
  displayName,
  notificationsMuted: bool,
  color: botColor,
}, ["expectedRevision"]);

export const schemas: Record<string, Schema> = {
  BotColor: enumOf("teal", "sky", "blue", "violet", "pink", "red", "coral", "amber", "green", "brown", "gray"),
  BotActivity: botActivity,
  Bot: bot,
  BotLimit: botLimit,
  BotList: botList,
  BotDetail: botDetail,
  BotRef: botRef,
  BotSearch: botSearch,
  CreateBotBody: createBotBody,
  UpdateBotBody: updateBotBody,
  BotLinkPreview: linkPreview,
};

export const routes: Route[] = [
  get("core", "/api/v1/bots", {
    tag: "bots",
    summary: "List the caller's bots, or find the bot of a posting's company",
    description: "Without postingId: every bot, the Push Bot first and then by lastActivityAt, newest first. Not paged. limit says how many company bots the plan allows and how many exist. Makes the Push Bot when it is missing. With postingId: zero or one bot, the caller's company bot for that posting's company, compared as POST /bots compares it, and no limit. An unknown or draft posting gives an empty list.",
    params: [query("postingId", uuid, "A posting id. Narrows the list to the caller's bot for that posting's company.")],
    responses: { 200: raw(ref("BotList")) },
  }),
  post("core", "/api/v1/bots", {
    tag: "bots",
    summary: "Open the company bot of a posting, creating it when the caller has none for that company",
    description: "One bot per company: the company is the posting's company name, compared without case and outer spaces. 201 when created. 200 with the existing bot when the caller already has one for that company; displayName and color are ignored then. Any other body key is 400. 403 CONSENT_REQUIRED without reference-data consent. 403 BOT_LIMIT, on the create path only, when the personal plan cap is reached (FREE 3, PRO 20, ULTRA unlimited). Push bot does not count. 404 when the posting does not exist, is a draft, or has a blank company name.",
    body: body(ref("CreateBotBody")),
    responses: { 200: ok(ref("Bot"), "The caller already has a bot for that company"), 201: ok(ref("Bot"), "Created") },
  }),
  post("core", "/api/v1/bots/link-preview", {
    tag: "bots",
    summary: "Resolve a job posting URL before creating a bot",
    description: "Resolves only a posting Push already has, by the id in the url or by the posting's source url. No page is fetched. A draft posting and a posting with a blank company are not_a_posting, as POST /bots answers 404 for them.",
    body: body(closed({ url: str }, ["url"])),
    responses: { 200: ok(ref("BotLinkPreview")) },
  }),
  get("core", "/api/v1/bots/search", {
    tag: "bots",
    summary: "Search the caller's bots and the messages of their chats",
    description: "bots holds every bot whose display name, company name or posting title contains q, in list order. messages holds the messages of the caller's bot chats whose text contains q, newest first, and page pages them. Matching ignores letter case. % and _ in q are plain characters. 400 when q is missing, blank, or longer than 200 characters.",
    params: [
      { ...query("q", { type: "string", minLength: 1, maxLength: 200 }), required: true },
      query("limit", { type: "integer", minimum: 1, maximum: 50, default: 20 }, "Message hits per page. A larger integer is clamped to 50."),
      query("cursor", str, "Opaque cursor from page.nextCursor"),
    ],
    responses: { 200: raw(obj({ data: ref("BotSearch"), page: ref("Page") })) },
  }),
  get("core", "/api/v1/bots/{id}", {
    tag: "bots",
    summary: "Get a bot profile",
    params: [id],
    responses: { 200: ok(ref("BotDetail")) },
  }),
  patch("core", "/api/v1/bots/{id}", {
    tag: "bots",
    summary: "Update a bot",
    description: "The Push bot accepts notificationsMuted only. Any other body key is 400.",
    params: [id],
    body: body(ref("UpdateBotBody")),
    responses: { 200: ok(ref("Bot")) },
  }),
  del("core", "/api/v1/bots/{id}", {
    tag: "bots",
    summary: "Delete a company bot and erase its chat",
    description: "Deletes the bot with its thread, messages, jobs, events, cards, workspace files, work-done notifications and read marker. Usage rows stay. 403 DEFAULT_BOT_PROTECTED for the Push bot.",
    params: [id],
    responses: { 204: noContent },
  }),
  del("core", "/api/v1/bots/{id}/transcript", {
    tag: "bots",
    summary: "Erase a bot's chat and keep the bot",
    description: "Deletes the thread with its messages, jobs, events, cards, workspace files and work-done notifications. The bot, its settings and its read marker stay. 204 when the bot has no thread.",
    params: [id],
    responses: { 204: noContent },
  }),
  post("core", "/api/v1/bots/{id}/read", {
    tag: "bots",
    summary: "Mark a bot read",
    params: [id],
    responses: { 200: ok(closed({ readAt: dateTime }, ["readAt"])) },
  }),
];
