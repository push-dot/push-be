import type { Route } from "./shared.ts";
import { get, patch, del, ref, obj, closed, arr, str, uuid, dateTime, body, ok, noContent, pathParam } from "./shared.ts";

const id = pathParam("id");
const text = { ...str, minLength: 1, maxLength: 300, description: "One fact the bots keep about the user, in Korean. Outer spaces are dropped." };

export const schemas = {
  UserMemory: obj({ id: uuid, text: str, createdAt: dateTime, updatedAt: dateTime }),
  UpdateUserMemoryBody: closed({ text }, ["text"]),
};

export const routes: Array<Route> = [
  get("core", "/api/v1/me/memories", {
    tag: "me",
    summary: "List what the bots remember about the user",
    description: "Newest change first, at most 200. Every bot of the user reads these at the start of a turn; the AI service writes them with its remember tool.",
    responses: { 200: ok(arr(ref("UserMemory"))) },
  }),
  del("core", "/api/v1/me/memories", {
    tag: "me",
    summary: "Forget everything",
    responses: { 204: noContent },
  }),
  patch("core", "/api/v1/me/memories/{id}", {
    tag: "me",
    summary: "Correct a memory",
    params: [id],
    body: body(ref("UpdateUserMemoryBody")),
    responses: { 200: ok(ref("UserMemory")) },
  }),
  del("core", "/api/v1/me/memories/{id}", {
    tag: "me",
    summary: "Forget one memory",
    params: [id],
    responses: { 204: noContent },
  }),
];
