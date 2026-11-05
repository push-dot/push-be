# Agent stream v3: design spec

Base: push-be `origin/develop` @ `1799b66` (#223). Branch `feat/agent-stream-v3` exists on the remote with no commits; Cursor builds on it.
Design: push-fe `origin/design/handoff-2026-11-05`, `docs/design-handoff/push-app/10-에이전트-Flow/NN-*`, plus gap report `docs/design-handoff/gaps/g2-agent.md`.
Paths: `ai:` = `push-be/services/ai/src/app/`, `core:` = `push-be/services/core-api/src/`, `contracts:` = `push-be/packages/contracts/`, `fe:` = `push-fe/apps/fo-mobile/src/features/chat/`, `apic:` = `push-fe/packages/api-client/src/`.

## 0. Ground rules (all items)

- Additive only. New event types and new optional fields. Old clients drop unknown `type`s (`fe:utils/stream.ts` `map()` returns null on default) and ignore unknown fields.
- No DB migration. No core-api body schema change.
- Never send model chain-of-thought. Text in `think`/`plan`/`paper` comes from fields the graph already parses (phase output JSON), not from reasoning tokens.
- Every new event is stored in `chat_events` the same way as existing ones (through `emit()` in `ai:harness/tools.py`), so `GET /conversations/{id}/turns` replays it with no extra code.
- Out of scope (do not build): "네, 이번 대화에선 묻지 않기" (owner decision pending); C1 foot "번호를 누르거나 바로 말해도 돼요" (client constant); tool line copy for 자료 찾기 (C3).

Priority: 1 think + plan → 2 paper → 3 panels (10-02, 10-22) → 4 quality gate (10-21) + read failure (10-28) → 5 feedback card.

---

## 1. `think`

**Purpose.** The "생각함 · 6초" line (05 "중단하고 다시 요청", 30 prototype). It shows how long a model step took. It carries no text.

**Event.**
```ts
type ThinkEvent = { type: 'think'; seconds: number /* int ≥ 1 */; phase: string; seq: number }
```
`phase` is the resume phase id (`analyze` | `strategy` | `craft` | `review` | `blueprints`). The app does not render it; it is there for replay and debugging.

**Server.**
- `ai:harness/personal/resume/progress.py`: add `think_event(phase: str, seconds: float) -> dict`. Round seconds with `max(1, round(seconds))`.
- `ai:harness/personal/resume/graph.py` `build_resume_graph.work_node.node`: time `await _output(...)` with `time.monotonic()`. Emit `think_event` right after `_output` returns, before any other event of that phase. Only emit when a model ran (`turn_model.get() or model` is not None) and the phase is in `{"analyze","strategy","craft","review","blueprints"}`.
- Same in `boost` (craft re-run): emit `think_event("craft", …)` after its `_output`.

**App.**
- `apic:types.ts` `StreamEvent`: add `| { type: 'think'; seconds: number; phase?: string }`.
- `fe:utils/stream.ts` `map()`: `case 'think': return { type: 'think', id, seconds: ev.seconds }`. The `ChatItem` `think` already exists (`fe:types.ts`, renderer `items.tsx`).

**Tests.**
- `ai tests/test_resume_progress.py::test_think_event_rounds_up_to_one_second`: `think_event("craft", 0.2)["seconds"] == 1`; `think_event("craft", 6.4)["seconds"] == 6`.
- `ai tests/test_resume_flow_decisions.py` (or new `test_resume_stream_v3.py`) `::test_work_phase_emits_think_before_reply`: with a fake model, the strategy phase's emitted events contain one `think` whose index is lower than the `token` reply. With `model=None`, there is no `think`.
- `fe __tests__/stream.test.ts::maps think to a think item`.

**Done when:** a strategy turn streams `think` → … → `token`; replaying `GET .../turns` shows the same `think`; old app builds ignore it.

---

## 2. `plan` (수정 전략 card; also used for the feedback card in §7)

**Purpose.** 10-11 "수정 전략 · 섹션 5개" card: rows with a tag (강화/수정/추가/축소), a section label, a one-line note, and keyword pills "+ 결제 승인".

**Event.**
```ts
type PlanTag = '강화' | '수정' | '추가' | '축소'                     // feedback card (§7) uses its own tags
type PlanEvent = {
  type: 'plan'
  id: 'strategy' | 'feedback'          // a later plan with the same id replaces the earlier one
  title: string                         // '수정 전략' | '고칠 점'
  meta: string                          // '섹션 5개' | '3개'
  rows: { tag: string; label: string; note: string }[]   // 1..6 rows
  keywords?: string[]                   // 0..6, without the leading '+ '
  seq: number
}
```
The client picks the badge colour from `tag`: 강화→ac, 수정→grey, 추가→green, 축소→orange; feedback tags 키워드/도메인→orange, others→grey.

**Data source.** content-strategy Step 4 already defines a per-section `action` (`keep|modify|expand|condense|remove`), `reason`, `suggested_focus` and `suggested_keywords`, but the harness does not pin the JSON key. Pin it with a prompt note, the same way `_IMPROVEMENTS_NOTE` works:
- `ai:harness/personal/resume/graph.py`: add `_STRATEGY_NOTE = "섹션별 전략을 sections 배열에 넣는다. 각 항목은 {section, action(keep|modify|expand|add|condense|remove), reason, suggested_keywords}다."` and append it in `phase_instructions` when `phase == "strategy"`.
- Action → tag: `expand→강화`, `modify→수정`, `add→추가`, `condense|remove→축소`. `keep` is dropped.
- `label` = `section`. `note` = `reason` (falls back to `suggested_focus`), capped at 60 chars.
- `keywords` = de-duplicated union of `suggested_keywords`, capped at 6.

**Server.**
- `ai:harness/personal/resume/progress.py`: `strategy_plan(output: dict) -> dict | None`. It returns None when no row survives (then nothing is emitted). Also add `strategy_line(plan) -> tool event` with name `strategy`, summary `전략 세우기`, target `공고 요건 ↔ 내 경력`, resultLine `섹션 {n}개 · 추가할 키워드 {k}개` (the `· 추가할 …` part only when k > 0).
- `graph.py` `work_node.node`: when `phase == "strategy"` and the output is valid, emit `strategy_line` then `strategy_plan` after `_store_output`, before the reply token. Do not emit on the retry path (`output.valid is False`).

**App.**
- `apic:types.ts`: add `| { type: 'plan'; id?: string; title: string; meta: string; rows: { tag: string; label: string; note: string }[]; keywords?: string[] }`.
- `fe:utils/stream.ts`: `case 'plan'` → `ChatItem` `plan` (it exists: `{title, meta, rows:{tag,tone,label,note}[], keywords}`). Map tag→tone with a `PLAN_TAG_TONE` constant in `fe:constants.ts`. Default `keywords` to `[]`. Use `ev.id` as the item id so a replacement updates in place (the same rule as `todo`).

**Tests.**
- `test_resume_progress.py::test_strategy_plan_maps_actions_to_tags`: input with 5 sections (expand, modify, add, condense, keep) → 4 rows with tags `['강화','수정','추가','축소']`; `meta == '섹션 4개'`.
- `::test_strategy_plan_none_when_only_keep` → `None`.
- `::test_strategy_plan_caps_keywords_at_six_and_dedupes`.
- `::test_strategy_line_omits_keyword_count_when_zero`.
- Graph: `::test_strategy_phase_emits_plan_before_gate`: the event order is `think`, `tool(strategy)`, `plan`, `token`, `choice(gate=strategy)`.
- `fe stream.test.ts::maps plan rows with tag tones`.

**Done when:** 10-11 renders from live data: tool line, card, then the gate "이 전략대로 초안을 쓸까요?".

---

## 3. `paper` (draft preview card)

**Purpose.** 10-16 "이력서 초안 v1 / 김서준 · 백엔드 개발자 / …" preview. It is a document card, not a markdown file card; `.md` stays hidden.

**Event.**
```ts
type PaperEvent = {
  type: 'paper'
  id: string          // 'draft-{target}-v{version}', e.g. 'draft-resume-v1'
  label: string       // '이력서 초안 v1' | '포트폴리오 초안 v1' | '자기소개서 초안 v1'
  heading: string     // first markdown H1/H2 text; else '{name} · {headline}' from profile_card_names; else ''
  lines: string[]     // first 6 body lines, markdown stripped (#, *, _, `, leading '- ' → '• '), each ≤ 120 chars
  seq: number
}
```

**Server.**
- `ai:harness/personal/resume/progress.py`: `paper_event(target: str, version: int, markdown: str, fallback_heading: str = "") -> dict | None`. It returns None when the markdown is empty.
- `graph.py` `work_node.node`: when `phase == "craft"`, emit one `paper` per target in `_targets(current)` after `_store_output` and before the reply. The markdown comes from `draft_text(stored["drafts"])`. Version comes from `current.get("draft_version") or 1`.
- `boost`: emit `paper` with the bumped version after each cycle (same id pattern, so the client replaces the card when the id matches; a new version gets a new card).
- It is not streamed token by token. This is a final preview; the design's blinking caret is client-only while the status row is active.

**App.**
- `apic:types.ts`: `| { type: 'paper'; id: string; label: string; heading: string; lines: string[] }`.
- `fe:utils/stream.ts`: `case 'paper'` → the existing `ChatItem` `paper` `{label, heading, lines}`, with id `ev.id`.

**Tests.**
- `test_resume_progress.py::test_paper_event_strips_markdown_and_caps_lines`: 10-line markdown → 6 lines, no `#`/`**`, `- x` becomes `• x`.
- `::test_paper_event_none_for_empty_draft`.
- Graph `::test_craft_emits_paper_per_target`: targets `[resume, cover_letter]` → two papers with labels `이력서 초안 v1`, `자기소개서 초안 v1`.
- `fe stream.test.ts::maps paper`.

