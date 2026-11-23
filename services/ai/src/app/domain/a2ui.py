"""A stored Bot card payload as A2UI messages, in v0.9.1 (Android) or 1.0 (iOS, web).

Graph code keeps emitting the legacy card dicts and chat_events keeps them as the stored truth.
`to_a2ui` builds the surface the clients draw from one payload, live (`_live_event`) and on replay
(`chat_turns`, with the answer from the approvals row baked into the data model). Every result is
a full snapshot: createSurface, updateComponents, updateDataModel. The per-kind builders write one
version-neutral component list (bindings are `Bind`); `_serialise` writes it per version. The
components are those of packages/contracts/a2ui/push-catalog.json (v0.9.1) and
push-catalog.v1.json (1.0); all text is plain text and no theme is sent.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4

V091 = "v0.9.1"
V1 = "1.0"
VERSIONS = (V091, V1)
CATALOG_ID = "https://push.app/a2ui/catalogs/push/v1/catalog.json"
CARD_KINDS = frozenset({"approval", "choice", "plan", "paper", "todo", "diff", "fit", "result"})
_KEYED = frozenset({"plan", "paper", "todo"})

CHOICE_QUESTION = "어떻게 할까요?"
MULTI_PICK_SUBMIT = "이대로 진행"
UNDO_LABEL = "되돌리기"
APPLY_LABEL = "적용"
SAVE_FAIL_TEXT = "내 서류에 저장하지 못했어요. 네트워크를 확인해 주세요."
SAVE_RETRY = {"id": "retry_save", "label": "다시 저장하기"}
_WAY_OUT = ("reject", "skip", "cancel")
_CLOSERS = frozenset({"그만하기", "취소"})
_FIT_PARTS = (
    ("techStack", "기술 스택"),
    ("experienceLink", "경험 연관성"),
    ("careerLevel", "경력 수준"),
    ("keyword", "키워드"),
    ("domain", "도메인"),
)
_TAG_TONES = {"우대": "green", "통과": "green", "보완": "orange", "조건부": "orange"}
_DIFF_CAP = 20
_DIFF_CONTEXT = 2


def mint_sid(kind: str, payload: dict, scope: str) -> str | None:
    """The surface id a new row stores as `sid`. A card is its approval id and stores none.

    plan, paper and todo are replaced in place within one job; scope is the job id, so a later
    run's card with the same id is a new surface."""
    if kind in _KEYED:
        return f"{kind}:{payload.get('id') or kind}:{scope}"
    if kind in CARD_KINDS and kind not in ("approval", "choice"):
        return str(uuid4())
    return None


def version_of(header: str | None) -> str:
    """The A2UI version a request asks for with its A2UI-Version header. Anything else is v0.9.1."""
    return V1 if (header or "").strip() == V1 else V091


@dataclass(frozen=True)
class Bind:
    """A data binding in a component prop: {"path": p} in v0.9.1, {"@path": p} in 1.0."""

    path: str


def _neutral(kind: str, payload: dict, resolution: dict | None):
    build = _BUILDERS.get(kind)
    sid = (
        str(payload.get("id") or "")
        if kind in ("approval", "choice")
        else str(payload.get("sid") or "")
    )
    if build is None or not sid:
        return None
    built = build(payload, resolution)
    return None if built is None else (sid, *built)


def _component(version: str, component: dict) -> dict:
    out = {}
    for key, value in component.items():
        if isinstance(value, Bind):
            value = {"@path" if version == V1 else "path": value.path}
        out[key] = value
    # 1.0 Text has only caption and body; a heading is body, since surfaces never carry Markdown.
    if (
        version == V1
        and out.get("component") == "Text"
        and out.get("variant") not in (None, "caption")
    ):
        out.pop("variant")
    return out


def _serialise(version: str, sid: str, components: list[dict], data: dict) -> dict:
    wire = [_component(version, component) for component in components]
    return {
        "surfaceId": sid,
        "messages": [
            {"version": version, "createSurface": {"surfaceId": sid, "catalogId": CATALOG_ID}},
            {"version": version, "updateComponents": {"surfaceId": sid, "components": wire}},
            {"version": version, "updateDataModel": {"surfaceId": sid, "path": "/", "value": data}},
        ],
    }


def to_a2ui(
    kind: str, payload: dict, resolution: dict | None = None, version: str = V091
) -> dict | None:
    """{surfaceId, messages} for a card row, None for a row no client draws (an auto-picked
    choice, a row without a surface id). `resolution` is the approvals row's answer."""
    neutral = _neutral(kind, payload, resolution)
    return None if neutral is None else _serialise(version, *neutral)


def surfaces(kind: str, payload: dict) -> dict | None:
    """Every version's projection of a new row, by version: what a live row stores under a2ui."""
    neutral = _neutral(kind, payload, None)
    return None if neutral is None else {v: _serialise(v, *neutral) for v in VERSIONS}


