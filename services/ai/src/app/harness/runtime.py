from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from uuid import UUID

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.errors import GraphRecursionError
from langgraph.types import Command

from app.domain import entities as ent
from app.domain.access_mode import resolve_access_mode
from app.domain.errors import INTERNAL, DomainError
from app.framework.models import _content
from app.graphs.chat import _stable_ids
from app.harness.document_edits import env_core
from app.harness.graph import RECURSION_LIMIT, _open_calls, build_harness_graph, turn_model
from app.harness.model import GateModel, StubModel, settle_turn
from app.harness.personal.tools import bound_services
from app.harness.personal.resume.graph import bound_core, merge_inputs
from app.harness.router import select_harness
from app.ingest.web_page import fetch_page_text, find_urls
from app.jsonutil import to_jsonable


_TEXT_GATES = ("RESUME_GATE", "EMPLOYER_GATE")
_EMPLOYER_INTENTS = ("posting", "review", "interview")


def employer_start(payload: dict, conversation: dict) -> dict | None:
    """A web entry point (intent) starts an employer flow; plain chat goes to the agent."""
    name = str(payload.get("intent") or "")
    if name not in _EMPLOYER_INTENTS:
        return None
    application_id = (payload.get("application_id") or payload.get("applicationId")
                      or conversation.get("application_id"))
    start = {"name": name}
    if name == "posting" and conversation.get("posting_id"):
        start["reference_posting_id"] = conversation["posting_id"]
    if name in ("review", "interview") and application_id:
        start["application_id"] = str(application_id)
    return start


def _saved_resume(raw) -> dict:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return raw if isinstance(raw, dict) else {}


def _resume_state(payload: dict, conversation: dict) -> dict:
    saved = _saved_resume(conversation.get("resume_state"))
    mode = resolve_access_mode(payload.get("access_mode"), None)
    return {
        "status": saved.get("status") or "active",
        "phase": saved.get("phase") or "mode_select",
        "work_mode": saved.get("work_mode"),
        "scenario": saved.get("scenario"),
        "inputs": saved.get("inputs") or {},
        "analysis": saved.get("analysis") or {},
        "strategy": saved.get("strategy") or {},
        "drafts": saved.get("drafts") or {},
        "review": saved.get("review") or {},
        "artifacts": saved.get("artifacts") or {},
        "warnings": saved.get("warnings") or [],
        "access_mode": mode.value,
        "conversation_id": str(payload.get("conversation_id") or ""),
        "user_id": str(payload.get("user_id") or ""),
        "job_id": str(payload.get("job_id") or ""),
    }


def _user_message_id(job_id) -> str | None:
    """The persisted user message id; a retried job replaces its HumanMessage instead of adding one."""
    if not job_id:
        return None
    try:
        return str(_stable_ids(job_id)[0])
    except ValueError:
        return None


def _state(payload: dict, conversation: dict) -> dict:
    text = payload.get("text") or ""
    mode = resolve_access_mode(payload.get("access_mode"), None)
    company_id = conversation.get("company_id")
    message_id = _user_message_id(payload.get("job_id"))
    return {
        "messages": [HumanMessage(content=text, id=message_id)] if text else [],
        "user_id": str(payload.get("user_id") or ""),
        "company_id": None if not company_id else str(company_id),
        "conversation_id": str(payload.get("conversation_id") or ""),
        "job_id": str(payload.get("job_id") or ""),
        "access_mode": mode.value,
        "tool_calls_used": 0,
    }


_RESUME_KEYS = (
    "status", "phase", "work_mode", "scenario", "inputs", "analysis", "strategy",
    "drafts", "review", "artifacts", "warnings",
)


async def _turn_inputs(payload: dict) -> dict:
    urls = find_urls(payload.get("text") or "")[:2]
    bodies = await asyncio.gather(*(fetch_page_text(url) for url in urls), return_exceptions=True)
    pages = {}
    for url, body in zip(urls, bodies):
        if isinstance(body, BaseException):
            logging.getLogger(__name__).warning("page prefetch failed", exc_info=body)
        elif body:
            pages[url] = body
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    return {"pages": pages, "attachments": [str(item) for item in context.get("evidenceIds") or []]}