**Done when:** after the craft phase, the thread shows the paper card above "첫 번째 초안(v1)이에요. 이대로 검토할까요?", and no `.md` file card appears.

---

## 4. Multi-section choice panels (10-02, 10-22) + answer shape

### 4.1 Event schema (added to the existing `choice`)
```ts
type ChoiceOption = { id: string; label: string; desc?: string; sub?: string; badge?: string }

type ChoiceSection =
  | { id: string; kind: 'chips'; title?: string; multiple?: boolean; options: ChoiceOption[]; selected: string[] }
  | { id: string; kind: 'rows'; title?: string; options: (ChoiceOption & { action?: 'change' })[] }   // display only; never answered
  | { id: string; kind: 'toggle'; title?: string; options: ChoiceOption[]; selected: string[] }       // checkbox rows; each option on/off
  | { id: string; kind: 'thumbnails'; title?: string; options: ChoiceOption[]; selected: string[] }   // single select; option.id is a template id

type ChoiceSubmit = {
  label: string                              // may contain {n} = count of selected ids in 'toggle' sections
  zeroLabel?: string                         // used when {n} would be 0
  optionLabels?: Record<string, string>      // thumbnails: label per selected option id, e.g. CLASSIC → '클래식으로 만들기'
}

type ChoiceEvent = /* existing fields */ {
  sections?: ChoiceSection[]   // present → render the sections instead of options
  submit?: ChoiceSubmit        // present → answer with the button, not by tapping an option
}
```
Rules:
- Option ids are unique across the whole card (top-level `options` + every section). The current ids already don't collide: targets `resume|portfolio|cover_letter`, tone `professional|…|preserve`, templates `CLASSIC|MODERN|COMPACT|ATS`, toggle `photo`, recommendations `rec1..rec6`, `cancel`, `submit`.
- Top-level `options` stays and is the **old-client fallback**: what an app without `sections` support renders and answers.
- `cancel` stays a top-level option. The new UI shows it as the secondary button (10-22 "그만하기") or as a chip (10-02).

