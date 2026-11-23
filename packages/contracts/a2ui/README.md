# Push A2UI surfaces

Every Bot card in chat (approval, choice, plan, paper, todo, diff, fit, result) reaches a client as an
A2UI surface of the Push catalog, in A2UI v0.9.1 (Android) or 1.0 (iOS, web). The server builds it from
the stored card payload in `services/ai/src/app/domain/a2ui.py`. The LLM never writes it.

| Path | What |
|---|---|
| `push-catalog.json` | The v0.9.1 catalog |
| `push-catalog.v1.json` | The 1.0 catalog: the same components and props in the 1.0 catalog format |
| `spec/` | Vendored A2UI v0.9.1 schemas; `spec/v1.0/` the 1.0 ones (see `spec/README.md`) |
| `fixtures/*.json` | v0.9.1: one exact wire frame per case, written by `services/ai/tests/test_a2ui.py` |
| `fixtures/v1.0/*.json` | 1.0: the same cases, same file names |

## Version: the `A2UI-Version` request header

Send `A2UI-Version: 1.0` or `A2UI-Version: v0.9.1` on every route that returns frames:
`POST /conversations/:id/messages/stream`, `GET /conversations/:id/messages/stream/active`,
`POST /bots/:id/messages/stream`, `GET /bots/:id/stream`, `GET /bots/:id/transcript` and
`GET /conversations/:id/turns`. A missing or unknown value means `v0.9.1`. The gateway allows the header
in CORS. Only `messages` differs between the versions; the frame around them, the surface ids, the
component ids and props and the data model are the same.

A live card row stores both projections under `a2ui`, keyed by version
(`{"v0.9.1": {surfaceId, messages}, "1.0": {surfaceId, messages}}`); the gateway's `frameOf` picks the one
the header names without calling Python. Replay builds the asked version in Python.

