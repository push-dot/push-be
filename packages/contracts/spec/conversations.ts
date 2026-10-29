import type { Route, Schema } from "./shared.ts";
import {
  get, post, patch, del, ref, nullable, obj, arr, str, int, num, bool, uuid, dateTime, any, enumOf,
  body, ok, okPage, noContent, sse, pathParam, query, pageParams,
} from "./shared.ts";

const id = pathParam("id");

const seq = { type: "integer", description: "chat_events id; send back as ?after= or Last-Event-ID to resume" };

const option = obj({ id: str, label: str });

const sseError = obj({
  code: str,
  message: str,
  details: nullable({ type: "object", additionalProperties: true }),
}, ["code", "message"]);

const chatEvents: Record<string, Schema> = {
  status: obj({ type: enumOf("status"), text: str, seq }),
  token: obj({ type: enumOf("token"), text: str, seq }),
  tool: obj({
    type: enumOf("tool"),
    name: str,
    state: enumOf("run", "ok", "err", "wait"),
    summary: str,
    tier: str,
    result: any,
    seq,
  }, ["type", "name", "state", "summary", "seq"]),
  todo: obj({
    type: enumOf("todo"),
    items: arr(obj({ id: any, text: str, state: enumOf("todo", "now", "done") })),
    seq,
  }),
  diff: obj({
    type: enumOf("diff"),
    documentId: str,
    revisionId: str,
    hunks: arr(obj({ line: nullable(int), sign: enumOf("+", "-", ""), text: str })),
    seq,
  }),
  approval: obj({
    type: enumOf("approval"),
    id: uuid,
    kind: enumOf("DOCUMENT_EDIT", "TOOL_ACTION"),
    title: str,
    summary: str,
    toolName: str,
    args: { type: "object", additionalProperties: true },
    documentId: str,
    options: arr(option),
    seq,
  }, ["type", "id", "kind", "title", "options", "seq"]),
  choice: obj({
    type: enumOf("choice"),
    id: str,
    kind: enumOf("RESUME_GATE"),
    title: str,
    gate: str,
    recommended: str,
    auto: bool,
    options: arr(option),
    seq,
  }, ["type", "id", "options", "seq"]),
  fit: obj({
    type: enumOf("fit"),
    score: num,
    parts: obj({ techStack: int, experienceLink: int, keyword: int }),
    topGap: str,
    seq,
  }),
  file: obj({
    type: enumOf("file"),
    name: str,
    mime: str,
    fileId: str,
    documentId: { type: "string", description: "Empty string when the document was not synced" },
    downloadUrl: { type: "string", description: "Relative to /api/v1, e.g. /conversations/{id}/artifacts/{name}" },
    seq,
  }),
  done: obj({
    type: enumOf("done"),
    operation: nullable(ref("Operation")),
    awaiting: enumOf("approval", "choice"),
    seq,
  }, ["type", "operation", "seq"]),
  error: obj({ type: enumOf("error"), error: sseError, seq }, ["type", "error"]),
  cancelled: obj({ type: enumOf("cancelled"), seq }),
};

const chatStreamDescription = "Frames are `id: <seq>` + `data: <json>` with no `event:` line; the event name is the JSON `type` field. "
  + "The stream starts with `retry: 400` and closes after done, error, or cancelled, or after SSE_MAX_POLLS polls (default 20) without a terminal event; reconnect via GET .../messages/stream/active with ?after=<last seq>. "
  + "done with `awaiting` means the turn paused for an approval or choice card (operation is null). A stream-level failure emits an error frame without seq.";

const postMessageBody = body(obj({
  text: { type: "string", minLength: 1, maxLength: 20000 },
  context: obj({
    documentId: nullable(uuid),
    versionId: nullable(uuid),
    evidenceIds: arr(uuid),
  }, []),
  ai: nullable(obj({
    provider: enumOf("OPENAI", "OPENROUTER", "CLAUDE", "GEMINI", "GROK"),
    model: { type: "string", minLength: 1 },
    effort: { ...enumOf("LOW", "MEDIUM", "HIGH", "MAX"), description: "Ignored. The plan sets it: personal FREE LOW, PRO MEDIUM, ULTRA HIGH; employer BASIC MEDIUM, PRO HIGH, ULTRA MAX." },
    ultraResume: { type: "boolean", description: "Requires the ULTRA plan" },
    webSearch: bool,
    models: { type: "object", additionalProperties: true },
  }, ["provider", "model"])),
  accessMode: { ...enumOf("ALWAYS_ASK", "AUTO", "BYPASS", "SUGGEST", "CONFIRM_ACTIONS"), description: "SUGGEST maps to AUTO, CONFIRM_ACTIONS to ALWAYS_ASK; defaults to the saved user setting" },
  intent: enumOf("posting", "review", "interview", "general"),
  applicationId: nullable(uuid),
}, ["text"]));