### 4.2 Answer API contract: `POST /api/v1/conversations/{id}/approvals/{approvalId}` (core-api, **no code change**)

Request (unchanged schema):
```ts
{ optionId?: string; optionIds?: string[] }   // closed object
```
- New client, sections card: `{ optionId: 'submit', optionIds: ['submit', ...pickedIdsFromAllAnswerableSections] }`.
- Cancel: `{ optionId: 'cancel' }`.
- Old client: as today (`optionId` or `optionIds` from the top-level options).

Validation stays in `core:routes/conversations.ts` `selectedOptions`: every id must be in the card's stored options; when both are present, `optionId` must be in `optionIds`; `optionIds` must be non-empty strings. The errors are unchanged: 400 `VALIDATION_ERROR` (`field: optionId|optionIds`), 404, 409 `APPROVAL_ALREADY_RESOLVED`, 410 `APPROVAL_EXPIRED`. Response unchanged: 202 `{id, status:'APPROVED', optionId, optionIds?, jobId}`.

What makes this work: the AI service stores the **union** in `approvals.options` (top-level options + every section option except `rows` + `{id:'submit', label: submit.label}`).
- `ai:harness/approvals.py`: add `card_options(event) -> list[dict]` and use it in `insert_chat_approval` (both the `options` column and `payload_hash`). The emitted event keeps its top-level `options` unchanged.

