from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from uuid import UUID

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command

from app.domain import entities as ent
from app.domain.access_mode import resolve_access_mode
from app.framework.models import _content
from app.graphs.chat import byok_key_var
from app.harness.core_client import CoreClient, idempotency_key
from app.harness.graph import _open_calls, build_harness_graph, turn_model
from app.harness.model import GateModel, StubModel, settle_turn
from app.harness.personal.tools import bound_services
from app.harness.registry import REGISTRY
from app.harness.router import select_harness
from app.jsonutil import to_jsonable


def _core() -> CoreClient:
    return CoreClient(
        os.environ.get("CORE_ORIGIN", ""),
        os.environ.get("INTERNAL_API_SECRET", ""),
    )


def _resume_state(payload: dict, conversation: dict) -> dict:
    saved = conversation.get("resume_state") or {}
    if isinstance(saved, str):
        try:
            saved = json.loads(saved)
        except json.JSONDecodeError:
            saved = {}
    if not isinstance(saved, dict):
        saved = {}
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


def _state(payload: dict, conversation: dict) -> dict:
    text = payload.get("text") or ""
    mode = resolve_access_mode(payload.get("access_mode"), None)
    company_id = conversation.get("company_id")
    return {
        "messages": [HumanMessage(content=text)] if text else [],
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


def _thread(config, conversation_id, suffix: str) -> dict:
    config = dict(config or {})
    configurable = dict(config.get("configurable") or {})
    configurable["thread_id"] = str(conversation_id) + suffix
    config["configurable"] = configurable
    return config


def _pending(snapshot) -> dict | None:
    for task in getattr(snapshot, "tasks", ()) or ():
        for item in getattr(task, "interrupts", ()) or ():
            if isinstance(item.value, dict):
                return item.value
    return None


def _rejections(values: dict) -> list:
    rejected = json.dumps({"rejected": True})
    return [ToolMessage(content=rejected, tool_call_id=call["id"]) for call in _open_calls(values)]


def _final_text(values: dict) -> str:
    for message in reversed(values.get("messages") or []):
        if isinstance(message, AIMessage):
            return _content(message)
    return ""


class HarnessRuntime:
    def __init__(self, svc, model_cls=None):
        self.svc = svc
        self._core = _core()
        self._compiled: dict = {}
        self._model_cls = model_cls

    def _graph(self, spec):
        cached = self._compiled.get(spec.id)
        if cached is not None and cached[0] is spec:
            return cached[1]
        if spec.id == "resume":
            from app.harness.resume.graph import build_resume_graph
            graph = build_resume_graph(self.svc._checkpointer, db=self.svc.db)
        else:
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
                "SELECT company_id, resume_state FROM conversations WHERE id = $1",
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
        return found

    async def _open(self, payload):
        conversation = await self._conversation(payload)
        resume = payload.get("resume") or {}
        if resume.get("approvalId"):
            row = await self.svc.db.q().fetchrow(
                "SELECT kind FROM approvals WHERE id = $1", UUID(str(resume["approvalId"])))
            gate = row is not None and row["kind"] == "RESUME_GATE"
            spec = REGISTRY["resume"] if gate else select_harness({**conversation, "resume_state": None})
        elif resume:
            spec = REGISTRY["resume"]
        else:
            spec = select_harness(conversation)
        plan = None
        if spec.id == "employer":
            plan = await self._company_plan(conversation)
            if payload.get("intent"):
                from app.harness.employer.guard import guard_employer_intent
                guard_employer_intent(plan, payload.get("intent"))
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
            return ent.AiOptions(**raw) if raw else None
        from app.config import load_config
        from app.domain.employer_chat import apply_employer_turn
        gate = getattr(self.svc, "ai", None)
        cfg = gate._levers_config() if gate is not None and hasattr(gate, "_levers_config") else load_config()
        base = ent.AiOptions(**raw) if raw else ent.AiOptions(
            provider="OPENAI", model="managed", credential_mode="MANAGED", effort="LOW")
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
        ]
        if payload.get("resume") and not byok_key_var.get():
            tokens.append((byok_key_var, byok_key_var.set(await self._job_byok(payload))))
        plan_token = bind_employer_plan(plan or "") if spec.id == "employer" else None
        run = self._resume_turn if spec.id == "resume" else self._chat_turn
        ok = False
        try:
            async for item in run(graph, payload, conversation, config, stream_mode, ai, turn):
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

    async def _job_byok(self, payload: dict) -> str:
        row = await self.svc.db.q().fetchrow(
            "SELECT payload FROM chat_jobs WHERE id = $1", UUID(str(payload["job_id"])))
        read = getattr(self.svc, "_byok_from_payload", None)
        if row is None or read is None:
            return ""
        stored = row["payload"]
        return read(payload["user_id"], json.loads(stored) if isinstance(stored, str) else stored)

    async def _chat_turn(self, graph, payload, conversation, config, stream_mode, ai, turn):
        snapshot = await graph.aget_state(config)
        waiting = _pending(snapshot)
        resume = payload.get("resume") or {}
        if resume:
            if waiting is None:
                return
            state = Command(resume={"option_id": resume.get("optionId")})
        else:
            state = _state(payload, conversation)
            if waiting is not None:
                await self._reject_waiting(payload["conversation_id"])
                state["messages"] = [*_rejections(snapshot.values), *state["messages"]]
        interrupted = False
        async for item in self._stream_graph(graph, state, config, stream_mode):
            if item[0] == "custom" and item[1].get("type") == "done":
                interrupted = True
            yield item
        if not interrupted:
            values = (await graph.aget_state(config)).values
            operation = await self._persist(payload, _final_text(values), ai, turn)
            yield "values", {"operation": operation}

    async def _resume_turn(self, graph, payload, conversation, config, stream_mode, ai, turn):
        config = _thread(config, payload["conversation_id"], ":resume")
        pending = _pending(await graph.aget_state(config))
        text = payload.get("text") or ""
        resume = payload.get("resume") or {}
        if resume.get("approvalId"):
            if pending is None:
                return
            state = Command(resume={"option_id": resume.get("optionId")})
        elif pending is not None and text:
            await self._answer_gate(pending.get("approval_id"))
            state = Command(resume={"text": text})
        elif pending is not None:
            return
        else:
            state = _resume_state(payload, conversation)
        async for item in self._stream_graph(graph, state, config, stream_mode):
            yield item
        after = await graph.aget_state(config)
        await self._save_resume_state(payload["conversation_id"], after.values)
        if after.values.get("status") == "active" and _pending(after) is None:
            await self._next_phase(payload, after.values.get("phase"))

    async def _next_phase(self, payload: dict, phase) -> None:
        try:
            await self._core.call(
                "POST",
                f"/api/v1/conversations/{payload['conversation_id']}/resume-jobs",
                user_id=str(payload["user_id"]),
                json={"resume": {"gate": phase, "auto": True}},
                idempotency_key=idempotency_key(str(payload.get("job_id") or ""), "next-phase"),
            )
        except Exception:
            logging.getLogger(__name__).exception("next resume phase enqueue failed")

    async def _reject_waiting(self, conversation_id) -> None:
        await self.svc.db.q().execute(
            "UPDATE approvals SET status = 'REJECTED', updated_at = now(), revision = revision + 1 "
            "WHERE conversation_id = $1 AND status = 'PENDING' AND kind <> 'RESUME_GATE' "
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
