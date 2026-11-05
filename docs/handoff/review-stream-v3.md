# Review: stream-v3-spec.md

Reviewed against push-be `origin/develop` @ `1799b66` and push-fe `origin/feat/agent-design` @ `9a93928` (the branch whose chat mapper will take this). Spec file was not edited.

`feat/agent-stream-v3` is `1799b66`, the same commit as `develop`. "No commits yet" is true.

The answer shape can work with no core-api change. Several rules in §0, §4.2, §4.5, and §6 do not match the code and will ship the wrong behavior if implemented as written. Replace those paragraphs with the text below.

## Blockers

### 1. `think` / `plan` / `paper` are dropped before they are stored

`emit()` only calls the LangGraph stream writer. `ConversationService._run_job` keeps a custom chunk only when:

- the chunk has a `token` key → stored as type `token` (this is why `emit({"token": reply})` works and is not in the allow-list)
- the chunk has a `status` key → stored as type `status`
- otherwise `_live_event` keeps it

`_LIVE_EVENT_TYPES` in `services/ai/src/app/domain/services/conversation.py` is `tool, todo, diff, approval, choice, fit, cancelled, file, result, done`. A `{type:'think'}` chunk matches none of those branches and is discarded. Same for `plan` and `paper`. `GET /conversations/{id}/turns` cannot replay an event that was never inserted. The gateway has no second allow-list; it forwards rows already in `chat_events`.

Add to §0, and delete "with no extra code":

> Add `"think"`, `"plan"`, and `"paper"` to `_LIVE_EVENT_TYPES`. Do not put a `token` or `status` key on those dicts: `_run_job` checks those keys before `type`. Do not set `seq` in the harness. `jobs.emit` stores the payload; the gateway sets `seq` from `chat_events.id`.

`choice.sections` and `choice.submit` do not need an allow-list change. `choice` is already stored, and the payload keeps every field except `type`.

### 2. Old `feat/agent-design` builds do not ignore unknown types

§0 says `fe:utils/stream.ts` `map()` returns null on an unknown type. On `origin/feat/agent-design` the function is `mapEvent`, it returns `ChatEvent[]`, the switch has no `default`, and `fromStream` does `yield* mapEvent(ev)`. An unknown `type` makes the switch return `undefined`, and `yield*` throws. The stream stops.

`origin/develop` is the one that survives: `map` returns one event or `undefined`, and `fromStream` does `if (e) yield e`. Develop is not the branch that renders `plan` / `paper` / `think` as the design cards alongside the #223 fields. Those renderers are on `feat/agent-design`.

Ship this in the app PR before the server emits the new types:

```ts
default:
  return []
```

`case 'think'` / `'plan'` / `'paper'` must return a one-element array, not a bare object. Extra fields on a known `choice` are safe: the current `case 'choice'` reads `options` only.

### 3. Section defaults contradict the old-client tests

§4.2 says a chips section with no pick uses `selected`, and a toggle with no `submit` uses `selected`. §4.3 and `test_output_targets_old_answer_still_asks_tone` say an old 10-02 answer leaves `tone` unset and goes to `g_tone`. §5 says an old quality answer's rec ids are what gets applied. Those cannot all be true.

What the current app sends (`stores.ts` `answer`, same on develop and `feat/agent-design`):

- one pick → `{ optionId: ids[0] }` only
- two or more → `{ optionId: ids[0], optionIds: ids }`
- `optionIds` is omitted when there is a single id
- a typed message while a card is open sends text and no approval body (`send`)

Replace the §4.2 bucketing rules with:

> An answer contains `submit` when `option_id == "submit"` or `"submit"` is in `option_ids`. The graph sees snake_case: `runtime.py` `_gate_answer` copies `optionId` → `option_id` and `optionIds` → `option_ids`.
>
> Rebuild sections with the same builder. Ignore ids that are not in that rebuilt card.
>
> If the answer contains `submit`: bucket ids into sections. `chips` with `multiple`: every id in that section, or `selected` when none. `chips` without `multiple`, and `thumbnails`: the first id in section order, or `selected` when none. `toggle`: an option is on only when its id is in `option_ids`. Missing toggle ids stay off (`profile_photo` false, quality apply list empty). `rows`: ignore.
>
> If the answer does not contain `submit`: do not apply `selected`. Keep only ids that belong to a section. `chips` / `thumbnails` use those ids (first in section order when the section is single). A section with no id stays unset (10-02 tone stays unset, `goto` stays `g_tone`). `toggle`: the ids that belong to that section are the picks (a quality answer of `{option_id:'rec2'}` applies rec2, not the P1 default). A toggle section with no id keeps `selected` (10-22 `{option_id:'MODERN'}` leaves `profile_photo` true).

