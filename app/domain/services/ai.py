from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4

from app.db import DB, NotFoundError
from app.domain import entities as ent
from app.domain.errors import (
    DomainError, feature_disabled, integration_required, internal, not_configured,
    not_found, provider_error, validation_field,
)
from app.domain.validators import code_point_len
from app.infrastructure.store_ai import AiKeyStore, AiUsageStore
from app.infrastructure.store_auth import UserStore
from app.infrastructure.store_applications import ApplicationStore
from app.infrastructure.store_operations import OperationStore


_SEARCH_MODEL = "deepseek/deepseek-v4.1-flash"
_GO_PREFIX = "opencode-go/"


def _byok_key_var():
    from app.graph.chat import byok_key_var
    return byok_key_var


def _now() -> datetime:
    return datetime.now(timezone.utc)


def validate_ai_options(ai: Optional[ent.AiOptions]) -> None:
    if ai is None:
        return
    if not ent.valid_ai_provider(ai.provider):
        raise validation_field("ai.provider", "unsupported provider")
    if not ai.model:
        raise validation_field("ai.model", "model is required")
    if not ent.valid_credential_mode(ai.credential_mode):
        raise validation_field("ai.credentialMode", "unsupported credentialMode")
    if ai.credential_mode == "MANAGED" and ai.provider != "OPENAI":
        raise validation_field("ai.credentialMode", "MANAGED is only supported for OPENAI")
    if not ent.valid_effort(ai.effort):
        raise validation_field("ai.effort", "unsupported effort")


_BYOK_PROVIDERS = {"OPENAI", "OPENROUTER", "GROK", "CLAUDE"}