def _pending(snapshot) -> dict | None:
    for task in getattr(snapshot, "tasks", ()) or ():
        for item in getattr(task, "interrupts", ()) or ():
            if isinstance(item.value, dict):
                return item.value
    return None


def _rejections(values: dict, result: dict | None = None) -> list:
    content = json.dumps(result or {"rejected": True})
    return [ToolMessage(content=content, tool_call_id=call["id"]) for call in _open_calls(values)]


def _final_text(values: dict) -> str:
    for message in reversed(values.get("messages") or []):
        if isinstance(message, AIMessage):
            return _content(message)
    return ""


def _flow_reply(snapshot) -> tuple[str, str]:
    for task in getattr(snapshot, "tasks", ()) or ():
        values = getattr(getattr(task, "state", None), "values", None) or {}
        reply = values.get("reply") or ""
        if isinstance(reply, str) and reply:
            return reply, str(values.get("reply_job") or "")
    return "", ""


class HarnessRuntime:
    def __init__(self, svc, model_cls=None):
        self.svc = svc
        self._core = env_core()
        self._compiled: dict = {}
        self._model_cls = model_cls

    def _graph(self, spec):
        cached = self._compiled.get(spec.id)
        if cached is not None and cached[0] is spec:
            return cached[1]
        graph = build_harness_graph(
            spec,
            self.svc._checkpointer,
            model=None,
            db=self.svc.db,
            core=self._core,
        )
        self._compiled[spec.id] = (spec, graph)
        return graph

    def get_graph(self):
        from app.harness.registry import REGISTRY
        return self._graph(REGISTRY["personal"]).get_graph()

    async def _conversation(self, payload: dict) -> dict:
        context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
        found = {
            "company_id": payload.get("company_id") or context.get("company_id"),
            "resume_state": context.get("resume_state"),
        }
        try:
            row = await self.svc.db.q().fetchrow(
                "SELECT company_id, resume_state, posting_id, application_id "
                "FROM conversations WHERE id = $1",
                payload.get("conversation_id"),
            )
        except Exception:
            row = None
        if not row:
            return found
        if row["company_id"] is not None:
            found["company_id"] = row["company_id"]
        if row["resume_state"] is not None:
            found["resume_state"] = row["resume_state"]
        for key in ("posting_id", "application_id"):
            try:
                if row[key] is not None:
                    found[key] = str(row[key])
            except (KeyError, IndexError):
                continue
        return found

    async def _open(self, payload):
        conversation = await self._conversation(payload)
        spec = select_harness(conversation)
        plan = None
        if spec.id == "employer":
            plan = await self._company_plan(conversation)
        return conversation, spec, self._graph(spec), plan

    async def _company_plan(self, conversation: dict):
        company_id = conversation.get("company_id")
        if company_id is None:
            return None
        try:
            return await self.svc.conversations.company_plan(company_id)
        except Exception:
            return None

    def _ai(self, payload: dict, spec, plan) -> ent.AiOptions | None:
        raw = payload.get("ai")
        if spec.id != "employer":
            from app.domain.managed_ai import with_managed_default
            raw = with_managed_default(raw)
            return ent.AiOptions(**raw) if raw else None
        from app.config import load_config
        from app.domain.employer_chat import apply_employer_turn
        gate = getattr(self.svc, "ai", None)
        cfg = gate._levers_config() if gate is not None and hasattr(gate, "_levers_config") else load_config()
        base = ent.AiOptions(**raw) if raw else ent.AiOptions(
            provider="OPENAI", model="managed", effort="LOW")
        return apply_employer_turn(base, plan, payload.get("intent"), cfg)

    def _model(self, payload: dict, ai, turn: dict):
        gate = getattr(self.svc, "ai", None)
        if ai is None or gate is None:
            return StubModel(payload.get("text") or "")
        return GateModel(gate, payload.get("user_id"), ai, payload.get("job_id"), turn,
                         cls=self._model_cls)

    async def astream(self, payload, config=None, stream_mode=None, **kwargs):
        conversation, spec, graph, plan = await self._open(payload)
        from app.domain.employer_chat import bind_employer_plan, reset_employer_plan
        ai = self._ai(payload, spec, plan)
        turn: dict = {}
        tokens = [
            (bound_services, bound_services.set(self.svc)),
            (turn_model, turn_model.set(self._model(payload, ai, turn))),
            (bound_core, bound_core.set(self._core)),
        ]
        plan_token = bind_employer_plan(plan or "") if spec.id == "employer" else None
        ok = False
        try:
            async for item in self._chat_turn(
                    graph, payload, conversation, config, stream_mode, ai, turn, spec):
                yield item
            ok = True
        finally:
            gate = getattr(self.svc, "ai", None)
            if gate is not None:
                await settle_turn(gate, turn, ok)
            if plan_token is not None:
                reset_employer_plan(plan_token)
            for var, token in reversed(tokens):
                var.reset(token)

    async def _chat_turn(self, graph, payload, conversation, config, stream_mode, ai, turn, spec):
        snapshot = await graph.aget_state(config)
        waiting = _pending(snapshot)
        resume = dict(payload.get("resume") or {})
        text = payload.get("text") or ""
        if await self._stored_gate(resume.get("approvalId")) == "start_document":
            if resume.get("optionId") != "cancel":
                return
            if waiting is None:
                await self.svc.db.q().execute(
                    "UPDATE conversations SET resume_state = $2::jsonb WHERE id = $1",
                    payload["conversation_id"],
                    json.dumps({"status": "cancelled"}, ensure_ascii=False),
                )
                return
            resume["optionId"] = "cancel"
        if resume.get("approvalId"):
            if waiting is None:
                return
            state = Command(resume={"option_id": resume.get("optionId")})
        elif waiting is not None and waiting.get("kind") in _TEXT_GATES and text:
            await self._answer_gate(waiting.get("approval_id"))
            state = Command(resume={"text": text, **await _turn_inputs(payload)})
        elif waiting is not None and waiting.get("kind") in _TEXT_GATES:
            return
        else:
            state = _state(payload, conversation)
            if waiting is not None:
                await self._reject_waiting(payload["conversation_id"])
            # Heal calls a crashed turn left open too, or the provider rejects every later turn.
            crashed = None if waiting is not None else {"error": "TOOL_FAILED"}
            state["messages"] = [*_rejections(snapshot.values, crashed), *state["messages"]]
            if spec.id == "employer":
                start = employer_start(payload, conversation)
                if start is not None:
                    state["start_flow"] = start
            if spec.id == "personal" and _saved_resume((snapshot.values or {}).get("resume")).get("status") != "active":
                if _saved_resume(conversation.get("resume_state")).get("status") == "active":
                    seeded = _resume_state(payload, conversation)
                    seeded["inputs"] = merge_inputs(seeded.get("inputs") or {}, await _turn_inputs(payload))
                    state["resume"] = seeded
        config = {**(config or {}), "recursion_limit": RECURSION_LIMIT}
        interrupted = False
        done = None
        try:
            async for item in self._stream_graph(graph, state, config, stream_mode):
                if item[0] == "custom" and isinstance(item[1], dict) and item[1].get("type") == "done":
                    done = item[1]
                    interrupted = True
                    continue
                yield item
        except GraphRecursionError:
            raise DomainError(500, INTERNAL, "tool loop hit its step limit") from None
        after = await graph.aget_state(config, subgraphs=True)
        stored = _saved_resume((after.values or {}).get("resume"))
        if spec.id == "personal" and stored.get("status"):
            await self._save_resume_state(payload["conversation_id"], stored)
        operation = None
        if interrupted:
            reply, reply_job = _flow_reply(after)
            if reply and reply_job == str(payload.get("job_id") or ""):
                operation = await self._persist(payload, reply, ai, turn)
        else:
            operation = await self._persist(payload, _final_text(after.values), ai, turn)
        if done is not None:
            extra = {"operation": to_jsonable(operation)} if operation is not None else {}
            yield "custom", {**done, **extra}
        elif operation is not None:
            yield "values", {"operation": operation}

    async def _stored_gate(self, approval_id) -> str:
        if not approval_id:
            return ""
        try:
            row = await self.svc.db.q().fetchrow(
                "SELECT tool_args FROM approvals WHERE id = $1", UUID(str(approval_id)))
        except Exception:
            return ""
        if not row:
            return ""
        try:
            raw = row["tool_args"]
        except (KeyError, TypeError):
            return ""
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except json.JSONDecodeError:
                return ""
        if isinstance(raw, dict):
            return str(raw.get("gate") or "")
        return ""

    async def _reject_waiting(self, conversation_id) -> None:
        await self.svc.db.q().execute(
            "UPDATE approvals SET status = 'REJECTED', updated_at = now(), revision = revision + 1 "
            "WHERE conversation_id = $1 AND status = 'PENDING' AND kind NOT IN ('RESUME_GATE', 'EMPLOYER_GATE') "
            "AND (kind = 'TOOL_ACTION' OR job_id IS NOT NULL)",
            conversation_id,
        )

    async def _answer_gate(self, approval_id) -> None:
        if not approval_id:
            return
        await self.svc.db.q().execute(
            "UPDATE approvals SET status = 'APPROVED', decided_at = now(), updated_at = now(), "
            "revision = revision + 1 WHERE id = $1 AND status = 'PENDING'",
            UUID(str(approval_id)),
        )

    async def _save_resume_state(self, conversation_id, values: dict) -> None:
        saved = {key: values.get(key) for key in _RESUME_KEYS if key in values}
        await self.svc.db.q().execute(
            "UPDATE conversations SET resume_state = $2::jsonb WHERE id = $1",
            conversation_id,
            json.dumps(to_jsonable(saved), ensure_ascii=False),
        )

    async def _stream_graph(self, graph, state, config, stream_mode):
        async for mode, chunk in graph.astream(
                state, config, stream_mode=stream_mode or ["custom", "values"]):
            yield mode, chunk
            if mode == "values" and isinstance(chunk, dict) and chunk.get("__interrupt__"):
                value = getattr(chunk["__interrupt__"][0], "value", None) or {}
                yield "custom", {"type": "done", "awaiting": value.get("awaiting") or "approval"}

    async def _persist(self, payload: dict, reply: str, ai, turn: dict) -> ent.Operation:
        from app.domain.services.ai import record_usage
        from app.graphs.chat import _PLACEHOLDER_TITLES, _stable_ids
        svc = self.svc
        user_id = payload["user_id"]
        conversation = await svc.conversations.get(user_id, payload["conversation_id"])
        now = datetime.now(timezone.utc)
        user_msg_id, assistant_msg_id, op_id = _stable_ids(payload.get("job_id"))
        text = payload.get("text") or ""
        user_msg = ent.Message(
            id=user_msg_id, user_id=user_id, conversation_id=conversation.id,
            role="USER", text=text, attachments=[], operation_id=op_id, created_at=now)
        assistant_msg = ent.Message(
            id=assistant_msg_id, user_id=user_id, conversation_id=conversation.id,
            role="ASSISTANT", text=reply, attachments=[], operation_id=op_id, created_at=now)
        value = {"assistantMessage": to_jsonable(assistant_msg), "approvalIds": []}
        if text:
            value["userMessage"] = to_jsonable(user_msg)
        op = ent.Operation(
            id=op_id, user_id=user_id, type=ent.OP_CHAT_MESSAGE,
            application_id=conversation.application_id, status=ent.OP_SUCCEEDED,
            result=ent.OperationResult(kind=ent.OP_CHAT_MESSAGE, value=value),
            created_at=now, updated_at=now)
        completion = ent.AICompletion(
            text=reply, input_tokens=turn.get("input_tokens", 0),
            output_tokens=turn.get("output_tokens", 0))

        async def work():
            if text:
                await svc.conversations.upsert_user_message(user_msg)
            await svc.conversations.create_message(assistant_msg)
            await svc.ops.create(op)
            if ai is not None and turn.get("checked"):
                usage_ids = [turn["usage_id"]] if turn.get("usage_id") else []
                await record_usage(svc.usage, user_id, op_id, ai, completion, usage_ids,
                                   job_id=payload.get("job_id"))
            if text and (conversation.title or "") in _PLACEHOLDER_TITLES:
                fresh = await svc.conversations.get(user_id, conversation.id)
                fresh.title = text[:40]
                await svc.conversations.update(fresh, fresh.revision)

        await svc.db.run(work)
        return op

    async def ainvoke(self, payload, config=None, **kwargs):
        result: dict = {}
        async for mode, chunk in self.astream(payload, config):
            if mode == "values" and isinstance(chunk, dict) and chunk.get("operation") is not None:
                result["operation"] = chunk["operation"]
        return result
