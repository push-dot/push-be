import type { Route, Schema } from "./shared.ts";
import {
  get, post, patch, del, ref, nullable, obj, closed, arr, str, int, num, bool, uuid, dateTime, any, enumOf,
  body, ok, okPage, noContent, sse, pathParam, query, pageParams,
} from "./shared.ts";

const id = pathParam("id");

const seq = { type: "integer", description: "chat_events id; send back as ?after= or Last-Event-ID to resume" };

const option = obj({
  id: str,
  label: str,
  desc: { type: "string", description: "Second line under the label" },
  sub: { type: "string", description: "Source line on a material row, e.g. 마이 › 서류. Row ids are not answers." },
  badge: { type: "string", description: "Short tag such as 추천, or the company initial on a material row" },
  action: { ...enumOf("change"), description: "Material rows only. Opens the material picker. This id is not an answer." },
}, ["id", "label"]);

const choiceSubmit = obj({
  label: { type: "string", description: "Confirm button. {n} is the number of selected ids in toggle sections." },
  zeroLabel: { type: "string", description: "Button label when {n} would be 0" },
  optionLabels: {
    type: "object",
    additionalProperties: { type: "string" },
    description: "Thumbnails: button label for the selected option id. CLASSIC → 클래식으로 만들기.",
  },
}, ["label"]);

const choiceSection = {
  description: "A new client renders sections instead of options. options stays as the fallback for an older client.",
  oneOf: [
    obj({
      id: str,
      kind: enumOf("chips"),
      title: str,
      multiple: { type: "boolean", description: "Present and true when every chip in the section may be selected" },
      options: arr(option),
      selected: { ...arr(str), description: "Default ids. Applied only when the answer contains submit and the section has no pick." },
    }, ["id", "kind", "options", "selected"]),
    obj({
      id: str,
      kind: enumOf("rows"),
      title: str,
      options: arr(option),
    }, ["id", "kind", "options"]),
    obj({
      id: str,
      kind: enumOf("toggle"),
      title: str,
      options: arr(option),
      selected: { ...arr(str), description: "Default on. With submit, an id is on only when it is in optionIds. Without submit, a toggle section that was not touched keeps selected." },
    }, ["id", "kind", "options", "selected"]),
    obj({
      id: str,
      kind: enumOf("thumbnails"),
      title: str,
      options: arr(option),
      selected: arr(str),
    }, ["id", "kind", "options", "selected"]),
  ],
};

const hunk = obj({ line: nullable(int), sign: enumOf("+", "-", ""), text: str });

const resolution = obj({
  status: enumOf("PENDING", "APPROVED", "REJECTED", "EXPIRED"),
  optionId: nullable(str),
  optionIds: { ...arr(str), description: "Present when more than one option was picked" },
}, ["status", "optionId"]);

const resolutionField = {
  ...resolution,
  description: "GET .../turns only: how the card was answered. A typed answer to a text gate is APPROVED with optionId null.",
};

const sseError = obj({
  code: {
    ...enumOf("NOT_CONFIGURED", "PROVIDER_ERROR", "INTERNAL"),
    description: "NOT_CONFIGURED: OPENROUTER_API_KEY is missing (message is \"managed AI is not configured\"); the job fails once and is not retried. PROVIDER_ERROR: the model call failed or the answer was unreadable; the job fails once and is not retried. INTERNAL: the tool loop hit its step limit (stored, not retried) or the gateway poll failed (that frame has no seq).",
  },
  message: str,
  details: nullable({ type: "object", additionalProperties: true }),
}, ["code", "message"]);

const resultAction = obj({
  id: enumOf("apply", "convert", "view"),
  label: str,
  method: str,
  path: str,
}, ["id", "label"]);