def frame(kind: str, projection: dict) -> dict:
    """The wire frame of a projected row, as the gateway's frameOf sends it (without seq and at)."""
    return {
        "type": "a2ui",
        "kind": kind,
        "surfaceId": projection["surfaceId"],
        "messages": projection["messages"],
    }


def _text(cid: str, text: str, variant: str | None = None) -> dict:
    component = {"id": cid, "component": "Text", "text": text}
    if variant:
        component["variant"] = variant
    return component


def _column(children: list[dict]) -> dict:
    return {"id": "root", "component": "Column", "children": [child["id"] for child in children]}


def _list(raw) -> list:
    return raw if isinstance(raw, list) else []


def _close(label: str) -> str:
    return "닫기" if label in _CLOSERS else label


def _answer_state(resolution: dict | None) -> dict:
    """/open and /picked: open until the approvals row is answered, then the ids it stored."""
    if not resolution or resolution.get("status") == "PENDING":
        return {"open": True, "picked": []}
    ids = [str(item) for item in _list(resolution.get("optionIds"))]
    if not ids and resolution.get("optionId"):
        ids = [str(resolution["optionId"])]
    return {"open": False, "picked": ids}


def _choices(options: list, recommended=None) -> list[dict]:
    out = []
    for option in options:
        if not isinstance(option, dict) or not option.get("id"):
            continue
        item: dict[str, object] = {
            "id": str(option["id"]),
            "label": _close(str(option.get("label") or "")),
        }
        desc = option.get("desc") or option.get("sub")
        if desc:
            item["desc"] = str(desc)
        if option.get("badge") == "추천" or (recommended and option["id"] == recommended):
            item["recommended"] = True
        if option.get("action") == "change":
            item["change"] = True
        out.append(item)
    return out


def _bound(component: dict) -> dict:
    return {
        **component,
        "open": Bind("/open"),
        "picked": Bind("/picked"),
        "selected": Bind("/selected"),
    }


def _buttons(options: list) -> list[dict]:
    """The approval panel's pair: the way out on the left, the action on the right."""
    ordered = sorted(options, key=lambda option: option.get("id") not in _WAY_OUT)
    return _choices(ordered)


def _diff_lines(hunks: list) -> tuple[list[dict], int, int]:
    rows = [
        (str(hunk.get("sign") or ""), line)
        for hunk in hunks
        if isinstance(hunk, dict)
        for line in (str(hunk.get("text") or "").splitlines() or [""])
    ]
    changed = [index for index, (sign, _) in enumerate(rows) if sign in ("+", "-")]
    kept = set(changed[:_DIFF_CAP])
    near = {
        index
        for at in kept
        for index in range(at - _DIFF_CONTEXT, at + _DIFF_CONTEXT + 1)
        if 0 <= index < len(rows) and rows[index][0] not in ("+", "-")
    }
    lines = [
        {"sign": sign, "text": text}
        for index, (sign, text) in enumerate(rows)
        if index in kept | near
    ]
    return lines, sum(sign == "+" for sign, _ in rows), sum(sign == "-" for sign, _ in rows)


def _diff(cid: str, hunks: list, document_id) -> dict:
    lines, added, removed = _diff_lines(hunks)
    if added and removed:
        title = f"{added}줄을 더하고 {removed}줄을 뺐어요"
    elif added:
        title = f"{added}줄을 더했어요"
    elif removed:
        title = f"{removed}줄을 뺐어요"
    else:
        title = "바뀐 줄이 없어요"
    component = {"id": cid, "component": "PushDiff", "title": title, "lines": lines}
    if document_id:
        component["documentId"] = str(document_id)
    return component


def _approval(p: dict, resolution):
    options = [option for option in _list(p.get("options")) if isinstance(option, dict)]
    ids = [option.get("id") for option in options]
    parts: list[dict] = []
    if p.get("kind") == "DOCUMENT_EDIT":
        parts.append(_text("title", str(p.get("title") or ""), "h3"))
        if _list(p.get("hunks")):
            parts.append(_diff("diff", _list(p.get("hunks")), p.get("documentId")))
        buttons = _buttons(options)
        if len(buttons) == 2:
            buttons[0]["label"], buttons[1]["label"] = UNDO_LABEL, APPLY_LABEL
        choice = {"form": "buttons", "choices": buttons}
    else:
        site = "approve_always" in ids
        posting = p.get("toolName") == "apply_to_posting"
        question = p.get("title") if site or posting else (p.get("summary") or p.get("title"))
        parts.append(_text("title", str(question or ""), "h3"))
        if site and p.get("summary"):
            parts.append(_text("detail", str(p["summary"])))
        for index, row in enumerate(_list(p.get("rows"))):
            if isinstance(row, dict):
                parts.append(
                    _text(
                        f"row{index}",
                        f"{row.get('name', '')} · {row.get('from', '')} → {row.get('to', '')}",
                    )
                )
        if p.get("foot"):
            parts.append(_text("foot", str(p["foot"]), "caption"))
        pair = len(options) == 2
        choice = {
            "form": "buttons" if pair else "list",
            "choices": _buttons(options) if pair else _choices(options),
        }
    picker = _bound(
        {
            "id": "choice",
            "component": "PushChoice",
            "form": choice["form"],
            "questions": [{"id": "q", "choices": choice["choices"]}],
            "answer": "pick",
        }
    )
    parts.append(picker)
    return [_column(parts), *parts], {**_answer_state(resolution), "selected": {"q": []}}


