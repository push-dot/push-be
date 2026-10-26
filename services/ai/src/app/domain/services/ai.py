from __future__ import annotations
from app.clock import utcnow
import logging
import os
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4, uuid5

from app.db import DB, NotFoundError
from app.domain import entities as ent
from app.domain.errors import (
    DomainError, feature_disabled, internal, not_configured,
    not_found, provider_error, validation_field,
)
from app.domain.employer_chat import current_employer_plan
from app.domain.plan_levers import levers_for
from app.domain.validators import code_point_len
from app.infrastructure.store_ai import AiUsageStore
from app.infrastructure.store_auth import UserStore
from app.infrastructure.store_applications import ApplicationStore
from app.infrastructure.store_operations import OperationStore


_SEARCH_MODEL = "deepseek/deepseek-v4.1-flash"
_GO_PREFIX = "opencode-go/"
_USAGE_NS = UUID("6ba7b811-9dad-11d1-80b4-00c04fd430c8")


def usage_row_id(job_id, purpose: str) -> UUID:
    """One ai_usage row per chat job and purpose, stable across retries."""
    if not job_id:
        return uuid4()
    return uuid5(_USAGE_NS, f"push:ai-usage:{job_id}:{purpose}")


def _now() -> datetime:
    return utcnow()


def queue_backend() -> str:
    return os.environ.get("QUEUE_BACKEND", "postgres").strip().lower() or "postgres"


def managed_allowance(plan: str | None) -> int:
    return ent.PLAN_CREDITS_MICRO.get(plan or ent.PLAN_FREE, 0)


def validate_ai_options(ai: Optional[ent.AiOptions]) -> None:
    if ai is None:
        return
    if not ent.valid_effort(ai.effort):
        raise validation_field("ai.effort", "unsupported effort")