Server-side meaning (in `graph.py` `_apply_answer` / a new `_section_answer(event_sections, answer) -> dict[section_id, list[str]]`):
- Picks are bucketed by section using the ids the card offered (rebuild the sections with the same builder; do not trust the client to label sections).
- `chips` single (`multiple` absent) or `thumbnails`: keep the first pick in that section; none → the section's `selected` default.
- `chips` multiple: all picks in that section; none → `selected` default.
- `toggle`: an option is on if its id is in `optionIds` **and** the answer has `submit`. With an old-client answer (no `submit`), toggles take their `selected` default.
- `rows`: ignored.

Contract doc: update `contracts:spec/conversations.ts` (route description + `choice` schema: `sections`, `submit`, option `sub`), then `npm run generate` in `packages/contracts` (`openapi.json`, `src/schema.ts`). Describe the answer rule in one sentence: "For a card with sections, send optionId submit and optionIds [submit, …picked ids]; ids from any answerable section are valid."

### 4.3 10-02 산출물과 자료 (gate `output_targets`)

Event built by `_choice(state, "output_targets", …)` when sections are on (always for new turns):
```jsonc
{
  "type": "choice", "gate": "output_targets", "kind": "RESUME_GATE",
  "title": "어떤 산출물을 만들까요?", "multiple": true, "recommended": "resume",
  "options": [ /* unchanged fallback: resume, portfolio, cover_letter, cancel */ ],
  "sections": [
    { "id": "targets", "kind": "chips", "title": "어떤 산출물을 만들까요?", "multiple": true,
      "options": [{"id":"resume","label":"이력서"},{"id":"portfolio","label":"포트폴리오"},{"id":"cover_letter","label":"자기소개서"}],
      "selected": ["resume"] },
    { "id": "materials", "kind": "rows", "title": "가져올 자료",
      "options": [
        {"id":"m_file","label":"김서준_백엔드_이력서_2026.pdf","sub":"마이 › 서류","action":"change"},
        {"id":"m_posting","label":"백엔드 엔지니어 (Kotlin·Spring)","sub":"홈 › 북마크 공고","badge":"모","action":"change"},
        {"id":"m_github","label":"github.com/seojun-kim","sub":"이력서에서 찾았어요","action":"change"}
      ] },
    { "id": "tone", "kind": "chips", "title": "어떤 말투로 쓸까요?",
      "options": [ /* the 6 tone options from _GATES["tone"] */ ], "selected": ["preserve"] }
  ],
  "submit": { "label": "다음" }
}
```
- Material rows come from `state.inputs`. File: `_file_name(inputs)` with sub `마이 › 서류` when it came from a stored document (`inputs.documentId`), else `올린 파일`. Posting: `inputs.posting.{company,title}`, sub `홈 › 북마크 공고` when `inputs.postingId`, else `붙여넣은 링크`, badge = the first char of company. GitHub: `inputs.github` or the first github.com page, sub `이력서에서 찾았어요` when it was found in the analysis, else `내 링크`. Omit missing rows. When there are no rows, omit the `materials` section.
- The design shows no confirm button (chips submit on the tone tap). The server still sends `submit` so the client can confirm; the label is "다음" (owner may change it). The app may submit automatically when the tone chip is tapped.
- Builder: `progress.py` → `intake_panel(inputs, analysis=None) -> list[section]` (pure function).
- Graph: in `gate_node("output_targets")`, after `accepted(...)`: if the bucketed answer has a `tone` pick, set `update["tone"]` and route `goto="g_intake"` (skip `g_tone`). Without a tone pick (old client), keep `goto="g_tone"`. Change `_INTAKE_NEXT` handling inside `_advance`, not a new node.
- Auto mode (`_must_stop` false): `_auto_answer` returns every section's `selected` default. Emit the auto choice as today.