**Catalog id rule.** One id for both documents: `https://push.app/a2ui/catalogs/push/v1/catalog.json`.
It names the Push catalog, not the protocol (the `v1` is the catalog's own version). The message
`version` names the protocol, and each renderer registers the one catalog document of its protocol
version under this id. Bump the id only when the catalog itself changes incompatibly.

**What differs in 1.0** (A2UI 1.0 evolution guide):

| | v0.9.1 | 1.0 |
|---|---|---|
| `version` | `"v0.9.1"` | `"1.0"` |
| Binding in a prop | `{"path": "/open"}` | `{"@path": "/open"}` |
| `updateDataModel.path`, ChildList template `path` | unprefixed | unprefixed (unchanged) |
| `checks`, `accessibility` on a component | bare | `@checks`, `@accessibility` (the converter emits neither today) |
| `Text.variant` | `h3`, `caption`, body (absent) | `caption` or absent. The converter's `h3` titles are sent without a variant (body): 1.0 headings are Markdown, and surfaces carry plain text only |
| Custom component schema in the catalog | lists `id`, `additionalProperties: false` | no `id`; the 1.0 message envelope (`ComponentCommon` + `unevaluatedProperties: false`) owns `id` and rejects extras |
| Catalog document | no `protocolVersion` | `"protocolVersion": "1.0"`, no theme |

Both keep the three-message snapshot: 1.0 still accepts `createSurface` followed by `updateComponents` and
`updateDataModel` (inline `components`/`dataModel` in `createSurface` are optional), so the upsert rule is
the same everywhere. Neither sends a theme; `updateDataModel.value` is always present.

## Wire frame

```json
{"type": "a2ui", "kind": "approval", "surfaceId": "…", "messages": [createSurface, updateComponents, updateDataModel], "seq": 1, "at": "…", "turn": "…"}
```

- The same shape in both versions, from the stream (`/bots/:id/stream`, `/conversations/:id/messages/stream`), from
  `GET /bots/:id/transcript` (with `seq`, `at`, no `turn`) and from `GET /conversations/:id/turns` (with `seq`).
- `kind`: `approval`, `choice`, `plan`, `paper`, `todo`, `diff`, `fit` or `result`. No other card frame exists.
- Every frame is a full snapshot. Every message has `"version"` set to the asked version. `createSurface` carries only
  `surfaceId` and `catalogId`: no theme. `updateDataModel` always has `path: "/"`.
- All text in a surface is plain text. Never parse Markdown.
- A gate the server answered itself (`auto`) sends no frame. The Bot says what it picked in a `token`
  ("자동으로 골랐어요: …").
- Lifecycle frames are unchanged: `token`, `status`, `think`, `tool`, `notice`, `done`, `error`, `cancelled`.

## Surface ids

| kind | surfaceId |
|---|---|
| approval, choice | the approval id (the `approvalId` of the answer route) |
| plan, paper, todo | `{kind}:{id}:{job id}`, e.g. `plan:strategy:<uuid>`. A later frame of the same turn updates it in place; the next turn gets a new surface. A todo without an id uses `todo:todo:{job id}` |
| fit, diff, result | a uuid minted when the row was stored. Rows stored before surfaces replay as `{kind}:{seq}` |

The transcript and the turns list return the same id the stream sent. The job id equals the frame's `turn`.

## Components

Basic catalog components keep their basic-catalog schemas of each version. `Text` is drawn as plain text
and `List` as a plain, non-lazy column or row. The converter uses `Column` (root of the approval and result
surfaces) and `Text` (v0.9.1 variants `h3`, body, `caption`; 1.0 body and `caption`).

Data-bound props take `{"path": "/…"}` (v0.9.1) or `{"@path": "/…"}` (1.0). Every other prop is a literal.

### PushChoice
The Bot asks and the person picks. Approval surface: `Text` title, optional `Text` lines, optional
`PushDiff`, then a PushChoice with id `choice`. Choice surface: the PushChoice is `root`.

- `form`: `list` (rows, default) or `buttons` (two buttons side by side: the way out left, the action right, primary; a tap answers).
- `questions[]`: asked in order. With more than one, show "1/N" above the title and a "다음" button until the last.
  - `id`: key of this question's picks in `/selected`.
  - `title`: the question (h3). Absent in the approval button form.
  - `detail`: optional line under the title.
  - `multiple`: true = checkboxes, any number of picks.
  - `answerable`: false = display rows; they cannot be picked and are never in an answer.
  - `choices[]`: `id`, `label`, optional `desc` (second line), `recommended` ("추천" mark), `change` (a material row: its 변경 link dispatches `change`; it is not an answer).
- `answer`: `pick` or `submit`, how the answer body is built (below).
- `submit`: present = picks only select and this primary button answers. `label`; `labels` maps a picked option id of a single-pick question to the button text while it is picked (e.g. `MODERN` → "모던으로 만들기"). Absent = a single-pick question answers on tap.
- `secondary`: `{id, label}`, a way-out button left of submit. Answers `{optionId: id}`.
- **`open`** (`/open`): true while it takes an answer.
- **`picked`** (`/picked`): the ids of the answer once answered, else `[]`.
- **`selected`** (`/selected`): current picks by question id, `{questionId: [ids]}`. The component writes it as the person picks; it starts with the server's defaults.

Answered (`open` false): every id in `picked` keeps its highlight, everything else drops to 45% opacity, nothing responds.

### PushTodo
Checklist for the current job. Never interactive.
- **`items`** (`/items`): `[{text, state}]`, state `done` (green mark, struck t2), `running` (blinking ac mark, 600), `waiting` (its number on fill2).

### PushDiff
What changed in a 서류. Reports only.
- `caption`: optional, where the change is. The converter does not send it yet.
- `title`: the counts, e.g. "2줄을 더하고 1줄을 뺐어요".
- `lines[]`: `{sign, text}`, sign `+`, `-` or `""` (context). At most 20 changed lines, each with up to 2 context lines.
- `documentId`: present = a "전체 보기" link dispatches `open_review`.

### PushPlan
Plan, feedback or outline. No buttons.
- `caption`: e.g. "섹션 2개".
- `title`: e.g. "수정 전략".
- `rows[]`: `tag` (word), `tone` (`accent` ac-soft, `green` green-soft, `orange` orange-soft; the server picks it), `label` (600), `note` (c1 t2, may be empty).
- `keywords`: optional pills.

### PushFit
Fit of a 서류 to a 공고.
- `score`: one decimal, e.g. "6.9", drawn in h1 weight.
- `sentence`: beside the score, e.g. "적합도는 6.9점이에요. 보통이고, 고칠 여지가 있어요." or "적합도를 6.9 → 8.3으로 올렸어요. (+1.4)".
- `summary`: optional, the strongest and weakest parts.
- `items[]`: `{label, score}` per part behind a "항목별 점수 보기" toggle that opens in place and starts closed. Absent when locked and on a boost result.
- `missing`: posting keywords the 서류 lacks, joined by " · ".
- `rounds`: boost result only, one marked line per round.
- `locked`: true (free plan) = example bars, never real ones, and one "ULTRA로 업그레이드" button that dispatches `open_plan`.

### PushDocument
The 서류 the Bot made or is drafting. Result surface: optional `Text` summary and `Text` "• …" bullets, then a PushDocument with id `document`. Paper surface: the PushDocument is `root`.
- `status`: `done`, `writing` (no buttons; `meta` reads "쓰는 중") or `failed` (the only action is `retry_save`).
- `title`: what happened, e.g. "이력서를 저장했어요".
- `name`: file row name (600, one line).
- `meta`: file row kind · pages · time, may be empty.
- `lines`: optional draft preview lines.
- `documentId`: present = tapping the file row dispatches `open_review`.
- `share`: true = a share button at the row's end dispatches `share`.
- `actions[]`: `{id, label, method?, path?}`, buttons in order, the first is primary. Each dispatches `result_action`.

### PushJobCard
One posting (design system JobCard, 169px grid version). No server card emits it yet.
- `postingId`, `company`, `title`, `meta` (location · years), `imageUrl` (absent = brand-colour placeholder with the initial).
- **`bookmarked`**: bookmark state, bound so the app can flip it.
- A tap dispatches `open_posting`.

## What the client does

1. **Upsert by `surfaceId`.** If the surface exists, drop `createSurface` and apply `updateComponents` and `updateDataModel`. Otherwise apply all three.
2. **Interactive surface.** Only approval and choice surfaces take input, through PushChoice. Enable only the newest waiting one: the `status` with phase `waiting` names it as `cardId`, and `done.awaiting` says the turn paused. Disable every other surface in the wrapper, even while its `/open` is true.
3. **Answer.** On action `answer`, POST `/bots/:id/approvals/{surfaceId}` (or `/conversations/:id/approvals/{surfaceId}`) with the action's `context` as the body. The routes and bodies are unchanged.
4. **After answering**, patch the surface's own data model: `/open` = false, `/picked` = the ids sent (`optionIds` when present, else `[optionId]`). The server sends no update. A reopened chat returns the answered state already baked in (`/open` false, `/picked` from the approvals row; an expired or typed answer has `/picked` `[]`).
5. **Free text** typed while a surface waits is the answer; patch `/open` = false, `/picked` = `[]`.

### `answer` → approvals body

| How | Body |
|---|---|
| `answer: "pick"`, one id picked (tap, or one checkbox) | `{optionId: id}` |
| `answer: "pick"`, more than one picked | `{optionId: first picked, optionIds: [all picked, in choice order]}` |
| `answer: "submit"`, the submit button | `{optionId: "submit", optionIds: ["submit", …picked ids of every answerable question, in question order]}` |
| `secondary` button | `{optionId: secondary.id}` |

The action is `{name: "answer", surfaceId, sourceComponentId, timestamp, context}` with `context` = the body.

## Local actions

Handled in the app and never sent to the server.

| name | context | dispatched by |
|---|---|---|
| `open_review` | `{documentId}` | PushDiff "전체 보기", PushDocument file row |
| `share` | `{documentId}` | PushDocument share button |
| `result_action` | `{id, method?, path?}` | PushDocument action buttons |
| `open_plan` | `{}` | PushFit "ULTRA로 업그레이드" |
| `change` | `{optionId}` | PushChoice material row 변경 link |
| `open_posting` | `{postingId}` | PushJobCard tap |

`result_action` runs only these ids:
- `apply`: apply to the posting (label "{company}에 바로 지원하기").
- `convert`: call `method` `path` (POST `/api/v1/documents/{id}/profile`).
- `view`: open the Push profile.
- `retry_save`: save-failed "다시 저장하기"; send the chat message "내 서류에 저장해 줘".

## Fixtures

Each file is one wire frame with `seq` 1, `at` `2026-11-23T00:00:00.000000Z` and `turn` `00000000-0000-4000-8000-00000000a001`.

The table names the files of `fixtures/` (v0.9.1); `fixtures/v1.0/` holds the same names in 1.0.

| File | Shows |
|---|---|
| `approval-tool.json` | Tool approval, two-button form (닫기 \| 실행) with a stage-change row, open |
| `approval-tool-answered.json` | The same, answered `approve` |
| `approval-site.json` | Page-read approval: title, detail line, three-row list (한 번 허용, 항상 허용, 거절) |
| `approval-edit.json` | Document edit: title, PushDiff with context, 되돌리기 \| 적용, open |
| `approval-edit-answered.json` | The same, answered `skip` (되돌리기) |
| `choice-single.json` | Single pick that answers on tap, detail line, 추천 mark, 닫기 as a choice |
| `choice-single-answered.json` | The same, answered `ready` |
| `choice-multiple.json` | Multiple pick: checkboxes, "이대로 진행" submit, 닫기 as secondary |
| `choice-multiple-answered.json` | The same, answered `resume` + `cover_letter` |
| `choice-sections.json` | Three questions stepping 1/3 (targets multiple, materials multiple, tone single), defaults in `/selected`, submit "이 말투로 쓰기", `answer: submit` |
| `choice-sections-answered.json` | The same, answered `["submit", "resume", "m_file", "preserve"]` |
| `choice-templates.json` | Template pick with per-option submit labels ("클래식으로 만들기") |
| `plan-strategy.json` | 수정 전략 rows with tones and keyword pills |
| `plan-feedback.json` | 고칠 점 rows, no keywords |
| `paper.json` | Draft in progress: PushDocument `writing` with preview lines |
| `todo.json` | Analysis checklist: done, running, waiting (one "(새로 추가)") |
| `diff.json` | Quality fixes, no `documentId` (no 전체 보기) |
| `fit.json` | Analysis fit: score, sentence, summary, five part bars, missing keywords |
| `fit-locked.json` | Free plan: `locked`, no real bars |
| `fit-boost.json` | Boost result: "6.9 → 8.3으로 올렸어요" with one round line |
| `result.json` | External file saved: summary, bullets, share, actions apply + convert |
| `result-save-failed.json` | Save failed: only `retry_save`, no share |
| `result-profile.json` | Push profile saved: action view, no share |