class AIGate:
    def __init__(self, db: DB, managed_key: str, chat,
                 go_chat=None, go_key: str = "", config=None):
        self.db = db
        self.users = UserStore(db)
        self.usage = AiUsageStore(db)
        self.managed_key = managed_key
        self.chat = chat
        self.go_chat = go_chat
        self.go_key = go_key
        self.config = config

    def _levers_config(self):
        if self.config is not None:
            return self.config
        from app.config import Config
        return Config()

    async def _meter(self, user_id: Optional[UUID], model: str,
                     input_tokens: int, output_tokens: int,
                     job_id=None) -> None:
        if user_id is None:
            return
        from app.claimctx import LostClaim
        try:
            await self.usage.create(ent.AiUsage(
                id=usage_row_id(job_id, "meter:" + model), user_id=user_id,
                provider="OPENAI", model=model, managed=True,
                input_tokens=input_tokens, output_tokens=output_tokens,
                cost_micro_credits=ent.ai_cost_micro_credits(
                    "OPENAI", model, input_tokens, output_tokens),
                status=ent.USAGE_SETTLED, created_at=_now()))
        except LostClaim:
            raise
        except Exception:
            logging.getLogger(__name__).exception(
                "usage metering failed user=%s model=%s", user_id, model)

    async def embed(self, texts: list[str],
                    model: str = "openai/text-embedding-3-small",
                    user_id: Optional[UUID] = None,
                    job_id=None) -> list[list[float]]:
        if not self.managed_key or self.chat is None or not texts:
            return []
        try:
            vecs = await self.chat.embed(self.managed_key, model, texts)
        except Exception:
            return []
        await self._meter(user_id, model, sum(
            code_point_len(t) for t in texts) // 4, 0, job_id)
        return vecs

    async def company_research(self, company: str, model: str = "",
                               context: str = "",
                               user_id: Optional[UUID] = None,
                               job_id=None) -> str:
        if not self.managed_key or self.chat is None:
            return ""
        try:
            c = await self.chat.chat(
                self.managed_key, (model or _SEARCH_MODEL) + ":online",
                "채용 지원을 돕기 위해 이 특정 회사를 조사해줘: " + company + ". "
                "반드시 이 회사의 공식 사이트와 채용 공고를 먼저 찾아 확인하고, "
                "회사의 서비스/제품, 기술 스택, 진행 중인 다른 채용 공고, "
                "최근 소식(투자/수상/출시), 조직 문화를 한국어로 간결히 정리해줘. "
                "확인 가능한 출처 URL을 붙여줘. "
                "조회 결과가 해당 회사와 무관하면 무관하다고만 답해.",
                company + ("\n\n[공고 컨텍스트]\n" + context[:3000]
                           if context else ""))
        except Exception:
            return ""
        await self._meter(user_id, model or _SEARCH_MODEL,
                          c.input_tokens, c.output_tokens, job_id)
        return c.text

    async def check(self, user_id: UUID, ai: Optional[ent.AiOptions]) -> None:
        if ai is None:
            return
        validate_ai_options(ai)
        try:
            u = await self.users.get(user_id)
        except NotFoundError:
            raise not_found()
        # Client-sent provider and model are ignored: the plan picks the managed model.
        bound = current_employer_plan()
        if bound is not None:
            levers = levers_for("EMPLOYER", bound or None, self._levers_config())
        else:
            levers = levers_for("PERSONAL", u.plan, self._levers_config())
        ai.provider = "OPENAI"
        ai.model = levers.model
        ai.effort = levers.effort
        if ai.ultra_resume and u.plan != ent.PLAN_ULTRA:
            raise feature_disabled("ultraResume requires the ULTRA plan")
        now = _now()
        month_start = now.replace(day=1, hour=0, minute=0, second=0,
                                  microsecond=0)
        spent = await self.usage.sum_cost_since(user_id, month_start)
        if spent >= managed_allowance(u.plan):
            raise feature_disabled(
                "monthly managed AI usage limit reached for plan " + (u.plan or ent.PLAN_FREE))
        if ai.model.startswith(_GO_PREFIX):
            if not self.go_key or self.go_chat is None:
                raise not_configured("OpenCode Go is not configured")
        elif not self.managed_key:
            raise not_configured("managed AI is not configured")

    async def _reserve(self, user_id: UUID, ai: ent.AiOptions,
                       system: str, user: str, job_id=None) -> Optional[UUID]:
        if queue_backend() == "redis":
            if not job_id:
                return None
            now = _now()
            est_in = code_point_len(system + user) // 4
            row = ent.AiUsage(
                id=usage_row_id(job_id, "chat"), user_id=user_id,
                provider="OPENAI", model=ai.model,
                managed=True, input_tokens=est_in, output_tokens=2048,
                cost_micro_credits=ent.ai_cost_micro_credits(
                    "OPENAI", ai.model, est_in, 2048),
                status=ent.USAGE_RESERVED, created_at=now)
            await self.usage.create_for_job(row, job_id)
            return row.id
        out = None

        async def work():
            nonlocal out
            await self.usage.lock_user(user_id)
            await self.usage.expire_stale()
            u = await self.users.get(user_id)
            now = _now()
            month_start = now.replace(day=1, hour=0, minute=0, second=0,
                                      microsecond=0)
            spent = await self.usage.sum_cost_since(user_id, month_start)
            if spent >= managed_allowance(u.plan):
                raise feature_disabled(
                    "monthly managed AI usage limit reached for plan " + (u.plan or ent.PLAN_FREE))
            est_in = code_point_len(system + user) // 4
            row = ent.AiUsage(
                id=usage_row_id(job_id, "chat"), user_id=user_id,
                provider="OPENAI", model=ai.model,
                managed=True, input_tokens=est_in, output_tokens=2048,
                cost_micro_credits=ent.ai_cost_micro_credits(
                    "OPENAI", ai.model, est_in, 2048),
                status=ent.USAGE_RESERVED, created_at=now)
            await self.usage.create(row)
            out = row.id

        await self.db.run(work)
        return out

    async def _settle(self, usage_id: Optional[UUID], model: str,
                      input_tokens: int, output_tokens: int) -> None:
        if usage_id is None:
            return
        try:
            await self.usage.settle(
                usage_id, input_tokens, output_tokens,
                ent.ai_cost_micro_credits("OPENAI", model,
                                          input_tokens, output_tokens))
        except Exception:
            logging.getLogger(__name__).exception(
                "usage settle failed id=%s", usage_id)

    async def _release(self, usage_id: Optional[UUID]) -> None:
        if usage_id is None:
            return
        try:
            await self.usage.release(usage_id)
        except Exception:
            logging.getLogger(__name__).exception(
                "usage release failed id=%s", usage_id)

    async def _search_context(self, user_id: UUID, ai: ent.AiOptions,
                              user: str, job_id=None) -> str:
        if not ai.web_search:
            return ""
        if not self.managed_key or self.chat is None:
            raise not_configured("web search is not configured")
        try:
            c = await self.chat.chat(
                self.managed_key, _SEARCH_MODEL + ":online",
                "사용자 질문에 답하는 데 필요한 최신 정보를 검색하고, 핵심 사실과 출처 URL을 간결하게 정리해줘.",
                user)
        except DomainError:
            raise
        except Exception:
            raise provider_error("web search failed")
        await self._meter(user_id, _SEARCH_MODEL,
                          c.input_tokens, c.output_tokens, job_id)
        return "\n\n[웹 검색 결과]\n" + c.text

    async def _route(self, user_id: UUID, ai: ent.AiOptions):
        model = ai.model
        if model.startswith(_GO_PREFIX):
            return (self.go_chat, self.go_key, model[len(_GO_PREFIX):],
                    {"x-opencode-session": str(user_id)})
        if ai.web_search:
            model += ":online"
        return self.chat, self.managed_key, model, None

    async def complete(self, user_id: UUID, ai: ent.AiOptions,
                       system: str, user: str,
                       search_query: str = "",
                       job_id=None) -> ent.AICompletion:
        await self.check(user_id, ai)
        if self.chat is None:
            raise not_configured("AI provider " + ai.provider + " is not supported")
        system += await self._search_context(
            user_id, ai, search_query or user, job_id)
        chat, key, model, headers = await self._route(user_id, ai)
        reasoning = ai.effort.lower()
        usage_id = await self._reserve(user_id, ai, system, user, job_id)
        try:
            from app.framework.models import complete_or_none
            c = await complete_or_none(
                chat, key, model, system, user, reasoning, headers)
            if c is None:
                c = await chat.chat(key, model, system, user, reasoning, headers)
        except Exception:
            await self._release(usage_id)
            raise provider_error("AI provider request failed")
        await self._settle(usage_id, model, c.input_tokens, c.output_tokens)
        return c.model_copy(update={"usage_id": usage_id})

    async def stream(self, user_id: UUID, ai: ent.AiOptions,
                     system: str, user: str, usage: dict,
                     search_query: str = "",
                     assistant_prefix: str = "", job_id=None):
        await self.check(user_id, ai)
        if self.chat is None:
            raise not_configured("AI provider " + ai.provider + " is not supported")
        system += await self._search_context(
            user_id, ai, search_query or user, job_id)
        chat, key, model, headers = await self._route(user_id, ai)
        reasoning = ai.effort.lower()
        usage_id = await self._reserve(user_id, ai, system, user, job_id)
        if usage_id is not None:
            usage.setdefault("usage_ids", []).append(usage_id)
        settled = False
        try:
            from app.framework.models import stream_or_none
            lc = stream_or_none(
                chat, key, model, system, user, usage, reasoning, headers,
                assistant_prefix)
            ran_legacy = True
            if lc is not None:
                produced = False
                try:
                    async for tok in lc:
                        produced = True
                        yield tok
                except ImportError:
                    if produced:
                        raise
                else:
                    ran_legacy = False
            if ran_legacy:
                chat_stream = getattr(chat, "chat_stream", None)
                if chat_stream is None:
                    c = await chat.chat(key, model, system, user, reasoning,
                                        headers)
                    usage["input_tokens"] = c.input_tokens
                    usage["output_tokens"] = c.output_tokens
                    yield c.text
                else:
                    async for tok in chat_stream(
                            key, model, system, user, usage,
                            reasoning, headers, assistant_prefix):
                        yield tok
            await self._settle(usage_id, model,
                               usage.get("input_tokens", 0),
                               usage.get("output_tokens", 0))
            settled = True
        except DomainError:
            raise
        except Exception:
            raise provider_error("AI provider request failed")
        finally:
            if not settled:
                await self._release(usage_id)


async def record_usage(usage: AiUsageStore, user_id: UUID, op_id: UUID,
                       ai: ent.AiOptions, c: ent.AICompletion,
                       usage_ids=(), job_id=None) -> None:
    await usage.attach_operations(op_id, list(usage_ids))


class AIService:
    def __init__(self, db: DB, gate: AIGate):
        self.db = db
        self.gate = gate
        self.ops = OperationStore(db)
        self.usage = AiUsageStore(db)
        self.applications = ApplicationStore(db)

    async def generate(self, user_id: UUID, ai: Optional[ent.AiOptions], prompt: str,
                       application_id: UUID, evidence_ids: list[UUID]) -> ent.Operation:
        if ai is None:
            raise validation_field("ai", "required")
        if not prompt or code_point_len(prompt) > 20000:
            raise validation_field("prompt", "prompt must be 1-20000 characters")
        try:
            await self.applications.get(user_id, application_id)
        except NotFoundError:
            raise not_found()
        except Exception:
            raise internal()
        c = await self.gate.complete(user_id, ai, "", prompt)
        op = None

        async def work():
            nonlocal op
            now = _now()
            op_id = uuid4()
            op = ent.Operation(
                id=op_id, user_id=user_id, type=ent.OP_AI_GENERATE,
                application_id=application_id, status=ent.OP_SUCCEEDED,
                result=ent.OperationResult(kind=ent.OP_AI_GENERATE, value={
                    "text": c.text, "citations": [],
                    "usage": {"inputTokens": c.input_tokens,
                              "outputTokens": c.output_tokens}}),
                created_at=now, updated_at=now)
            await self.ops.create(op)
            await record_usage(self.usage, user_id, op_id, ai, c,
                               [c.usage_id] if c.usage_id else [])

        await self.db.run(work)
        return op

    async def list_usage(self, user_id: UUID, from_, to, page):
        try:
            return await self.usage.list(user_id, from_, to, page)
        except Exception:
            raise internal()