### 4.4 10-22 템플릿 (gate `review`)
```jsonc
{
  "type": "choice", "gate": "review", "title": "검증을 마쳤어요. 어떤 디자인을 적용할까요?",
  "detail": "템플릿을 골라 주세요. 처음이라면 클래식을 추천해요.", "recommended": "CLASSIC",
  "options": [ /* unchanged fallback: CLASSIC(badge 추천), MODERN, COMPACT, ATS, cancel */ ],
  "sections": [
    { "id": "template", "kind": "thumbnails",
      "options": [{"id":"CLASSIC","label":"클래식","badge":"추천"},{"id":"MODERN","label":"모던"},{"id":"COMPACT","label":"컴팩트"},{"id":"ATS","label":"ATS"}],
      "selected": ["CLASSIC"] },
    { "id": "photo", "kind": "toggle",
      "options": [{"id":"photo","label":"프로필 사진 넣기","desc":"마이 › 프로필 사진을 써요 · 모든 템플릿"}],
      "selected": ["photo"] }
  ],
  "submit": { "label": "만들기", "optionLabels": {"CLASSIC":"클래식으로 만들기","MODERN":"모던으로 만들기","COMPACT":"컴팩트로 만들기","ATS":"ATS로 만들기"} }
}
```
- Put the labels in a constant in `graph.py`; don't compute the Korean particle at runtime.
- State: add `profile_photo: bool` to `ResumeGraphState` and `ai:harness/personal/resume/state.py` `ResumeState`. The answer sets it; the old-client answer and auto mode default it to True.
- Use: pass it into the `01_scenario.json`/design artifact and to `save_artifact(..., template)` callers in publish. **Open:** whether the PDF renderer can place a photo. If not, store the flag only and list "renderer photo slot" as follow-up; do not fake it.
- Only show the photo toggle when the user has a profile photo. If core has no cheap lookup, always show it (design note says "모든 템플릿") and list the lookup as follow-up.

### 4.5 Backward compatibility
- Old app: renders the top-level `options` exactly as today. For 10-02 it answers targets only, `g_tone` still asks the tone (flow unchanged). For 10-22 it answers a template, and photo defaults to on.
- Replay: `resolution.optionIds` already comes from the resume payload (`ai:infrastructure/store_turns.py`), so the new answers replay with no change.
- Idempotency key (`core withApprovalAnswerKey`) already hashes the joined `optionIds`, so different picks get different keys.

### 4.6 App changes
- `apic:types.ts`: extend `StreamOption` with `desc?`, `sub?`, `badge?`. Add `ChoiceSection`, `ChoiceSubmit`, and `sections?`/`submit?`/`note?` to the `choice` member. Extend `ApprovalResolution` with `optionIds?: string[]`. Make the answer call accept `optionIds` (check `apic` endpoints; send `{optionId:'submit', optionIds}`).
- `fe:types.ts`: add `ids: string[]` (parallel to options/items) and `id: string` to each `ApprovalSection`. Add section kinds `toggle` (checkbox rows with desc) and map `thumbnails` → the existing `templates`. Add `submitLabels?: Record<string,string>` and `zeroSubmit?: string` to `Approval`.
- `fe:utils/stream.ts` `case 'choice'`: when `ev.sections`, build sections from them (do not call the current single-section `ask`). Otherwise keep today's path.
- `fe:components/approval-panel.tsx`: collect selected ids across answerable sections, then send `{optionId:'submit', optionIds:['submit', ...ids]}`. The submit label is `submitLabels[selectedThumbnail] ?? submit.label`, with `{n}` replaced (and `zeroSubmit` when n = 0). A `rows` "변경" opens the existing 자료 고르기 sheet (`composer-area.tsx`).

