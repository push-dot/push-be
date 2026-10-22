from __future__ import annotations

import os

from langchain_core.messages import AIMessage, HumanMessage

from app.domain.access_mode import resolve_access_mode
from app.harness.core_client import CoreClient
from app.harness.graph import build_harness_graph
from app.harness.personal.tools import bound_services
from app.harness.router import select_harness

# shortcut: empty reply until a chat key is set, then use chat_model
class _SilentModel:
    def bind_tools(self, tools, **kwargs):
        return self

    async def ainvoke(self, messages, **kwargs):
        return AIMessage(content="")


_MODEL = _SilentModel()


def _core() -> CoreClient:
    return CoreClient(
        os.environ.get("CORE_ORIGIN", ""),
        os.environ.get("INTERNAL_API_SECRET", ""),
    )


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
    }


class HarnessRuntime:
    def __init__(self, svc):
        self.svc = svc
        self._core = _core()
        self._compiled: dict = {}

    def _graph(self, spec):
        cached = self._compiled.get(spec.id)
        if cached is not None and cached[0] is spec:
            return cached[1]
        graph = build_harness_graph(
            spec,
            self.svc._checkpointer,
            model=_MODEL,
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
        spec = select_harness(conversation)
        if spec.id == "employer" and payload.get("intent"):
            await self._guard(conversation, payload.get("intent"))
        return conversation, self._graph(spec)

    async def astream(self, payload, config=None, stream_mode=None, **kwargs):
        conversation, graph = await self._open(payload)
        token = bound_services.set(self.svc)
        try:
            async for mode, chunk in graph.astream(
                _state(payload, conversation),
                config,
                stream_mode=stream_mode or ["custom", "values"],
            ):
                yield mode, chunk
                if mode == "values" and isinstance(chunk, dict) and chunk.get("__interrupt__"):
                    yield "custom", {"type": "done", "awaiting": "approval"}
        finally:
            bound_services.reset(token)

    async def _guard(self, conversation: dict, intent: str) -> None:
        from app.harness.employer.guard import guard_employer_intent
        plan = None
        company_id = conversation.get("company_id")
        if company_id is not None:
            try:
                plan = await self.svc.conversations.company_plan(company_id)
            except Exception:
                plan = None
        guard_employer_intent(plan, intent)

    async def ainvoke(self, payload, config=None, **kwargs):
        conversation, graph = await self._open(payload)
        token = bound_services.set(self.svc)
        try:
            return await graph.ainvoke(_state(payload, conversation), config)
        finally:
            bound_services.reset(token)