const chatEvents: Record<string, Schema> = {
  status: obj({ type: enumOf("status"), text: str, seq }),
  token: obj({ type: enumOf("token"), text: str, seq }),
  think: obj({
    type: enumOf("think"),
    seconds: { ...int, minimum: 1, description: "How long the model step took. Nearest second, then at least 1. No text and no chain-of-thought." },
    phase: { type: "string", description: "Resume phase id (analyze, strategy, craft, review, blueprints). The app does not render it." },
    seq,
  }, ["type", "seconds", "phase", "seq"]),
  plan: obj({
    type: enumOf("plan"),
    id: { type: "string", description: "strategy (수정 전략) or feedback (고칠 점). A later plan with the same id replaces the card." },
    title: str,
    meta: { type: "string", description: "섹션 4개 or 3개" },
    rows: arr(obj({
      tag: { type: "string", description: "전략: 강화, 수정, 추가, 축소. 피드백: 키워드, 도메인, 성과, 기술, 경력." },
      label: str,
      note: str,
    }, ["tag", "label", "note"])),
    keywords: { ...arr(str), description: "Strategy card only. Up to 6, without a leading +" },
    seq,
  }, ["type", "id", "title", "meta", "rows", "seq"]),
  paper: obj({
    type: enumOf("paper"),
    id: { type: "string", description: "draft-{target}-v{version}, e.g. draft-resume-v1. A new version is a new card. The same id replaces the card." },
    label: { type: "string", description: "이력서 초안 v1, 포트폴리오 초안 v1, or 자기소개서 초안 v1" },
    heading: str,
    lines: { ...arr(str), description: "Up to 6 preview lines, markdown stripped, each at most 120 characters" },
    seq,
  }, ["type", "id", "label", "heading", "lines", "seq"]),
  tool: obj({
    type: enumOf("tool"),
    name: str,
    state: { ...enumOf("run", "ok", "err", "wait"), description: "Current turns emit wait, ok, or err. Replay can still send run." },
    summary: str,
    tier: str,
    result: any,
    target: { type: "string", description: "What the tool worked on, e.g. a file name or 회사 · 직무" },
    resultLine: { type: "string", description: "One-line outcome shown under the tool line" },
    extra: { ...arr(str), description: "Detail lines the client folds as +N줄" },
    warning: { type: "string", description: "Set when a READ tool failed with TOOL_FAILED and was retried once (state is ok or err after the retry)" },
    seq,
  }, ["type", "name", "state", "summary", "seq"]),
  todo: obj({
    type: enumOf("todo"),
    id: { type: "string", description: "List id. A later todo with the same id replaces the earlier list. The resume analysis uses analyze." },
    items: arr(obj({
      id: any,
      text: str,
      state: enumOf("todo", "now", "done"),
      added: { type: "boolean", description: "True for a step added after the list was first shown" },
    }, ["id", "text", "state"])),
    seq,
  }, ["type", "items", "seq"]),
  diff: obj({
    type: enumOf("diff"),
    documentId: str,
    revisionId: str,
    hunks: arr(hunk),
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
    hunks: { ...arr(hunk), description: "DOCUMENT_EDIT: the proposed change, sent before it is applied" },
    foot: { type: "string", description: "Warning under the options, e.g. 지원하면 취소할 수 없어요 for apply_to_posting" },
    options: arr(option),
    resolution: resolutionField,
    seq,
  }, ["type", "id", "kind", "title", "options", "seq"]),
  choice: obj({
    type: enumOf("choice"),
    id: str,
    kind: enumOf("RESUME_GATE", "EMPLOYER_GATE"),
    title: str,
    gate: str,
    recommended: str,
    auto: { type: "boolean", description: "Present and true when the server answered the gate itself and waits for no answer. The pick is recommended, or for a submit gate the selected ids of its sections." },
    multiple: { type: "boolean", description: "Present and true when more than one option may be selected" },
    detail: { type: "string", description: "Line under the title: the boost gate's score change, the review gate's template hint, or the start_document draft in progress" },
    note: { type: "string", description: "Profile present gate: where the PDF can be exported" },
    documentId: { type: "string", description: "Present gate: the saved profile document, when there is one" },
    options: { ...arr(option), description: "Old-client fallback. A client that does not read sections answers from this list." },
    sections: { ...arr(choiceSection), description: "Present → render these instead of options. Row sections are display only." },
    submit: { ...choiceSubmit, description: "Present → the answer is the button, not a tapped option. Send optionId submit and optionIds [submit, …picked ids]." },
    resolution: resolutionField,
    seq,
  }, ["type", "id", "options", "seq"]),
  fit: obj({
    type: enumOf("fit"),
    score: num,
    parts: {
      ...obj({ techStack: num, experienceLink: num, careerLevel: num, keyword: num, domain: num }, []),
      description: "Analysis card only. Sent for every plan; plan tells the client what to lock (FREE locks the bars).",
    },
    topGap: str,
    plan: enumOf("FREE", "PRO", "ULTRA"),
    band: { type: "string", description: "e.g. 보통 · 개선 여지 있어요 (8.0+ 높음, 6.0+ 보통, else 낮음)" },
    summary: { type: "string", description: "Strongest part and up to two weak parts, e.g. 경력 수준은 잘 맞아요. 키워드와 도메인이 약해요." },
    keywords: { ...arr(obj({ label: str, ok: bool })), description: "Up to 5 posting terms; ok when the resume text contains the term" },
    projected: {
      ...obj({ score: num, label: str, bullets: arr(str) }),
      description: "ULTRA only: the score if every part below 8 reached 8 (label like 8점대) and up to 3 fixes",
    },
    from: { type: "number", description: "Boost card: the score before the first boost cycle" },
    delta: { type: "string", description: "Boost card: signed change from from, e.g. +1.4" },
    note: { type: "string", description: "Boost card: 적합도 6.9 → 8.3 (+1.4)" },
    seq,
  }, ["type", "score", "seq"]),
  file: obj({
    type: enumOf("file"),
    name: { type: "string", description: "Never a .md name. A new turn does not emit a file event; replay drops a stored markdown file event." },
    mime: { type: "string", description: "Never text/markdown." },
    fileId: str,
    documentId: { type: "string", description: "Empty string when the document was not synced" },
    downloadUrl: { type: "string", description: "Relative to /api/v1, e.g. /conversations/{id}/artifacts/{name}" },
    seq,
  }),
  employer_research: obj({
    type: enumOf("employer_research"),
    company: str,
    summary: str,
    sourceCounts: obj({ homepage: int, news: int, postings: int }),
    facts: arr(obj({ text: str, sourceUrl: str })),
    seq,
  }, ["type", "company", "facts", "seq"]),
  posting_draft: obj({
    type: enumOf("posting_draft"),
    version: int,
    draft: obj({
      title: str,
      jobCategory: str,
      careerMin: int,
      careerMax: nullable(int),
      location: str,
      employmentType: str,
      workStyle: str,
      salaryRange: nullable(str),
      description: arr(str),
      requirements: arr(str),
      preferred: arr(str),
      skills: arr(str),
    }, ["title", "description", "requirements", "preferred"]),
    notes: arr(str),
    seq,
  }, ["type", "version", "draft", "seq"]),
  review_report: obj({
    type: enumOf("review_report"),
    applicationId: nullable(uuid),
    attachmentName: nullable(str),
    summary: str,
    matches: arr(obj({ requirement: str, status: enumOf("MET", "PARTIAL", "MISSING"), evidence: nullable(str) })),
    flags: arr(obj({ title: str, level: enumOf("CHECK", "SUPPORTED", "UNKNOWN"), reason: str, quote: nullable(str) })),
    disclaimer: str,
    seq,
  }, ["type", "summary", "flags", "disclaimer", "seq"]),
  interview_kit: obj({
    type: enumOf("interview_kit"),
    applicationId: nullable(uuid),
    questions: arr(obj({
      text: str,
      verify: str,
      goodSignals: arr(str),
      cautionSignals: arr(str),
      fromFlag: nullable(str),
    }, ["text", "verify"])),
    seq,
  }, ["type", "questions", "seq"]),
  result: {
    oneOf: [
      obj({
        type: enumOf("result"),
        source: enumOf("external"),
        taskLine: str,
        checklist: arr(str),
        documentId: str,
        fileName: {
          type: "string",
          description: "Edited PDF. Each part drops /\\:*?\"<>|, characters below U+0020, and whitespace, then drops a leading or trailing . or _. With a company: {display}_{company}_{role}.pdf. Empty parts are dropped. The joined name before .pdf is capped at 80 characters; an empty name becomes 이력서. With no company: {original stem}_수정본.pdf, and the stem is shortened so that name stays within 80 characters. An empty stem becomes 이력서.",
        },
        pageLine: str,
        savedLine: str,
        cardMeta: str,
        company: str,
        actions: arr(resultAction),
        summary: { type: "string", description: "다 됐어요! 적합도를 6.9 → 8.1로 올렸어요. when the fit rose, else 다 됐어요! 이력서를 고쳤어요. (external) or 다 됐어요! 프로필을 고쳤어요. (profile)" },
        fitFrom: { type: "number", description: "Fit before any edit; present only when the fit rose" },
        fitTo: { type: "number", description: "Fit after the last boost cycle; present only when the fit rose" },
        bullets: { ...arr(str), description: "Up to 3 changes: the draft's changes, else the analysis improvements" },
        seq,
      }, ["type", "source", "taskLine", "checklist", "documentId", "fileName", "pageLine", "cardMeta", "actions", "seq"]),
      obj({
        type: enumOf("result"),
        source: enumOf("profile"),
        taskLine: str,
        checklist: arr(str),
        documentId: str,
        name: str,
        headline: str,
        title: str,
        subtitle: str,
        company: str,
        actions: arr(resultAction),
        summary: { type: "string", description: "다 됐어요! 적합도를 6.9 → 8.1로 올렸어요. when the fit rose, else 다 됐어요! 이력서를 고쳤어요. (external) or 다 됐어요! 프로필을 고쳤어요. (profile)" },
        fitFrom: { type: "number", description: "Fit before any edit; present only when the fit rose" },
        fitTo: { type: "number", description: "Fit after the last boost cycle; present only when the fit rose" },
        bullets: { ...arr(str), description: "Up to 3 changes: the draft's changes, else the analysis improvements" },
        seq,
      }, ["type", "source", "taskLine", "checklist", "documentId", "name", "headline", "title", "subtitle", "actions", "seq"]),
    ],
  },
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
  + "The stream starts with `retry: 400`. An idle poll sends the SSE comment `: ping`; clients ignore it. "
  + "The stream closes after done, error, or cancelled. After SSE_MAX_POLLS polls (default 20) with no terminal event it closes with no error frame; reconnect via GET .../messages/stream/active with ?after=<last seq>. "
  + "done with `awaiting` means the turn paused for an approval or choice card (operation is null). A stream-level failure emits an error frame without seq. "
  + "The queued job writes one status frame, text 대기 중. employer_research, posting_draft, review_report, and interview_kit are built in the employer flow and then dropped by the chat runner, so a live turn does not send them. Replay still forwards a stored row of any of those types. "
  + "The resume flow sends fit twice: after the analysis when a posting is known and managed AI is on, and after each boost cycle (with from, delta, note). "
  + "During the analysis it sends todo id analyze with now/done states and READ tool lines with target, resultLine and extra. "
  + "Every field added after the first release is optional; a client that ignores it keeps working. "
  + "A new turn does not emit a file event. Replay drops a stored file event whose name ends in .md or whose mime is text/markdown. Other stored file events are still replayed. GET .../artifacts omits markdown. GET .../artifacts/{name} still downloads any artifact by name, including markdown. "
  + "think, plan, and paper are stored and replayed. think carries seconds and phase only, never model reasoning. plan id strategy is the 수정 전략 card; plan id feedback is the 고칠 점 card; the same id replaces the card. paper is a draft preview, not a markdown file card. "
  + "A choice may add sections and submit. options stays the fallback an older client renders and answers. For a card with sections, send optionId submit and optionIds [submit, …picked ids]; ids from any answerable section are valid. Row ids (m_file, m_posting, m_github) are not answers. An answer contains submit only when optionId is submit or submit is in optionIds. Without submit, chips and thumbnails use the sent ids and a missing section stays unset; a toggle uses the sent ids, and a toggle section with no id keeps its selected default. "
  + "Gate quality sits after review and before the template gate. It lists automatic fixes as a diff and recommendation toggles. Gate read_failed asks how to continue when the posting could not be read; paste and pick stay on that gate until the next message, and proceed continues to the analyze gate. Neither gate has a cancel option.";

const postMessageBody = body(closed({
  text: { type: "string", minLength: 1, maxLength: 20000 },
  context: closed({
    documentId: nullable(uuid),
    versionId: nullable(uuid),
    evidenceIds: {
      ...arr(uuid),
      description: "Ids of the caller's uploaded sources. A PDF, DOCX, or DOC attached with a fix, tailor, or improve request (고쳐, 고치, 맞춰, 맞추, 개선, tailor, improve) and no intent runs the resume flow on that file. The result event then has source external.",
    },
  }, []),
  ai: nullable(closed({
    provider: {
      ...enumOf("OPENAI", "OPENROUTER", "CLAUDE", "GEMINI", "GROK"),
      description: "Model family. Every model call goes through OpenRouter (OPENROUTER_API_KEY only). There is no OpenAI key.",
    },
    model: { type: "string", minLength: 1 },
    effort: { ...enumOf("LOW", "MEDIUM", "HIGH", "MAX"), description: "Ignored. The plan sets it: personal FREE LOW, PRO MEDIUM, ULTRA HIGH; employer BASIC MEDIUM, PRO HIGH, ULTRA MAX." },
    ultraResume: { type: "boolean", description: "Requires the ULTRA plan" },
    webSearch: bool,
    models: { type: "object", additionalProperties: true },
  }, ["provider", "model"])),
  accessMode: { ...enumOf("ALWAYS_ASK", "AUTO", "BYPASS", "SUGGEST", "CONFIRM_ACTIONS"), description: "SUGGEST maps to AUTO, CONFIRM_ACTIONS to ALWAYS_ASK; defaults to the saved user setting" },
  intent: enumOf(
    "posting", "review", "interview", "general",
    "match_posting", "fit", "gaps", "experience", "boost",
    "find_postings", "deadline_postings", "applications", "calendar",
    "hub_profile", "offer_reply", "coffee_chat", "career_post",
  ),
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

const expectedRevision = closed({ expectedRevision: int });

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
  get("gateway", "/api/v1/conversations/{id}", {
    tag: "conversations",
    summary: "Get a conversation",
    description: "Same item as one entry of the list, including archived conversations. 404 when the conversation is missing or not the caller's personal one. 400 when id is not a UUID.",
    params: [id],
    responses: { 200: ok(ref("ConversationsListItem")) },
  }),
  post("core", "/api/v1/conversations", {
    tag: "conversations",
    summary: "Create a conversation",
    description: "audience=EMPLOYER creates a company conversation. postingId and applicationId are allowed; a missing posting or an application outside the company is 404. Unknown keys are rejected. A personal create checks reference-data consent first and is 403 CONSENT_REQUIRED until it is on, before any other check. An employer create skips that check. No company, or a company with no verified_at, is 403 BUSINESS_NOT_VERIFIED.",
    body: body(closed({
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
    description: "409 REVISION_CONFLICT with details.currentRevision when expectedRevision does not match. 404 when the conversation is not visible to the caller.",
    params: [id],
    body: body(closed({
      expectedRevision: int,
      title: nullable({ type: "string", maxLength: 300 }),
      pinned: nullable(bool),
    }, ["expectedRevision"])),
    responses: { 200: ok(ref("Conversation")) },
  }),
  post("core", "/api/v1/conversations/{id}/archive", {
    tag: "conversations",
    summary: "Archive a conversation",
    description: "Also deletes company conversation PDF attachments and archives career evidence referenced only by this conversation. 409 REVISION_CONFLICT with details.currentRevision when expectedRevision does not match.",
    params: [id],
    body: body(expectedRevision),
    responses: { 200: ok(ref("Conversation")) },
  }),
  post("core", "/api/v1/conversations/{id}/unarchive", {
    tag: "conversations",
    summary: "Unarchive a conversation",
    description: "Same caller and expectedRevision rules as archive, including 409 REVISION_CONFLICT. Does not restore evidence or attachments removed by archive.",
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
  get("ai", "/api/v1/conversations/{id}/turns", {
    tag: "conversations",
    summary: "List chat turns with their cards",
    description: "Newest first; one item per chat job, so a reopened conversation can draw its cards again. In a personal conversation only the caller's jobs are listed. "
      + "events are the stored stream frames (same shapes as the stream, with seq) minus status and done; consecutive token frames are joined into one, and markdown file events are dropped. "
      + "approval and choice events carry resolution. userMessageId and assistantMessageId are the messages this job wrote, or null when it wrote none (a resumed job has no USER message; a turn that paused before replying has no ASSISTANT message). "
      + "answer is set on a job started by answering a card. 404 when the conversation is not visible.",
    params: [id, ...pageParams],
    responses: { 200: okPage(ref("ConversationTurn")) },
  }),
  get("gateway", "/api/v1/conversations/{id}/messages", {
    tag: "conversations",
    summary: "List messages",
    description: "Newest first. In a personal conversation only the caller's messages are returned; company conversations show every member's. Attachments whose title or name ends in .md, or whose mime is text/markdown, are omitted.",
    params: [id, ...pageParams],
    responses: { 200: okPage(ref("Message")) },
  }),
  post("core", "/api/v1/conversations/{id}/messages", {
    tag: "conversations",
    summary: "Send a message (queue a chat job)",
    description: "Stores the USER message, rejects pending approval cards, and queues an AI job. Follow the reply via GET .../messages/stream/active. A missing conversation is 404. context.documentId must be one of the caller's documents (404 NOT_FOUND otherwise) and not archived (409 INVALID_TRANSITION). On a personal conversation, missing reference-data consent is 403 CONSENT_REQUIRED before credits, plan, or FEATURE_DISABLED, including when monthly credits are already used up. Employer conversations skip that consent check. 403 FEATURE_DISABLED when the monthly AI credit is used up or ultraResume is set without ULTRA. 503 NOT_CONFIGURED when managed AI is off. A company conversation with no verified_at is 403 BUSINESS_NOT_VERIFIED. Intent interview below PRO is 403 PLAN_REQUIRED with details.requiredPlan. When QUEUE_BACKEND is redis, a short balance is 402 INSUFFICIENT_CREDITS and a full queue is 429 QUEUE_BUSY with details.retryAfterSec and details.ahead (the caller's own queued jobs: the company's for employer chat, else the user's). Also 429 QUEUE_BUSY with details.reason BILLING_LOCKED and retryAfterSec 5 when a Stripe webhook holds the owner's billing row for more than 3 s; nothing was written, retry the same request.",
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
    description: "Company members only. A personal conversation, or one the caller cannot see, is 404. An unverified company is 403 BUSINESS_NOT_VERIFIED. pdf_attachment requires ULTRA, else 403 PLAN_REQUIRED with details.requiredPlan. PDF only, else 400. Over 10 MiB is 413 PAYLOAD_TOO_LARGE.",
    params: [id],
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: obj({ file: { type: "string", format: "binary", contentMediaType: "application/pdf" } }),
        },
      },
    },
    responses: { 201: ok(obj({ id: uuid, fileName: str, mimeType: enumOf("application/pdf"), size: { type: "integer", description: "Stored PDF size in bytes" } }, ["id", "fileName", "mimeType"]), "Created") },
  }),
  post("core", "/api/v1/conversations/{id}/approvals/{approvalId}", {
    tag: "conversations",
    summary: "Answer a chat approval or choice card",
    description: "Send optionId, or optionIds when more than one choice is selected. Every id must be one of the card's stored options. For a card with sections, send optionId submit and optionIds [submit, …picked ids]; ids from any answerable section are valid. Zero picks is [submit], not []. 400 VALIDATION_ERROR (field optionId or optionIds), 404, 409 APPROVAL_ALREADY_RESOLVED, 410 APPROVAL_EXPIRED. Returns 202 {id, status APPROVED, optionId, optionIds?, jobId} when the answer resumes the chat job (TOOL_ACTION, RESUME_GATE, or job-bound cards), else 200 without jobId.",
    params: [id, pathParam("approvalId")],
    body: body(closed({
      optionId: { type: "string", minLength: 1 },
      optionIds: arr({ type: "string", minLength: 1 }),
    }, [])),
    responses: {
      200: ok(ref("ConversationsApprovalAnswer")),
      202: ok(ref("ConversationsApprovalAnswer"), "Accepted; chat job resumed"),
    },
  }),
  get("core", "/api/v1/conversations/{id}/artifacts/{artifactId}", {
    tag: "conversations",
    summary: "Download a conversation artifact",
    description: "artifactId is the artifact file name (e.g. final.md, final.pdf), URL-encoded. Served as an attachment; type by extension. This route still downloads markdown. List and file events do not show it.",
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
    description: "Omits markdown: a .md title, name, or file name, or mime text/markdown. Other artifacts stay.",
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
    body: body(closed({
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
    body: body(closed({ expectedRevision: int, decision: enumOf("APPROVED", "DENIED") })),
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
    body: body(closed({
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

const { status: _status, done: _done, ...turnEvents } = chatEvents;

export const schemas: Record<string, Schema> = {
  ConversationTurn: obj({
    jobId: uuid,
    status: enumOf("PENDING", "RUNNING", "DONE", "FAILED", "CANCELLED"),
    createdAt: dateTime,
    userMessageId: nullable(uuid),
    assistantMessageId: nullable(uuid),
    answer: nullable(obj({ approvalId: uuid, optionId: nullable(str), optionIds: arr(str) }, ["approvalId", "optionId"])),
    events: arr({ oneOf: Object.values(turnEvents) }),
  }),
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
    queuePosition: {
      ...nullable(int),
      description: "Pending chat jobs of the same owner (the company for employer conversations, else the user) queued before this conversation's pending job. 0 means none of the owner's jobs is ahead. Null when it has none.",
    },
    lastLine: {
      ...nullable(str),
      description: "NEEDS_APPROVAL: the waiting card's title. RUNNING: the newest status text or tool line (summary · target) of the queued or running job. Null otherwise.",
    },
    lastMessagePreview: { type: "string", maxLength: 140 },
    createdBy: obj({ displayName: str }),
    postingId: nullable(uuid),
  }, ["id", "revision", "applicationId", "title", "pinned", "createdAt", "updatedAt", "status", "lastLine", "lastMessagePreview", "createdBy", "postingId"]),
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
    fileName: { type: "string", description: "Uploaded PDF name, present when id is an attachment of this conversation" },
    size: { type: "integer", description: "Uploaded PDF size in bytes, present with fileName" },
  }, ["type", "id"]),
  ConversationsApprovalAnswer: obj({
    id: uuid,
    status: enumOf("APPROVED", "REJECTED"),
    optionId: str,
    optionIds: arr(str),
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
    kind: { type: "string", description: "EVIDENCE_USE, DOCUMENT_FINALIZE, APPLICATION_SUBMIT, CLI_EXECUTE; chat cards appear as TOOL_ACTION, DOCUMENT_EDIT, RESUME_GATE, EMPLOYER_GATE" },
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