def _section_question(section: dict, recommended) -> dict | None:
    kind = section.get("kind")
    if kind not in ("chips", "toggle", "thumbnails", "rows"):
        return None
    question = {
        "id": str(section.get("id") or kind),
        "choices": _choices(
            _list(section.get("options")), recommended if kind == "thumbnails" else None
        ),
    }
    if section.get("title"):
        question["title"] = str(section["title"])
    if kind == "toggle" or (kind == "chips" and section.get("multiple")):
        question["multiple"] = True
    if kind == "rows":
        question["answerable"] = False
    return question if question["choices"] else None


def _choice(p: dict, resolution):
    if p.get("auto"):
        return None
    options = [option for option in _list(p.get("options")) if isinstance(option, dict)]
    cancel = next((option for option in options if option.get("id") == "cancel"), None)
    submit = p.get("submit") if isinstance(p.get("submit"), dict) else None
    sections = [section for section in _list(p.get("sections")) if isinstance(section, dict)]
    picker: dict = {"id": "root", "component": "PushChoice"}
    if sections:
        questions = [q for q in (_section_question(s, p.get("recommended")) for s in sections) if q]
        selected = {
            str(s.get("id") or s.get("kind")): [str(i) for i in _list(s.get("selected"))]
            for s in sections
            if s.get("kind") != "rows"
        }
        picker.update(questions=questions, answer="submit")
        button = {"label": str((submit or {}).get("label") or MULTI_PICK_SUBMIT)}
        if isinstance((submit or {}).get("optionLabels"), dict):
            button["labels"] = {str(k): str(v) for k, v in submit["optionLabels"].items()}
        picker["submit"] = button
    else:
        multiple = bool(p.get("multiple"))
        needs_button = multiple or bool(submit and submit.get("label"))
        listed = [o for o in options if not (needs_button and o is cancel)]
        question = {
            "id": "q",
            "title": str(p.get("title") or CHOICE_QUESTION),
            "choices": _choices(listed, p.get("recommended")),
        }
        if p.get("detail"):
            question["detail"] = str(p["detail"])
        if multiple:
            question["multiple"] = True
        picker.update(questions=[question], answer="pick")
        if needs_button:
            picker["submit"] = {"label": MULTI_PICK_SUBMIT if multiple else str(submit["label"])}
        selected = {"q": []}
    if cancel is not None and "submit" in picker:
        picker["secondary"] = {"id": "cancel", "label": _close(str(cancel.get("label") or ""))}
    return [_bound(picker)], {**_answer_state(resolution), "selected": selected}


def _plan(p: dict, _resolution):
    rows = [
        {
            "tag": str(row.get("tag") or ""),
            "tone": _TAG_TONES.get(str(row.get("tag") or ""), "accent"),
            "label": str(row.get("label") or ""),
            "note": str(row.get("note") or ""),
        }
        for row in _list(p.get("rows"))
        if isinstance(row, dict)
    ]
    if not rows:
        return None
    plan = {"id": "root", "component": "PushPlan", "title": str(p.get("title") or ""), "rows": rows}
    if p.get("meta"):
        plan["caption"] = str(p["meta"])
    if _list(p.get("keywords")):
        plan["keywords"] = [str(word) for word in p["keywords"]]
    return [plan], {}


def _paper(p: dict, _resolution):
    label = str(p.get("label") or "")
    document = {
        "id": "root",
        "component": "PushDocument",
        "status": "writing",
        "title": label,
        "name": str(p.get("heading") or label),
        "meta": "쓰는 중",
        "lines": [str(line) for line in _list(p.get("lines"))],
    }
    return [document], {}


_TODO_STATES = {"done": "done", "now": "running", "todo": "waiting"}


def _todo(p: dict, _resolution):
    items = [
        {
            "text": str(item.get("text") or "") + (" (새로 추가)" if item.get("added") else ""),
            "state": _TODO_STATES.get(str(item.get("state")), "waiting"),
        }
        for item in _list(p.get("items"))
        if isinstance(item, dict)
    ]
    return [{"id": "root", "component": "PushTodo", "items": Bind("/items")}], {"items": items}