Replace the §5 old-client sentence with: "An old client sends `{optionId: recId}` for one rec and `{optionId: first, optionIds: recIds}` for two or more. It never sends `submit`. Apply those rec ids. Do not fall back to the P1 `selected` list."

### 4. 10-28 paste does not work by ending the turn

The code already has a path. It is not the one §6 describes.

`runtime.py` `_chat_turn`:

- Pending interrupt whose `kind` is `RESUME_GATE` or `EMPLOYER_GATE` (`_TEXT_GATES`), plus a new job that has `text` and no `approvalId`: `Command(resume={text, **_turn_inputs(payload)})`.
- `_turn_inputs` puts at most two URL fetches into `pages`, keyed by the URL. It copies `context.documentId` and `context.evidenceIds` → `attachments`. It does not set `postingId`. It does not copy free text into `pages`.
- `gate_node` then treats text with no option id as a typed answer. `_apply_answer` sets `inputs.gate_text` and merges those pages. It returns `status: active`, the same phase, `goto: end`, and `gate_epoch + 1`.
- The parent edge `_after_resume` loops into `resume_flow` while `status` is `active`, in the same turn. `route_phase(phase)` runs that phase again immediately.

So "end the turn with phase analyze and status active" does not wait. The parent re-enters analyze before the user types. A later message, once the checkpoint resume is already `active`, is not merged: the seed block in `_chat_turn` runs only when the checkpoint status is not `active`.

`_choice` also refuses to emit a second card with the same id. The seed is `push:resume-gate:{conversation}:{job}:{phase}` plus `:e{gate_epoch}` when epoch is non-zero. `_save_choice` returns false when that id exists, and the gate then does not emit. `insert_chat_approval` is `ON CONFLICT DO NOTHING`.

Replace the §6 answer list with:

> `paste` and `pick` stay on the gate. Emit the instruction token, increment `gate_epoch`, build a new `read_failed` choice (the new epoch changes the approval id), emit it, and `interrupt` again. Do not set `goto: end` on the button. `_choice` appends `cancel` for every phase except `analyze`; this gate has no cancel, so do not call `_choice` unchanged.
>
> The next user message is the existing text resume, not a new entry path. In the `read_failed` text branch, copy `answer["text"]` into `inputs.pages["붙여넣은 공고"]` yourself. `_turn_inputs` will not. Then set `phase` to `analyze` and `goto` to `end` so the parent re-runs analyze in that same turn.
>
> `pick` cannot use `inputs.postingId` from the runtime. The message context type is `{documentId?, evidenceIds?}`. No harness code parses an @-mention into a posting id. Read a posting id out of the text in this branch, or add that field to `_turn_inputs`. There is no existing path to reuse.
>
> `proceed` continues to `g1` as written. A typed answer while the first card is still pending is the same text branch (the app sends text and no approval body). `_answer_gate` marks that pending card `APPROVED` with a null `option_id` before the resume. That matches the OpenAPI note on `resolution`.

## Resolved: PDF profile photo

`md_to_pdf` (`services/ai/src/app/infrastructure/resume_workspace.py`) draws text lines only, via ReportLab or the plain CID fallback. `stored_document_template` appends the template name (`CLASSIC` becomes `SIMPLE`). There is no image call and no photo argument.

The resume state does not load an avatar. `avatarUrl` exists on the profile contract, but nothing in this harness reads it.

Replace the two "Open" sentences in §4.4 with:

> Store `profile_photo` on the resume state and in `01_scenario.json`. Do not pass it to `md_to_pdf` or `save_artifact`. The renderer cannot place a photo; a renderer slot is a later change. Always send the photo toggle. A profile-photo lookup is a later change. Default the flag to true for an old-client answer and for auto mode, including when the user has no photo.

## Approval answer: what is already true

`POST /api/v1/conversations/{id}/approvals/{approvalId}` needs no code change for `{ optionId: "submit", optionIds: ["submit", ...picked] }`, if the `approvals.options` jsonb contains every one of those ids.

`selectedOptions` (`services/core-api/src/routes/conversations.ts`):

- `optionIds` present → each entry must be a non-empty string in `cardOptionIds(row.options)`, and the array must be non-empty. `[]` is 400 `VALIDATION_ERROR` field `optionIds`. Zero picks must be `["submit"]`, not `[]`.
- `optionId` present together with `optionIds` → `optionId` must be one of the `optionIds`. `submit` has to be inside `optionIds`, not only beside it. Otherwise 400 field `optionId`, message `unknown option`.
- `optionId` omitted and `optionIds` sent → stored `optionId` becomes `optionIds[0]`.
- `forbidExtra` allows only those two keys.

`cardOptionIds` reads `options[].id`. A missing id becomes `""`. Do not store id-less objects.