class AIGate:
    def __init__(self, db: DB, managed_key: str, cipher, chat, byok_chat=None,
                 go_chat=None, go_key: str = "", openrouter_chat=None,
                 grok_chat=None, claude_chat=None):
        self.keys = AiKeyStore(db)
        self.users = UserStore(db)
        self.usage = AiUsageStore(db)
        self.managed_key = managed_key
        self.cipher = cipher
        self.chat = chat
        self.byok_chat = byok_chat if byok_chat is not None else chat
        self.go_chat = go_chat
        self.go_key = go_key
        self.byok_chats = {
            "OPENAI": self.byok_chat,
            "OPENROUTER": (openrouter_chat if openrouter_chat is not None
                           else self.byok_chat),
            "GROK": grok_chat if grok_chat is not None else self.byok_chat,
            "CLAUDE": claude_chat if claude_chat is not None else self.byok_chat,
        }
        self.byok_enabled = cipher is not None

    async def company_research(self, company: str) -> str:
        if not self.managed_key or self.chat is None:
            return ""
        try:
            c = await self.chat.chat(
                self.managed_key, _SEARCH_MODEL + ":online",
                "채용 지원을 돕기 위해 회사 정보를 조사해줘. "
                "회사의 서비스/제품, 기술 스택, 진행 중인 다른 채용 공고, "
                "최근 소식(투자/수상/출시), 조직 문화를 한국어로 간결히 정리해줘. "
                "확인 가능한 출처 URL을 붙여줘.",
                company)
            return c.text
        except Exception:
            return ""

    async def check(self, user_id: UUID, ai: Optional[ent.AiOptions],
                    byok_key: str = "") -> None:
        if ai is None:
            return
        validate_ai_options(ai)
        if ai.ultra_resume or ai.credential_mode == "MANAGED":
            try:
                u = await self.users.get(user_id)
            except NotFoundError:
                raise not_found()
            if ai.ultra_resume and u.plan != ent.PLAN_ULTRA:
                raise feature_disabled("ultraResume requires the ULTRA plan")
        if ai.credential_mode == "MANAGED":
            now = _now()
            month_start = now.replace(day=1, hour=0, minute=0, second=0,
                                      microsecond=0)
            spent = await self.usage.sum_cost_since(user_id, month_start)
            if spent >= ent.PLAN_CREDITS_MICRO.get(u.plan, 0):
                raise feature_disabled(
                    "monthly managed AI usage limit reached for plan " + u.plan)
            if ai.model.startswith(_GO_PREFIX):
                if not self.go_key or self.go_chat is None:
                    raise not_configured("OpenCode Go is not configured")
            elif not self.managed_key:
                raise not_configured("managed AI is not configured")
            return
        byok_key = byok_key or _byok_key_var().get()
        if byok_key:
            return
        if not self.byok_enabled or not await self.keys.has(user_id, ai.provider):
            raise integration_required("no BYOK key configured for " + ai.provider)

    async def resolve_key(self, user_id: UUID, ai: ent.AiOptions,
                          byok_key: str = "") -> str:
        if ai.credential_mode == "MANAGED":
            return self.managed_key
        byok_key = byok_key or _byok_key_var().get()
        if byok_key:
            return byok_key
        try:
            k = await self.keys.get(user_id, ai.provider)
        except NotFoundError:
            raise integration_required("no BYOK key configured for " + ai.provider)
        if self.cipher is None:
            raise not_configured("BYOK encryption is not configured")
        try:
            return self.cipher.decrypt(k.ciphertext, k.nonce, user_id, ai.provider)
        except Exception:
            raise integration_required("BYOK key could not be decrypted")

    async def _search_context(self, ai: ent.AiOptions, user: str) -> str:
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
        return "\n\n[웹 검색 결과]\n" + c.text

    async def _route(self, user_id: UUID, ai: ent.AiOptions,
                     byok_key: str = ""):
        model = ai.model
        if ai.credential_mode == "MANAGED" and model.startswith(_GO_PREFIX):
            return (self.go_chat, self.go_key, model[len(_GO_PREFIX):],
                    {"x-opencode-session": str(user_id)})
        key = await self.resolve_key(user_id, ai, byok_key)
        if ai.credential_mode == "MANAGED":
            chat = self.chat
        else:
            chat = self.byok_chats.get(ai.provider) or self.byok_chat
        if ai.web_search and ai.credential_mode == "MANAGED":
            model += ":online"
        return chat, key, model, None

    async def list_byok_models(self, provider: str,
                               byok_key: str) -> list[str]:
        if provider not in _BYOK_PROVIDERS:
            raise validation_field("provider", "unsupported provider")
        chat = self.byok_chats.get(provider) or self.byok_chat
        if chat is None or not hasattr(chat, "list_models"):
            raise not_configured(
                "AI provider " + provider + " is not supported")
        try:
            return await chat.list_models(byok_key)
        except DomainError:
            raise
        except Exception:
            raise provider_error("model list failed")

    async def complete(self, user_id: UUID, ai: ent.AiOptions,
                       system: str, user: str,
                       byok_key: str = "",
                       search_query: str = "") -> ent.AICompletion:
        await self.check(user_id, ai, byok_key)
        providers = ({"OPENAI"} if ai.credential_mode == "MANAGED"
                     else _BYOK_PROVIDERS)
        if ai.provider not in providers or self.chat is None:
            raise not_configured("AI provider " + ai.provider + " is not supported")
        system += await self._search_context(ai, search_query or user)
        chat, key, model, headers = await self._route(user_id, ai, byok_key)
        reasoning = ai.effort.lower() if ai.credential_mode == "MANAGED" else ""
        try:
            return await chat.chat(key, model, system, user, reasoning,
                                   headers)
        except Exception:
            raise provider_error("AI provider request failed")

    async def stream(self, user_id: UUID, ai: ent.AiOptions,
                     system: str, user: str, usage: dict,
                     byok_key: str = "", search_query: str = ""):
        await self.check(user_id, ai, byok_key)
        providers = ({"OPENAI"} if ai.credential_mode == "MANAGED"
                     else _BYOK_PROVIDERS)
        if ai.provider not in providers or self.chat is None:
            raise not_configured("AI provider " + ai.provider + " is not supported")
        system += await self._search_context(ai, search_query or user)
        chat, key, model, headers = await self._route(user_id, ai, byok_key)
        reasoning = ai.effort.lower() if ai.credential_mode == "MANAGED" else ""
        try:
            chat_stream = getattr(chat, "chat_stream", None)
            if chat_stream is None:
                c = await chat.chat(key, model, system, user, reasoning,
                                    headers)
                usage["input_tokens"] = c.input_tokens
                usage["output_tokens"] = c.output_tokens
                yield c.text
                return
            async for tok in chat_stream(key, model, system, user, usage,
                                         reasoning, headers):
                yield tok
        except DomainError:
            raise
        except Exception:
            raise provider_error("AI provider request failed")


async def record_usage(usage: AiUsageStore, user_id: UUID, op_id: UUID,
                       ai: ent.AiOptions, c: ent.AICompletion) -> None:
    await usage.create(ent.AiUsage(
        id=uuid4(), user_id=user_id, operation_id=op_id, provider=ai.provider,
        model=ai.model, managed=ai.credential_mode == "MANAGED",
        input_tokens=c.input_tokens, output_tokens=c.output_tokens,
        cost_micro_credits=ent.ai_cost_micro_credits(
            ai.provider, ai.model, c.input_tokens, c.output_tokens),
        status=ent.USAGE_SETTLED, created_at=_now()))


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
            await record_usage(self.usage, user_id, op_id, ai, c)

        await self.db.run(work)
        return op

    async def list_usage(self, user_id: UUID, from_, to, page):
        try:
            return await self.usage.list(user_id, from_, to, page)
        except Exception:
            raise internal()