### 4.7 Tests
- `ai tests/test_resume_progress.py::test_intake_panel_rows_from_inputs`: file + posting + github inputs → 3 rows with the subs above. No github → 2 rows. No inputs → no `materials` section.
- `ai tests/test_gate_copy.py::test_review_choice_has_template_and_photo_sections`: copy as in §4.4; `submit.optionLabels['ATS'] == 'ATS로 만들기'`.
- `ai tests/test_resume_panels.py` (new):
  - `test_card_options_union_includes_sections_and_submit`: `card_options(event)` ids == top-level ids ∪ section ids (minus rows) ∪ {'submit'}.
  - `test_output_targets_answer_with_tone_skips_tone_gate`: answer `{option_id:'submit', option_ids:['submit','resume','portfolio','concise']}` → `output_targets == ['resume','portfolio']`, `tone == 'concise'`, `goto == 'g_intake'`.
  - `test_output_targets_old_answer_still_asks_tone`: `{option_ids:['resume']}` → `goto == 'g_tone'`, tone unset.
  - `test_single_section_keeps_first_pick`: two tone ids → the first in section order wins.
  - `test_review_toggle_off_when_submit_without_photo`: `['submit','MODERN']` → `template == 'MODERN'`, `profile_photo is False`.
  - `test_review_old_answer_defaults_photo_on`: `{option_id:'MODERN'}` → `profile_photo is True`.
  - `test_auto_mode_uses_section_defaults`.
- `core-api test/approvals-resume.test.ts::accepts submit with section ids stored in options`: a card row whose options include `submit`, `tone ids` → 202, and the resume payload `optionIds` equals the request.
- `fe __tests__/stream.test.ts::maps choice sections to approval sections with ids`. `fe` approval panel test: the submit sends `['submit', ...]` and the label follows the selected thumbnail.

**Done when:** in the app, 10-02 is one panel that answers once and lands on "이대로 분석을 시작할까요?". 10-22 shows thumbnails + toggle + "클래식으로 만들기" and the chosen template/photo flag are in state. An old app build still completes both gates.

---

## 5. Quality-check gate (10-21), new gate `quality`

**Purpose.** After the review phase: show what was fixed automatically (P0) and let the user choose which recommendations (P1/P2) to apply, then go to the template gate.

**Data source.** quality-review already says P0 is fixed automatically and disclosed, and P1–P2 are offered as recommendations. The harness does not pin the JSON shape. Add `_REVIEW_NOTE` in `graph.py` `phase_instructions` for `review`:
`"바로 고친 것을 auto_fixes 배열({line, before, after})에, 사용자가 고를 추천 수정을 recommendations 배열({label, desc, priority: P1|P2}, 최대 6개)에 넣는다."`

