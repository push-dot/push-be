import type { Route, Schema } from "./shared.ts";
import { get, post, del, ref, obj, arr, str, int, bool, uuid, dateTime, date, nullable, enumOf, ok, noContent, pathParam, query } from "./shared.ts";

const kind = pathParam("kind", { ...enumOf("file", "document", "posting", "link"), description: "file is an uploaded or bot-made file, document a Push document, posting a bookmark, link a saved link." });
const id = pathParam("id", uuid);
const tag = (name: string): Schema => ({ type: "string", const: name });
const createdBy = { ...nullable(ref("BotRef")), description: "The bot that made it. null when the user made it, or when that bot was deleted." };
const origin = enumOf("UPLOAD", "AI");

const material = {
  description: "A material of the caller. doc is file and document, bookmark is posting, link is link.",
  oneOf: [
    obj({
      kind: tag("file"), id: uuid, title: str, mimeType: str, size: int, pageCount: nullable(int), origin, createdBy,
      updatedAt: { ...dateTime, description: "When the file was saved." },
    }),
    obj({
      kind: tag("document"), id: uuid, title: str, docKind: str, origin, createdBy,
      updatedAt: { ...dateTime, description: "The document's last edit." },
    }),
    obj({
      kind: tag("posting"), id: uuid, title: str, company: str, deadline: nullable(date),
      closed: { ...bool, description: "The posting no longer takes applications." },
      careerMin: nullable(int), careerMax: nullable(int), employmentType: nullable(str), location: nullable(str),
      bookmarkedAt: dateTime,
    }),
    obj({
      kind: tag("link"), id: uuid, title: { ...str, description: "The saved title, or the url when the title is empty." }, url: str,
      host: { ...str, description: "The url's host name in lower case. The app marks a linkedin.com link from it: LinkedIn is not a link kind." },
      linkKind: enumOf("job", "github", "portfolio", "blog", "other"),
      addedAt: dateTime,
      lastCheckedAt: { ...nullable(dateTime), description: "When a bot last opened the link. null until one has." },
      lastCheckOk: { ...nullable(bool), description: "Whether that open succeeded." },
    }),
  ],
};

const section = enumOf("doc", "bookmark", "link");

const materialsPage = obj({
  counts: { ...obj({ doc: int, bookmark: int, link: int }), description: "Every section, after q and bot." },
  sections: arr(obj({ section, items: arr(ref("Material")), nextCursor: nullable(str) })),
});

export const schemas: Record<string, Schema> = {
  Material: material,
  MaterialsPage: materialsPage,
  MaterialDetail: {
    allOf: [
      ref("Material"),
      obj({ usedBy: { ...arr(ref("BotRef")), description: "The bot that made it first, then the bots whose chat it was attached in, most recent first." } }),
    ],
  },
};

const keptForThirtyDays = "A deleted material leaves every list at once, is kept 30 days, and is then erased. Until then POST /materials/{kind}/{id}/restore brings it back.";

export const routes: Route[] = [
  get("core", "/api/v1/materials", {
    tag: "materials",
    summary: "List the caller's materials",
    description: "Files and Push documents (doc), bookmarked postings (bookmark), and saved links (link), each newest first. A file is sorted by when it was saved, a document by its last edit. tab=all gives the first 4 docs, 3 bookmarks and 3 links with no cursor. Another tab gives that section, paged. q keeps materials whose name contains it, without letter case: a file's name, a document's title or its application's company, a posting's company or title, a link's title or url. bot keeps the materials that bot made or that were attached in its chat. 404 when bot is not the caller's.",
    params: [
      query("tab", { ...enumOf("all", "doc", "bookmark", "link"), default: "all" }),
      query("q", { type: "string", maxLength: 200 }, "Outer spaces are dropped. Empty is no filter."),
      query("bot", str, "A bot id, or push for the caller's Push Bot."),
      query("limit", { type: "integer", minimum: 1, maximum: 100, default: 20 }, "Rows per page of a section tab. A larger integer is clamped to 100."),
      query("cursor", str, "Opaque cursor from the section's nextCursor"),
    ],
    responses: { 200: ok(ref("MaterialsPage")) },
  }),
  get("core", "/api/v1/materials/{kind}/{id}", {
    tag: "materials",
    summary: "Get one material with the bots that used it",
    description: "404 for a deleted material.",
    params: [kind, id],
    responses: { 200: ok(ref("MaterialDetail")) },
  }),
  del("core", "/api/v1/materials/{kind}/{id}", {
    tag: "materials",
    summary: "Delete a material",
    description: `${keptForThirtyDays} Messages keep the title they were sent with. 409 INVALID_TRANSITION with details.reason REFERENCED_BY_EVIDENCE and details.evidenceCount when career evidence cites the file. A material that is deleted already, by an earlier or a concurrent request, answers 204 again and is not changed. 404 when the caller has no such material, live or kept.`,
    params: [kind, id],
    responses: { 204: noContent },
  }),
  post("core", "/api/v1/materials/{kind}/{id}/restore", {
    tag: "materials",
    summary: "Undo the delete of a material",
    description: `${keptForThirtyDays} Answers the material as it is listed. A material that is not deleted is answered as it is. 404 once it was erased.`,
    params: [kind, id],
    responses: { 200: ok(ref("Material")) },
  }),
];