const chatJob = obj({
  id: uuid,
  type: enumOf("CHAT_MESSAGE"),
  applicationId: { type: "null" },
  status: enumOf("QUEUED"),
  progress: { type: "null" },
  result: obj({ kind: enumOf("CHAT_MESSAGE"), value: obj({ jobId: uuid }) }),
  error: { type: "null" },
  inputRequest: { type: "null" },
  createdAt: dateTime,
  updatedAt: dateTime,
});

const expectedRevision = obj({ expectedRevision: int });

export const routes: Route[] = [
  get("gateway", "/api/v1/conversations", {
    tag: "conversations",
    summary: "List conversations",
    description: "audience=EMPLOYER lists the caller's company conversations (403 BUSINESS_NOT_VERIFIED without a company); otherwise personal ones. Archived conversations are excluded unless archived=true. Ordered by updatedAt desc.",
    params: [
      ...pageParams,
      query("applicationId", uuid),
      query("q", str, "Case-insensitive match on title or last message text"),
      query("audience", enumOf("PERSONAL", "EMPLOYER")),
      query("archived", enumOf("true", "false"), "true lists only archived conversations. Any other value excludes them."),
    ],
    responses: { 200: okPage(ref("ConversationsListItem")) },
  }),
  post("core", "/api/v1/conversations", {
    tag: "conversations",
    summary: "Create a conversation",
    description: "audience=EMPLOYER creates a company conversation (verified company members only; postingId/applicationId allowed). Unknown keys are rejected. A personal create is 403 CONSENT_REQUIRED until reference data consent is on. Employer creates are not gated.",
    body: body(obj({
      title: { type: "string", maxLength: 300 },
      audience: enumOf("PERSONAL", "EMPLOYER"),
      applicationId: nullable(uuid),
      postingId: { ...nullable(uuid), description: "EMPLOYER only" },
    }, ["title"])),
    responses: { 201: ok(ref("Conversation"), "Created") },
  }),
  patch("core", "/api/v1/conversations/{id}", {
    tag: "conversations",
    summary: "Rename or pin a conversation",
    params: [id],
    body: body(obj({
      expectedRevision: int,
      title: nullable({ type: "string", maxLength: 300 }),
      pinned: nullable(bool),
    }, ["expectedRevision"])),
    responses: { 200: ok(ref("Conversation")) },
  }),
  post("core", "/api/v1/conversations/{id}/archive", {
    tag: "conversations",
    summary: "Archive a conversation",
    description: "Also deletes company conversation PDF attachments and archives career evidence referenced only by this conversation.",
    params: [id],
    body: body(expectedRevision),
    responses: { 200: ok(ref("Conversation")) },
  }),
  post("core", "/api/v1/conversations/{id}/unarchive", {
    tag: "conversations",
    summary: "Unarchive a conversation",
    description: "Same caller and expectedRevision rules as archive. Does not restore evidence or attachments removed by archive.",
    params: [id],
    body: body(expectedRevision),
    responses: { 200: ok(ref("Conversation")) },
  }),
  del("core", "/api/v1/conversations/{id}", {
    tag: "conversations",
    summary: "Delete a conversation",
    description: "A personal conversation is deleted by its owner. A company conversation is deleted only by a company admin. Removes the conversation, its messages, chat jobs, and workspace files. Approvals, attachments, and shares cascade.",
    params: [id],
    responses: { 204: noContent },
  }),
  get("gateway", "/api/v1/conversations/{id}/messages", {
    tag: "conversations",
    summary: "List messages",
    description: "Newest first. In a personal conversation only the caller's messages are returned; company conversations show every member's.",
    params: [id, ...pageParams],
    responses: { 200: okPage(ref("Message")) },
  }),
  post("core", "/api/v1/conversations/{id}/messages", {
    tag: "conversations",
    summary: "Send a message (queue a chat job)",
    description: "Stores the USER message, rejects pending approval cards, and queues an AI job. Follow the reply via GET .../messages/stream/active. 403 CONSENT_REQUIRED on a personal conversation when reference data consent is off. Employer conversations are not gated. 403 FEATURE_DISABLED when the monthly AI credit is used up or ultraResume without ULTRA; 503 NOT_CONFIGURED without managed AI; 429 QUEUE_BUSY with details.retryAfterSec; employer interview intent is plan-gated.",
    params: [id],
    body: postMessageBody,
    responses: { 202: ok(chatJob, "Accepted") },
  }),
  post("gateway", "/api/v1/conversations/{id}/messages/stream", {
    tag: "conversations",
    summary: "Send a message and stream the reply",
    description: "Same body and checks as POST .../messages; a non-202 result from core is returned as is. " + chatStreamDescription,
    params: [id],
    body: postMessageBody,
    responses: { 200: sse(chatEvents, "Chat reply stream") },
  }),
  get("gateway", "/api/v1/conversations/{id}/messages/stream/active", {
    tag: "conversations",
    summary: "Replay the active chat stream",
    description: "Streams events of the newest PENDING/RUNNING chat job after the given seq; 204 when no job is running. " + chatStreamDescription,
    params: [
      id,
      query("after", { type: "integer", minimum: 0 }, "Resume after this seq; the Last-Event-ID header is used when absent"),
      { name: "Last-Event-ID", in: "header", required: false, schema: str },
    ],
    responses: { 200: sse(chatEvents, "Chat reply stream"), 204: { description: "No active chat job" } },
  }),
  post("gateway", "/api/v1/conversations/{id}/stream/cancel", {
    tag: "conversations",
    summary: "Cancel the active chat job",
    description: "409 CONFLICT when no job is running. The open stream receives a cancelled event.",
    params: [id],
    responses: { 200: ok(obj({ jobId: uuid, status: enumOf("CANCELLED") })) },
  }),
  post("core", "/api/v1/conversations/{id}/attachments", {
    tag: "conversations",
    summary: "Upload a PDF attachment",
    description: "Company conversations only (verified company, plan-gated pdf_attachment). PDF only, max 10 MiB (413 PAYLOAD_TOO_LARGE).",
    params: [id],
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: obj({ file: { type: "string", format: "binary", contentMediaType: "application/pdf" } }),
        },
      },
    },
    responses: { 201: ok(obj({ id: uuid, fileName: str, mimeType: enumOf("application/pdf") }), "Created") },
  }),
  post("core", "/api/v1/conversations/{id}/approvals/{approvalId}", {
    tag: "conversations",
    summary: "Answer a chat approval or choice card",
    description: "optionId must be one of the card's options. 409 APPROVAL_ALREADY_RESOLVED, 410 APPROVAL_EXPIRED. Returns 202 with jobId when the answer resumes the chat job (TOOL_ACTION, RESUME_GATE, or job-bound cards), 200 with jobId when a DOCUMENT_EDIT apply is queued, else 200 without jobId.",
    params: [id, pathParam("approvalId")],
    body: body(obj({ optionId: { type: "string", minLength: 1 } })),
    responses: {
      200: ok(ref("ConversationsApprovalAnswer")),
      202: ok(ref("ConversationsApprovalAnswer"), "Accepted; chat job resumed"),
    },
  }),
  get("core", "/api/v1/conversations/{id}/artifacts/{artifactId}", {
    tag: "conversations",
    summary: "Download a conversation artifact",
    description: "artifactId is the artifact file name (e.g. final.md, final.pdf), URL-encoded. Served as an attachment; type by extension.",
    params: [id, pathParam("artifactId", str)],
    responses: {
      200: {
        description: "File bytes",
        content: Object.fromEntries(
          ["application/pdf", "text/markdown", "application/json", "text/plain", "application/octet-stream"]
            .map((type) => [type, { schema: { type: "string", format: "binary" } }]),
        ),
      },
    },
  }),
  get("ai", "/api/v1/conversations/{id}/artifacts", {
    tag: "conversations",
    summary: "List document artifacts attached to messages",
    params: [id],
    responses: { 200: ok(arr(ref("Artifact"))) },
  }),
  post("ai", "/api/v1/conversations/{id}/share", {
    tag: "conversations",
    summary: "Create a share link",
    description: "Issues a new token; any previous token for the conversation stops working.",
    params: [id],
    responses: { 200: ok(obj({ token: str, path: str })) },
  }),
  get("ai", "/api/v1/conversations/shared/{token}", {
    tag: "conversations",
    summary: "Read a shared conversation",
    description: "Returns the newest 500 messages, oldest first. Rate-limited per IP.",
    auth: "public",
    params: [pathParam("token", str)],
    responses: {
      200: ok(obj({
        title: str,
        messages: arr(obj({ role: str, text: str, createdAt: dateTime })),
      })),
    },
  }),
  get("ai", "/api/v1/approvals", {
    tag: "approvals",
    summary: "List approvals",
    params: [
      ...pageParams,
      query("applicationId", uuid),
      query("status", enumOf("PENDING", "APPROVED", "DENIED", "EXPIRED", "CONSUMED")),
    ],
    responses: { 200: okPage(ref("Approval")) },
  }),
  post("ai", "/api/v1/approvals", {
    tag: "approvals",
    summary: "Request an approval",
    description: "Hashes the current target so a later change makes the approval stale. Expires after the default TTL.",
    body: body(obj({
      kind: enumOf("EVIDENCE_USE", "DOCUMENT_FINALIZE", "APPLICATION_SUBMIT", "CLI_EXECUTE"),
      applicationId: nullable(uuid),
      targetId: uuid,
      targetRevision: nullable(int),
    }, ["kind", "targetId"])),
    responses: { 201: ok(ref("Approval"), "Created") },
  }),
  get("ai", "/api/v1/approvals/{id}", {
    tag: "approvals",
    summary: "Get an approval with its target summary",
    params: [id],
    responses: { 200: ok(obj({ approval: ref("Approval"), target: ref("ConversationsApprovalTarget") })) },
  }),
  post("ai", "/api/v1/approvals/{id}/decision", {
    tag: "approvals",
    summary: "Approve or deny",
    description: "Only EVIDENCE_USE, DOCUMENT_FINALIZE, APPLICATION_SUBMIT, CLI_EXECUTE approvals; chat cards use POST /conversations/{id}/approvals/{approvalId}. An expired approval is marked EXPIRED and the call fails.",
    params: [id],
    body: body(obj({ expectedRevision: int, decision: enumOf("APPROVED", "DENIED") })),
    responses: { 200: ok(ref("Approval")) },
  }),
  get("ai", "/api/v1/operations/{id}", {
    tag: "operations",
    summary: "Get an operation",
    params: [id],
    responses: { 200: ok(ref("Operation")) },
  }),
  get("ai", "/api/v1/operations/{id}/events", {
    tag: "operations",
    summary: "Operation state snapshot as SSE",
    description: "One-shot, not a live feed: emits progress, then result or error when terminal, then closes. Frames use `event: <name>` and `id: <operationId>:<sequence>`; data is {operationId, sequence, payload}. Poll to observe later transitions.",
    params: [id],
    responses: {
      200: sse({
        progress: ref("ConversationsOperationEventProgress"),
        result: ref("ConversationsOperationEventResult"),
        error: ref("ConversationsOperationEventError"),
      }, "Operation snapshot"),
    },
  }),
  post("ai", "/api/v1/operations/{id}/input", {
    tag: "operations",
    summary: "Submit input to an operation awaiting it",
    description: "Only when status is NEEDS_INPUT; otherwise an invalid transition error.",
    params: [id],
    body: body(obj({
      fields: { type: "object", additionalProperties: str, default: {} },
      sourceId: nullable(uuid),
    }, [])),
    responses: { 200: ok(ref("Operation")) },
  }),
  post("ai", "/api/v1/operations/{id}/cancel", {
    tag: "operations",
    summary: "Cancel an operation",
    params: [id],
    responses: { 200: ok(ref("Operation")) },
  }),
];