**Events, in order (all in a new node `g_quality` between `p4a_review` and `g4a`):**
```ts
// 1. tool line
{ type:'tool', name:'quality_check', state:'ok', tier:'READ', summary:'품질 검사',
  target:'오타 · 문법 · 말투 · ATS', resultLine:'바로 고친 것 {a}개 · 추천 {r}개' }   // drop the zero part; both zero → '고칠 곳이 없어요'
// 2. diff of auto fixes (only when a > 0)
{ type:'diff', documentId:'', revisionId:'', hunks: [{line, sign:'-', text:before}, {line, sign:'+', text:after}, …] }
// 3. choice (only when r > 0)
{ type:'choice', kind:'RESUME_GATE', gate:'quality', title:'추천 수정도 반영할까요?', multiple:true,
  recommended:'rec1',
  options:[{id:'rec1',label,desc?}, …],                         // fallback = the same recs, no cancel (design has none)
  sections:[{ id:'recs', kind:'toggle', options:[…same…], selected:[ids where priority == 'P1'] }],
  submit:{ label:'{n}개 반영하고 디자인으로', zeroLabel:'그대로 디자인으로' } }
// 4. after the answer, tool line
{ type:'tool', name:'apply_recommendations', state:'ok', tier:'SAFE_WRITE', summary:'추천 수정 반영',
  target:'{n}개', resultLine: picked labels joined ' · ' }      // skip when n == 0
```
- Answer: `{optionId:'submit', optionIds:['submit', ...recIds]}` (0..r recs). An old client sends `optionIds: [recIds]` (≥1). Store `review.apply = [picked labels]`.
- Apply: the publish phase already rewrites from drafts + review. Append `"review.apply의 수정만 반영한다."` to the publish prompt when the list is non-empty (in `phase_instructions`). No extra model call.
- r == 0 or auto mode: emit tool line (+ diff), skip the choice (auto mode emits the choice with `auto:true` and applies P1 picks), then continue to `g4a`.
- Gate plumbing: add `"quality"` to `_GATES` (title only), add the node to the graph (`p4a_review → g_quality → g4a`), `_advance("quality")` → `goto` into `g4a` (add `"g4a"` to `_EXITS`), and `route_phase` for a resumed `phase == "review"` with a pending quality gate. Scenario C (`p4b_design`) skips the quality gate (there is no review output).
- Copy fix in the same pass: `ai:harness/tools.py RETRY_WARNING` → `시간이 오래 걸려서 한 번 더 시도했어요` (10-28 shows this exact text).

**App.** Nothing beyond §4.6 (`toggle` section + `{n}` submit label). The diff with `line` set maps through the existing `diff` case.

**Tests** (`test_resume_panels.py` or a new `test_quality_gate.py`):
- `test_quality_line_counts`: a=2, r=3 → `'바로 고친 것 2개 · 추천 3개'`; a=0, r=1 → `'추천 1개'`; both 0 → `'고칠 곳이 없어요'`.
- `test_quality_diff_pairs_before_after`.
- `test_quality_choice_preselects_p1`: `selected == ids of P1`.
- `test_quality_submit_with_zero_picks_goes_to_template_gate`: `['submit']` → `review.apply == []`, next event `choice(gate=review)`.
- `test_quality_skipped_when_no_recommendations`.
- `test_publish_prompt_includes_apply_list`.
- `test_gate_copy.py::test_quality_copy`.

**Done when:** 10-21 renders as designed from a review output with fixes and recommendations, the confirm label counts the picks, and 10-22 follows with the tool line "추천 수정 반영 · 2개".

---

## 6. Read-failure choice (10-28), new gate `read_failed`

**Purpose.** When the posting could not be read (or only partly), say so and ask how to continue instead of scoring against a missing posting.

**Detection** (in `classify_scenario` → `report_analysis`, `graph.py`): the posting step is in `analyze_steps(inputs, analysis)` **and** `_job_terms(analysis)` is empty, or `analysis.jobs.read_error` is set. Add `read_error` (one short Korean reason, e.g. `로그인이 필요한 영역이에요`) to `_IMPROVEMENTS_NOTE` as an optional key when a page could not be read.

**Events:**
```ts
// posting tool line in the err state (progress.posting_line gets an optional error)
{ type:'tool', name:'analyze_posting', state:'err', tier:'READ', summary:'공고 읽기',
  target:'{company · title}' || '회사 채용 페이지', resultLine:'“자격 요건”을 읽지 못했어요 · {read_error}' }   // '· …' only when read_error
// skip the fit step: no fit_line / fit card in this case
{ type:'token', text:'나머지 내용으로 진행할 수 있지만, 자격 요건이 빠지면 적합도가 정확하지 않을 수 있어요.' }
{ type:'choice', kind:'RESUME_GATE', gate:'read_failed', title:'어떻게 할까요?', recommended:'paste',
  options:[{id:'paste',label:'공고 내용을 붙여넣을게요'},{id:'proceed',label:'이대로 진행해 주세요'},{id:'pick',label:'Push 공고에서 고를게요'}] }   // no cancel (design has none)
```
- New node `g_read_failed` between `classify_scenario` and `g1`. It is a conditional edge: failure → `g_read_failed`, else → `g1`. `_must_stop` is always True for it (like `validate_cap`).
- Answers:
  - `proceed` → continue to `g1` (fit stays unscored; `fit_from` None).
  - `paste` → end the turn with token `공고 내용을 붙여 넣어 주세요.`; `phase = "analyze"`, `status = "active"`. The user's next message (or a typed answer to this card, existing text-answer path) is merged into `inputs.pages["붙여넣은 공고"]` and analyze re-runs. **Confirm in `ai:harness/runtime.py`** how a new USER message enters an active resume flow; reuse that path, don't add a new one.
  - `pick` → end the turn with token `공고를 골라 주세요. @로 북마크 공고를 부를 수 있어요.`; same re-run on the next message with `inputs.postingId`.
  - A typed answer → treat it as pasted posting text (same as `paste` + text).