def _diff_card(p: dict, _resolution):
    return [_diff("root", _list(p.get("hunks")), p.get("documentId"))], {}


def _ro(number: str) -> str:
    """으로 after a number read with a final consonant other than ㄹ (영, 삼, 육), else 로."""
    return "으로" if number[-1:] in "036" else "로"


def _fit_sentence(p: dict) -> str:
    score = f"{float(p['score']):.1f}"
    if p.get("note") and p.get("from") is not None:
        start = float(p["from"])
        delta = p.get("delta") or f"+{float(p['score']) - start:.1f}"
        return f"적합도를 {start:.1f} → {score}{_ro(score)} 올렸어요. ({delta})"
    caption = p.get("band") or p.get("topGap")
    return f"적합도는 {score}점이에요." + (f" {caption}" if caption else "")


def _fit(p: dict, _resolution):
    if not isinstance(p.get("score"), (int, float)):
        return None
    fit: dict = {
        "id": "root",
        "component": "PushFit",
        "score": f"{float(p['score']):.1f}",
        "sentence": _fit_sentence(p),
    }
    if p.get("summary"):
        fit["summary"] = str(p["summary"])
    parts = p.get("parts") if isinstance(p.get("parts"), dict) else {}
    if p.get("plan") == "FREE":
        fit["locked"] = True
    elif parts:
        fit["items"] = [
            {"label": label, "score": float(parts[key])}
            for key, label in _FIT_PARTS
            if key in parts
        ]
    missing = [
        str(k.get("label"))
        for k in _list(p.get("keywords"))
        if isinstance(k, dict) and not k.get("ok")
    ]
    if missing:
        fit["missing"] = missing
    rounds = [
        f"{r.get('label')}: {' · '.join(str(r.get('line') or '').split(' · ')[1:])}"
        for r in _list(p.get("rounds"))
        if isinstance(r, dict)
    ]
    if rounds:
        fit["rounds"] = rounds
    return [fit], {}


def _save_failed(p: dict) -> bool:
    """An external file with no savedLine was not saved to 내 서류."""
    return p.get("source") == "external" and not p.get("savedLine")


def _result(p: dict, _resolution):
    external = p.get("source") == "external"
    failed = _save_failed(p)
    document = {
        "id": "document",
        "component": "PushDocument",
        "status": "failed" if failed else "done",
        "title": SAVE_FAIL_TEXT
        if failed
        else ("이력서를 저장했어요" if external else "Push 프로필에 저장했어요"),
        "name": str((p.get("fileName") if external else p.get("title")) or ""),
        "meta": str(
            ((p.get("pageLine") or p.get("cardMeta")) if external else p.get("subtitle")) or ""
        ),
    }
    if p.get("documentId") and not failed:
        document["documentId"] = str(p["documentId"])
        document["share"] = external
    if failed:
        document["actions"] = [dict(SAVE_RETRY)]
    else:
        document["actions"] = [
            {key: str(action[key]) for key in ("id", "label", "method", "path") if action.get(key)}
            for action in _list(p.get("actions"))
            if isinstance(action, dict) and action.get("id")
        ]
    parts = []
    if p.get("summary"):
        parts.append(_text("summary", str(p["summary"])))
    parts += [
        _text(f"bullet{index}", f"• {line}") for index, line in enumerate(_list(p.get("bullets")))
    ]
    parts.append(document)
    return [_column(parts), *parts], {}


_BUILDERS = {
    "approval": _approval,
    "choice": _choice,
    "plan": _plan,
    "paper": _paper,
    "todo": _todo,
    "diff": _diff_card,
    "fit": _fit,
    "result": _result,
}


def auto_pick_line(event: dict) -> str | None:
    """The Bot line for a gate the server answered itself: the recommended option, or for a
    submit gate the selected ids of its sections. The present gate says nothing (nothing picked)."""
    if event.get("gate") == "present":
        return None
    options = [option for option in _list(event.get("options")) if isinstance(option, dict)]
    recommended = next(
        (o.get("label") for o in options if o.get("id") == event.get("recommended")), None
    )
    sections = [section for section in _list(event.get("sections")) if isinstance(section, dict)]
    submit = event.get("submit") if isinstance(event.get("submit"), dict) else None
    picked = recommended
    if sections and submit:
        ids = {str(i) for section in sections for i in _list(section.get("selected"))}
        labels = [
            str(o.get("label"))
            for section in sections
            for o in _list(section.get("options"))
            if isinstance(o, dict) and o.get("id") in ids
        ]
        picked = ", ".join(labels) if labels else (submit.get("zeroLabel") or recommended)
    return f"자동으로 골랐어요: {picked}" if picked else None
