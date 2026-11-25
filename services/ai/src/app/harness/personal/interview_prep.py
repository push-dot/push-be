"""Interview prep the k-style way. Code loads the requirements, the evidence and the company sources; two
light readers start together and keep only quotes found in what they read; the main model writes the
questions and STAR answers from that ledger alone; numbers and facts are checked, fixed once, and any
STAR field still not grounded stays in needsInput. The result keeps the rule-based shape."""
from __future__ import annotations

from app.domain.content import code_point_slice
from app.domain.validators import code_point_len
from app.harness.kstyle.ledger import add_evidence, empty_notes, ledger_text, verified
from app.harness.kstyle.stage import Task, run_stage
from app.harness.kstyle.subagent import Corpus, light_model, line, single_call, squash
from app.harness.kstyle.verify import fact_check, finding, fix_once, unsupported_numbers
from app.harness.tools import emit

_TEXT_LIMIT = 6000
_SOURCES_LIMIT = 20_000
_CLAIM_LIMIT = 200
_PER_SOURCE = 3
_STAR = ("situation", "task", "action", "result")

EVIDENCE_SYSTEM = """너는 면접 근거를 읽는 하위 에이전트다(evidence_reader).
brief.requirements(공고 요구사항)마다 brief.evidence에서 그것을 뒷받침하는 근거를 찾는다.
JSON 하나로 답한다: {"findings": [{"evidenceId": 근거 id 그대로, "quote": 그 근거 text에서 그대로 옮긴 한 줄,
"claim": 그 줄이 보여 주는 사실 한 문장(한국어)}]}. quote는 고치거나 줄이지 않는다. 근거에 없는 것은 쓰지 않는다."""

COMPANY_SYSTEM = """너는 회사 자료를 읽는 하위 에이전트다(company_reader).
brief.sources는 사용자가 준 회사 자료다. 면접에 도움이 될 사실을 자료마다 세 개까지 고른다.
JSON 하나로 답한다: {"findings": [{"sourceId": 자료 id 그대로, "quote": 그 자료 text에서 그대로 옮긴 한 줄,
"claim": 그 줄이 보여 주는 사실 한 문장(한국어)}]}. quote는 고치거나 줄이지 않는다. 자료에 없는 것은 쓰지 않는다."""

WRITER_SYSTEM = """너는 면접 준비 자료를 쓰는 작성자다(interview_writer). 모든 문장은 한국어로 쓴다.
brief.requirements마다 면접 질문을 하나 쓰고, brief.evidence의 근거마다 STAR 답변(situation·task·action·result)을 쓴다.
사실은 brief.ledger에 있는 것만 쓴다. 각 줄 앞의 E 번호가 그 근거의 id다. 쓴 칸마다 쓴 근거의 E 번호를 evidence에 단다.
ledger로 채울 수 없는 STAR 칸은 text를 빈 문자열로 둔다. 숫자·기간·성과를 지어내지 않는다.
brief.fix가 있으면 그 지적을 고쳐서 다시 쓴다.
JSON 하나로 답한다: {"questions": [{"requirement": 요구사항 그대로, "question": 질문, "evidence": ["E1"]}],
"starAnswers": [{"evidenceId": 근거 id 그대로, "situation": {"text": "", "evidence": []}, "task": {"text": "", "evidence": []},
"action": {"text": "", "evidence": []}, "result": {"text": "", "evidence": []}}]}"""


def _question(requirement: str) -> str:
    return f"{requirement} 관련 경험을 구체적으로 말씀해 주세요."


def _cap(text: str) -> str:
    return code_point_slice(text, 0, _CLAIM_LIMIT) if code_point_len(text) > _CLAIM_LIMIT else text


async def _read(model, name: str, summary: str, system: str, brief: dict) -> dict:
    emit(line(name, "run", summary, ""))
    try:
        out = await single_call(model, system, brief)
    except BaseException:
        emit(line(name, "err", summary, "", "읽지 못했어요"))
        raise
    emit(line(name, "ok", summary, "", f"찾은 것 {len(out.get('findings') or [])}개"))
    return out


def _findings(out: dict) -> list[dict]:
    found = out.get("findings")
    return [item for item in found if isinstance(item, dict)] if isinstance(found, list) else []


def _field(value) -> tuple[str, list[str]]:
    if isinstance(value, dict):
        cited = value.get("evidence")
        return str(value.get("text") or "").strip(), [str(c) for c in cited] if isinstance(cited, list) else []
    return str(value or "").strip(), []