**App.** No new types; the client already has the default title and `detail`.

**Tests** (`test_read_failure.py`, new):
- `test_posting_line_err_with_reason` / `test_posting_line_err_without_reason`.
- `test_missing_requirements_routes_to_read_failed_gate_and_skips_fit`: no `fit` event, then events `tool(err)`, `token`, `choice(gate=read_failed)`.
- `test_proceed_continues_to_analyze_gate`.
- `test_paste_answer_reruns_analyze_with_pasted_page`.
- `test_typed_answer_counts_as_paste`.
- `test_gate_copy.py::test_read_failed_copy`.

**Done when:** a posting URL that yields no requirements produces 10-28, and each of the three options leads to a working next step.

---

## 7. Feedback card (10-10)

**Purpose.** "피드백만 받을게요" → tool line "피드백 정리 · 공고 요건 ↔ 내 이력서 / 고칠 점 3개" plus a card of rows: tag badge (키워드/도메인/성과…), problem, fix.

**Data today:** only `analysis.message` and `analysis.improvements: string[]`, with no tag/problem/fix structure. The card needs a prompt change; build it last.

**Data change:** extend `_IMPROVEMENTS_NOTE`: `"같은 내용을 feedback 배열({tag: 키워드|도메인|성과|기술|경력, problem, fix})로도 넣는다."`

**Events** (in `graph.py feedback_node`, before the token):
```ts
{ type:'tool', name:'feedback', state:'ok', tier:'READ', summary:'피드백 정리', target:'공고 요건 ↔ 내 이력서', resultLine:'고칠 점 {n}개' }
{ type:'plan', id:'feedback', title:'고칠 점', meta:'{n}개', rows:[{tag, label: problem, note: fix}] }   // reuse plan (§2); max 5 rows
{ type:'token', text:'이 공고 기준으로 고칠 점이에요.' }   // replaces _feedback_text when rows exist; else keep today's text
```
Fallback: no `feedback` array → no card; emit today's `token` only.

**App.** Covered by §2 (`plan` mapping + feedback tag tones).

**Tests.** `test_resume_progress.py::test_feedback_plan_from_analysis` (3 rows, `meta == '3개'`), `::test_feedback_plan_none_without_structured_feedback`, graph `::test_feedback_node_emits_tool_plan_token`.

**Done when:** 10-10 renders from a real analysis and falls back to plain text when the model omits `feedback`.

---

## 8. Contracts and verification checklist

- `contracts:spec/conversations.ts`, `chatEvents`: add `think`, `plan`, `paper`; `choice` + `sections`, `submit`; `option` + `sub`; doc lines for the `quality` and `read_failed` gates in `chatStreamDescription`; the answer rule in the `approvals/{approvalId}` route description. Then `cd packages/contracts && npm run generate`, and commit `openapi.json` + `src/schema.ts`.
- Run: `cd services/ai && uv run --extra test pytest -q`, `npm test` at the repo root (core-api, gateway, contracts drift). Nothing touches SQL schema; `approvals.options` is already jsonb.
- PR: `feat(ai): agent stream panels, think and plan` → `develop`, with an event/field table (§1–§7).
- App PR (push-fe): `apic` types, `fe` mapper, panel submit; tests as listed.