`resolveApproval` does not read `payload_hash`. The hash is `sha256` of the options JSON at insert time and nothing on this route compares it. Validation uses the options column only. `card_options` must be a new list passed to `insert_chat_approval`. Do not assign it back onto `event["options"]` before `emit`, or the old-client fallback list changes.

`insert_chat_approval` does not write `job_id`. 202 happens because `kind` is in `RESUMABLE` (`TOOL_ACTION`, `RESUME_GATE`, `EMPLOYER_GATE`) or `job_id` is set. These cards must keep `kind: "RESUME_GATE"`. A missing kind returns 200 and does not enqueue the resume. Status is `APPROVED` here. `REJECTED` is only `TOOL_ACTION` plus `optionId === "reject"`.

The app client already sends this shape. `resolveApproval(conversationId, approvalId, optionId, optionIds?)` posts `{optionId, optionIds}` when the array is non-empty. No new endpoint. Call `resolveApproval(id, approvalId, "submit", ["submit", ...ids])`. Add `optionIds?: string[]` to `ApprovalResolution` (it is missing on both develop and `feat/agent-design`). The runtime already returns it.

Row ids (`m_file`, `m_posting`, `m_github`) stay out of `approvals.options` and out of `optionIds`. A "변경" tap that appends one is a 400.

`_choice` appends `cancel` unless `phase == "analyze"`. Quality and `read_failed` have no cancel. Build those events without that append, and do not put `cancel` in the stored union.

## Idempotency

§4.5 is wrong for this app. `withApprovalAnswerKey` returns immediately when the request already has `Idempotency-Key`. `packages/api-client/src/client.ts` sets a random uuid on every POST that is not `/stream`, unless the caller passes `idempotencyKey`. `resolveApproval` does not pass one. The optionIds hash never runs for fo-mobile.

When the header is absent, the key is `uuid5("push:approval-answer:" + approvalId + ":" + optionIds.join(","))`. `optionId` is not part of the hash if `optionIds` is non-empty. Order is not sorted. That only dedupes an exact retry from a client that sent no header.

Double-submit safety on this route is the `UPDATE ... WHERE status = 'PENDING'` in `resolveApproval`. The loser gets 409 `APPROVAL_ALREADY_RESOLVED`. A retry with a new random uuid also gets 409, not a replay of the first 202. That is existing behavior. Do not cite the hash as what makes section answers safe. No core change.

## Smaller corrections

- `draft_version` is only read (`graph.py` `_bodies`, default 1). Nothing increments it. Boost will not produce `draft-resume-v2` unless the boost node sets it. Either increment it there or stop saying a new version is a new card.
- `_advance("quality")` must return before `_next_phase`. `_ORDER.index("quality")` throws. Add `"g4a"` to `_EXITS` and replace the edge `p4a_review → g4a` with `p4a_review → g_quality`. `p4b_design → g4a` stays, so scenario C skips quality. That part of the spec is right.
- `test_think_event_rounds_up_to_one_second` is the wrong name. `max(1, round(seconds))` is nearest, then clamp. Python `round` is bankers' rounding. `think_event("craft", 6.4)["seconds"] == 6` matches the code. Rename the test. Do not switch to `ceil`.
- 10-02 still has an open product choice the spec already names: the design has no confirm button, the server sends `submit.label = "다음"`, and the app may submit on the tone tap. Leave it marked as an owner choice. Do not pick a second label in code.
- Plan/paper replacement by id works. The reducer `upsert` replaces a `ChatItem` with the same `id`. Use a stable id. Todo on `feat/agent-design` prefixes `todo-`; plan does not have to, as long as every replacement uses the same string.
- Tool lines are not replaced by event id. The reducer rewrites tool ids. Do not depend on a tool event's id for the strategy or quality lines.

## Checked and left as written

- Additive `choice` fields, top-level `options` kept as the fallback list, `cancel` as a top-level option on 10-02 and 10-22.
- `{optionId:'submit', optionIds:['submit', ...]}` matches `selectedOptions` once `submit` and the picked ids are in the stored options.
- 202 body `{id, status:'APPROVED', optionId, optionIds?, jobId}` for a `RESUME_GATE` card.
- Errors 400 / 404 / 409 / 410 and the messages named in the spec.
- Replay of `resolution.optionIds` from the resume payload (`store_turns`). No change.
- No migration. `approvals.options` is already jsonb.
- `file` events still must not be `.md`. A `paper` event is the right substitute.
- Quality diff can use the existing `diff` event. `line` may be null in the contract (`hunk.line` is nullable). Empty `documentId` / `revisionId` are allowed by the schema (those fields are not required).
- Contract edits in §8 are the right files. Generate `openapi.json` and `src/schema.ts` in the same PR.

Not checked: pixel copy of each 10-xx artboard against the HTML export, and pytest was not run.