async def prepare(model, requirements: list[str], evidence: list, sources: list, base: dict) -> dict:
    """`evidence` is the interview's evidence rows in its order, `sources` its company sources, `base` the
    rule-based result. Returns the same keys: questions, starAnswers, research."""
    light = light_model(model) or model
    allowed = [str(e.id) for e in evidence]
    corpus = Corpus({str(e.id): f"{e.title}\n{e.source_text}" for e in evidence}
                    | {f"C{i}": s.source_text for i, s in enumerate(sources, 1)})

    tasks = []
    if requirements and evidence:
        brief = {"requirements": list(requirements), "evidence": [
            {"id": str(e.id), "title": e.title, "text": e.source_text[:_TEXT_LIMIT]} for e in evidence]}
        tasks.append(Task("evidence_reader", lambda: _read(
            light, "evidence_reader", "경력 근거를 읽어요", EVIDENCE_SYSTEM, brief)))
    if sources:
        company = {"sources": [{"id": f"C{i}", "url": s.source_url, "text": s.source_text[:_TEXT_LIMIT]}
                              for i, s in enumerate(sources, 1)]}
        tasks.append(Task("company_reader", lambda: _read(
            light, "company_reader", "회사 자료를 읽어요", COMPANY_SYSTEM, company)))
    stage = await run_stage(tasks)

    notes = empty_notes()
    for item in _findings(stage["out"].get("evidence_reader", {})):
        eid, quote = str(item.get("evidenceId") or ""), str(item.get("quote") or "")
        if eid in allowed and corpus.verified(eid, quote):
            add_evidence(notes, "evidence", eid, quote, str(item.get("claim") or ""), text=corpus.texts[eid])
    for item in _findings(stage["out"].get("company_reader", {})):
        sid, quote = str(item.get("sourceId") or ""), str(item.get("quote") or "")
        if sid.startswith("C") and corpus.verified(sid, quote):
            add_evidence(notes, "company", sid, quote, str(item.get("claim") or ""), text=corpus.texts[sid])
    ledger = verified(notes)

    def ids(cited) -> list[str]:
        """Ledger ids become the evidence row they quote; any id outside the interview's own is dropped."""
        out: list[str] = []
        for raw in cited if isinstance(cited, list) else []:
            hit = ledger.get(str(raw).strip())
            eid = hit["source"] if hit is not None and hit["kind"] == "evidence" else str(raw).strip()
            if eid in allowed and eid not in out:
                out.append(eid)
        return out

    def answers(draft: dict) -> dict[str, dict]:
        found: dict[str, dict] = {}
        for item in draft.get("starAnswers") or []:
            if isinstance(item, dict) and str(item.get("evidenceId")) in allowed:
                found.setdefault(str(item.get("evidenceId")), item)
        return found

    def fields(draft: dict):
        for eid, item in answers(draft).items():
            for name in _STAR:
                text, cited = _field(item.get(name))
                if text:
                    yield eid, name, text, cited

    sources_text = "\n\n".join(corpus.texts.values())[:_SOURCES_LIMIT]

    async def check(draft: dict) -> list[dict]:
        found = [finding("P0", "number", f"{name}: 근거에 없는 숫자 {', '.join(extra)}")
                 for eid, name, text, _ in fields(draft)
                 if (extra := unsupported_numbers(text, corpus.texts[eid]))]
        texts = "\n".join(text for _, _, text, _ in fields(draft))
        try:
            mismatches = await fact_check(light, texts, sources_text, emit, noun="면접 답변")
        except Exception:
            # An unchecked draft still passes the number check and the ledger citation below.
            return found
        for item in mismatches:
            found.append({**finding("P0", "fact", f'{item["sentence"]} — {item["problem"]}'),
                          "sentence": item["sentence"]})
        return found

    brief = {"requirements": list(requirements),
             "evidence": [{"id": str(e.id), "title": e.title} for e in evidence],
             "ledger": ledger_text(notes)}

    async def redo(found: list[dict]) -> dict:
        try:
            fix = [item["detail"] for item in found]
            return await single_call(model, WRITER_SYSTEM, {**brief, "fix": fix})
        except Exception:
            return {}

    draft = await single_call(model, WRITER_SYSTEM, brief)
    draft, left = await fix_once(draft, check, redo,
                                 lambda out: bool(out.get("questions") or out.get("starAnswers")))
    flagged = [squash(item["sentence"]) for item in left if item.get("sentence")]

    def grounded(eid: str, text: str, cited: list[str]) -> bool:
        quoted = any(c in ledger and ledger[c]["kind"] == "evidence" and ledger[c]["source"] == eid for c in cited)
        return (bool(text) and quoted and not unsupported_numbers(text, corpus.texts[eid])
                and not any(sentence in squash(text) for sentence in flagged))

    written = {str(item.get("requirement") or "").strip(): item
               for item in draft.get("questions") or [] if isinstance(item, dict)}
    questions = []
    for requirement in requirements:
        item = written.get(requirement.strip(), {})
        questions.append({"question": str(item.get("question") or "").strip() or _question(requirement),
                          "requirement": requirement, "evidenceIds": ids(item.get("evidence"))})

    by_id = answers(draft)
    star_answers = []
    for row in evidence:
        eid = str(row.id)
        answer = {"evidenceIds": [eid], "situation": row.title, "task": "", "action": "", "result": "",
                  "needsInput": []}
        for name in _STAR:
            text, cited = _field(by_id.get(eid, {}).get(name))
            if grounded(eid, text, cited):
                answer[name] = text
            elif name != "situation":
                answer["needsInput"].append(name)
        star_answers.append(answer)

    research = []
    for index, item in enumerate(base["research"], 1):
        # The verified quote, not the reader's paraphrase: research is marked as the user's own.
        quotes = [hit["quote"] for hit in ledger.values()
                  if hit["source"] == f"C{index}" and hit["quote"]]
        research += [{**item, "claim": _cap(quote)} for quote in quotes[:_PER_SOURCE]] or [item]
    return {"questions": questions, "starAnswers": star_answers, "research": research}