const opEvent = (payload: Schema): Schema => obj({ operationId: uuid, sequence: int, payload });

export const schemas: Record<string, Schema> = {
  Conversation: obj({
    id: uuid,
    revision: int,
    applicationId: nullable(uuid),
    title: str,
    pinned: bool,
    createdAt: dateTime,
    updatedAt: dateTime,
  }),
  ConversationsListItem: obj({
    id: uuid,
    revision: int,
    applicationId: nullable(uuid),
    title: str,
    pinned: bool,
    createdAt: dateTime,
    updatedAt: dateTime,
    status: enumOf("NEEDS_APPROVAL", "RUNNING", "DONE"),
    lastMessagePreview: { type: "string", maxLength: 140 },
    createdBy: obj({ displayName: str }),
    postingId: nullable(uuid),
  }),
  Message: obj({
    id: uuid,
    conversationId: uuid,
    role: { type: "string", description: "USER or ASSISTANT" },
    text: str,
    attachments: arr(ref("ConversationsMessageAttachment")),
    operationId: nullable(uuid),
    createdAt: dateTime,
  }),
  ConversationsMessageAttachment: obj({
    type: { type: "string", description: "e.g. DOCUMENT_VERSION, EVIDENCE" },
    id: str,
    documentId: str,
    title: str,
  }, ["type", "id"]),
  ConversationsApprovalAnswer: obj({
    id: uuid,
    status: enumOf("APPROVED", "REJECTED"),
    optionId: str,
    jobId: uuid,
  }, ["id", "status", "optionId"]),
  Artifact: obj({
    type: nullable(str),
    id: nullable(str),
    title: str,
  }),
  Approval: obj({
    id: uuid,
    revision: int,
    kind: { type: "string", description: "EVIDENCE_USE, DOCUMENT_FINALIZE, APPLICATION_SUBMIT, CLI_EXECUTE; chat cards appear as TOOL_ACTION, DOCUMENT_EDIT, RESUME_GATE" },
    applicationId: nullable(uuid),
    targetId: uuid,
    targetRevision: nullable(int),
    payloadHash: str,
    status: { type: "string", description: "PENDING, APPROVED, DENIED, EXPIRED, CONSUMED (chat cards may be REJECTED)" },
    expiresAt: nullable(dateTime),
    decidedAt: nullable(dateTime),
    consumedAt: nullable(dateTime),
    createdAt: dateTime,
    updatedAt: dateTime,
  }),
  ConversationsApprovalTarget: {
    description: "Empty object when the target is gone or the kind has no summary",
    anyOf: [
      obj({ type: enumOf("EVIDENCE"), id: uuid, title: str, kind: str }),
      obj({ type: enumOf("DOCUMENT_VERSION"), id: uuid, documentId: uuid, number: int }),
      obj({ type: enumOf("SUBMISSION_DRAFT"), id: uuid, mode: str, documentVersionIds: arr(uuid) }),
      obj({
        type: enumOf("CLI_RUN"),
        id: uuid,
        provider: str,
        workingDirectory: str,
        executable: str,
        arguments: arr(str),
        prompt: str,
      }),
      { type: "object", additionalProperties: false },
    ],
  },
  Operation: obj({
    id: uuid,
    type: { type: "string", description: "EVIDENCE_IMPORT, JOB_ANALYSIS, DOCUMENT_GENERATE, DOCUMENT_REVISE, PROJECT_BLUEPRINTS, PROJECT_VERIFY, INTERVIEW_PREPARE, RESUME_WORKFLOW, AI_GENERATE, CHAT_MESSAGE, GOOGLE_SYNC, APPLICATION_SUBMIT" },
    applicationId: nullable(uuid),
    status: enumOf("QUEUED", "RUNNING", "NEEDS_INPUT", "SUCCEEDED", "FAILED", "CANCELLED"),
    progress: nullable(int),
    result: nullable(obj({ kind: str, value: any })),
    error: nullable(ref("ConversationsOperationError")),
    inputRequest: nullable(obj({
      code: str,
      message: str,
      fields: arr(obj({ name: str, label: str, type: str })),
    })),
    createdAt: dateTime,
    updatedAt: dateTime,
  }),
  ConversationsOperationError: obj({ code: str, message: str, retryable: bool }),
  ConversationsOperationEventProgress: opEvent(obj({ status: str, progress: nullable(int), step: str })),
  ConversationsOperationEventResult: opEvent({ ...any, description: "Operation result.value" }),
  ConversationsOperationEventError: opEvent(nullable(ref("ConversationsOperationError"))),
};

