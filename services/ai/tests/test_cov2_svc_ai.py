"""AIGate / AIService behaviour on the managed-AI paths."""
from __future__ import annotations

from uuid import uuid4

import pytest

from app.claimctx import LostClaim
from app.config import Config
from app.domain import entities as ent
from app.domain.employer_chat import bind_employer_plan, reset_employer_plan
from app.domain.errors import DomainError, not_configured
from app.domain.services.ai import AIGate, AIService
from tests.stubs import (FakeDB, StubAiUsageStore, StubApplicationStore,
                         StubChatCompleter, StubOperationStore, StubUserStore)
from tests.test_ai import _now, _user


def _ai(**kw):
    base = dict(provider="OPENAI", model="m", effort="LOW")
    base.update(kw)
    return ent.AiOptions(**base)


def _gate(managed_key="sk-managed", chat=None, user=None, usage=None,
          **kw):
    g = AIGate(FakeDB(), managed_key,
               chat if chat is not None else StubChatCompleter(text="ok"),
               **kw)
    g.users = StubUserStore(user if user is not None else _user("FREE"))
    g.usage = usage if usage is not None else StubAiUsageStore()
    return g


async def _code(aw) -> DomainError:
    with pytest.raises(DomainError) as e:
        await aw
    return e.value


# ---- check / validate_ai_options ------------------------------------------

async def test_check_rejects_invalid_effort_before_any_lookup():
    g = _gate()
    g.users = StubUserStore(None)  # a lookup would fail with NOT_FOUND
    err = await _code(g.check(uuid4(), _ai(effort="EXTREME")))
    assert (err.code, err.details) == ("VALIDATION_ERROR",
                                       {"field": "ai.effort"})


@pytest.mark.parametrize("kw", [
    {"provider": "NOPE"}, {"provider": "CLAUDE"}, {"model": ""},
])
async def test_check_overrides_client_provider_and_model(kw):
    g = _gate(user=_user("PRO"))
    ai = _ai(**kw)
    await g.check(uuid4(), ai)
    assert (ai.provider, ai.model) == ("OPENAI", "anthropic/claude-sonnet-5-5")


async def test_check_without_ai_options_is_a_no_op():
    g = _gate(managed_key="")
    assert await g.check(uuid4(), None) is None


async def test_check_managed_for_unknown_user_is_not_found():
    g = _gate()
    g.users = StubUserStore(None)
    assert (await _code(g.check(uuid4(), _ai()))).code == "NOT_FOUND"


async def test_check_managed_uses_plan_levers_not_client_choice():
    g = _gate(user=_user("PRO"))
    ai = _ai(model="client-picked", effort="MAX")
    await g.check(uuid4(), ai)
    assert (ai.model, ai.effort) == ("anthropic/claude-sonnet-5-5", "MEDIUM")


async def test_check_managed_under_employer_binding_uses_employer_levers():
    g = _gate(user=_user("FREE"))
    ai = _ai()
    token = bind_employer_plan("ULTRA")
    try:
        await g.check(uuid4(), ai)
    finally:
        reset_employer_plan(token)
    assert (ai.model, ai.effort) == ("anthropic/claude-fable-5-1", "MAX")


async def test_check_managed_under_unpaid_employer_binding_uses_base_levers():
    g = _gate(user=_user("ULTRA"))
    ai = _ai()
    token = bind_employer_plan(None)
    try:
        await g.check(uuid4(), ai)
    finally:
        reset_employer_plan(token)
    assert (ai.model, ai.effort) == ("anthropic/claude-sonnet-5-5", "MEDIUM")


async def test_free_plan_allowance_is_per_user():
    a, b = uuid4(), uuid4()
    spent = ent.AiUsage(id=uuid4(), user_id=a, provider="OPENAI", model="m",
                        managed=True, input_tokens=0, output_tokens=0,
                        cost_micro_credits=1_800_000,
                        status=ent.USAGE_SETTLED, created_at=_now())
    g = _gate(usage=StubAiUsageStore([spent]))
    err = await _code(g.check(a, _ai()))
    assert err.code == "FEATURE_DISABLED" and "FREE" in err.message
    await g.check(b, _ai())  # B is not charged for A's spend


# ---- _meter / embed / company_research ------------------------------------

class _Embedder(StubChatCompleter):
    def __init__(self, err=None):
        super().__init__(text="research", in_tokens=7, out_tokens=9)
        self.embed_err = err
        self.embedded = None

    async def embed(self, key, model, texts):
        if self.embed_err is not None:
            raise self.embed_err
        self.embedded = (key, model, list(texts))
        return [[0.1, 0.2] for _ in texts]


async def test_embed_returns_vectors_and_meters_the_user():
    user_id, chat = uuid4(), _Embedder()
    g = _gate(chat=chat)
    vecs = await g.embed(["abcd" * 10, "efgh"], user_id=user_id)
    assert vecs == [[0.1, 0.2], [0.1, 0.2]]
    assert chat.embedded[0] == "sk-managed"
    (row,) = g.usage.items
    assert (row.user_id, row.input_tokens, row.output_tokens) == (user_id, 11, 0)
    assert row.status == ent.USAGE_SETTLED and row.managed


@pytest.mark.parametrize("managed_key,texts,err", [
    ("", ["a"], None),
    ("sk", [], None),
    ("sk", ["a"], RuntimeError("down")),
])
async def test_embed_degrades_to_empty_without_metering(managed_key, texts, err):
    g = _gate(managed_key=managed_key, chat=_Embedder(err))
    assert await g.embed(texts, user_id=uuid4()) == []
    assert g.usage.items == []


async def test_embed_without_user_skips_metering():
    g = _gate(chat=_Embedder())
    assert len(await g.embed(["x"])) == 1
    assert g.usage.items == []


async def test_meter_failure_is_swallowed_but_lost_claim_propagates():
    class Usage(StubAiUsageStore):
        def __init__(self, err):
            super().__init__()
            self.err = err

        async def create(self, u):
            raise self.err

    g = _gate(chat=_Embedder(), usage=Usage(RuntimeError("db")))
    assert len(await g.embed(["x"], user_id=uuid4())) == 1
    g = _gate(chat=_Embedder(), usage=Usage(LostClaim()))
    with pytest.raises(LostClaim):
        await g.embed(["x"], user_id=uuid4())


async def test_company_research_queries_online_model_and_meters():
    user_id, chat = uuid4(), _Embedder()
    g = _gate(chat=chat)
    out = await g.company_research("Acme", context="c" * 5000,
                                   user_id=user_id, job_id="job-1")
    assert out == "research"
    assert chat.got["model"] == "deepseek/deepseek-v4.1-flash:online"
    assert "Acme" in chat.got["system"]
    assert chat.got["user"] == "Acme\n\n[공고 컨텍스트]\n" + "c" * 3000
    (row,) = g.usage.items
    assert (row.model, row.input_tokens, row.output_tokens) == (
        "deepseek/deepseek-v4.1-flash", 7, 9)


async def test_company_research_custom_model_and_no_context():
    chat = _Embedder()
    await _gate(chat=chat).company_research("Acme", model="x/y")
    assert chat.got["model"] == "x/y:online" and chat.got["user"] == "Acme"


@pytest.mark.parametrize("managed_key,chat", [
    ("", _Embedder()),
    ("sk", None),
    ("sk", StubChatCompleter(err=RuntimeError("timeout"))),
])
async def test_company_research_degrades_to_empty(managed_key, chat):
    g = AIGate(FakeDB(), managed_key, chat)
    g.usage = StubAiUsageStore()
    assert await g.company_research("Acme", user_id=uuid4()) == ""
    assert g.usage.items == []


# ---- complete: reservation / web search -----------------------------------

class _RacingUsage(StubAiUsageStore):
    """Spend reaches the cap between the check and the locked reservation."""

    def __init__(self):
        super().__init__()
        self.reads = 0

    async def sum_cost_since(self, user_id, since):
        self.reads += 1
        return 0 if self.reads == 1 else 10**12


async def test_reserve_rechecks_allowance_under_the_user_lock():
    chat = StubChatCompleter(text="never")
    g = _gate(chat=chat, usage=_RacingUsage())
    err = await _code(g.complete(uuid4(), _ai(), "", "hi"))
    assert err.code == "FEATURE_DISABLED"
    assert chat.got == {} and g.usage.items == []


async def test_redis_backend_without_job_reserves_nothing(monkeypatch):
    monkeypatch.setenv("QUEUE_BACKEND", "redis")
    g = _gate()
    c = await g.complete(uuid4(), _ai(), "", "hi")
    assert c.usage_id is None and g.usage.items == []


async def test_redis_backend_reserves_once_per_job(monkeypatch):
    monkeypatch.setenv("QUEUE_BACKEND", "redis")

    class Usage(StubAiUsageStore):
        async def create_for_job(self, row, job_id):
            self.job = job_id
            await self.create(row)

    g = _gate(usage=Usage())
    first = await g.complete(uuid4(), _ai(), "", "hi", job_id="job-1")
    again = await g.complete(uuid4(), _ai(), "", "hi", job_id="job-1")
    assert first.usage_id == again.usage_id and g.usage.job == "job-1"
    assert g.usage.items[0].status == ent.USAGE_SETTLED


async def test_settle_failure_does_not_fail_the_completion():
    class Usage(StubAiUsageStore):
        async def settle(self, *a):
            raise RuntimeError("db")

    g = _gate(usage=Usage())
    c = await g.complete(uuid4(), _ai(), "", "hi")
    assert c.text == "ok" and c.usage_id == g.usage.items[0].id
    assert g.usage.items[0].status == ent.USAGE_RESERVED


async def test_provider_failure_releases_reservation_even_if_release_fails():
    class Usage(StubAiUsageStore):
        async def release(self, id_):
            raise RuntimeError("db")

    g = _gate(chat=StubChatCompleter(err=RuntimeError("x")), usage=Usage())
    assert (await _code(g.complete(uuid4(), _ai(), "", "hi"))).code == \
        "PROVIDER_ERROR"


async def test_web_search_needs_managed_router_key():
    go = StubChatCompleter(text="go")
    g = AIGate(FakeDB(), "", StubChatCompleter(), go_chat=go,
               go_key="sk-go",
               config=Config(model_free="opencode-go/deepseek-v4.1-flash"))
    g.users = StubUserStore(_user("FREE"))
    g.usage = StubAiUsageStore()
    err = await _code(g.complete(uuid4(), _ai(web_search=True), "", "hi"))
    assert err.code == "NOT_CONFIGURED" and go.got == {}


@pytest.mark.parametrize("err,code", [
    (not_configured("search off"), "NOT_CONFIGURED"),
    (RuntimeError("boom"), "PROVIDER_ERROR"),
])
async def test_web_search_failure_aborts_before_reserving(err, code):
    g = _gate(chat=StubChatCompleter(err=err))
    assert (await _code(g.complete(uuid4(), _ai(web_search=True), "", "q"))
            ).code == code
    assert g.usage.items == []


# ---- stream ---------------------------------------------------------------

async def _drain(agen):
    return [t async for t in agen]


async def test_stream_managed_requires_a_chat_client():
    g = AIGate(FakeDB(), "sk", None)
    g.users = StubUserStore(_user())
    g.usage = StubAiUsageStore()
    err = await _code(_drain(g.stream(uuid4(), _ai(), "", "hi", {})))
    assert err.code == "NOT_CONFIGURED"


async def test_stream_without_chat_stream_falls_back_to_one_shot():
    class OneShot:
        async def chat(self, key, model, system, user, reasoning="",
                       extra_headers=None):
            return ent.AICompletion(text="whole", input_tokens=4,
                                    output_tokens=6)

    g = _gate(chat=OneShot())
    usage = {}
    assert await _drain(g.stream(uuid4(), _ai(), "", "hi", usage)) == ["whole"]
    assert (usage["input_tokens"], usage["output_tokens"]) == (4, 6)
    (row,) = g.usage.items
    assert row.status == ent.USAGE_SETTLED and usage["usage_ids"] == [row.id]
    assert row.cost_micro_credits == ent.ai_cost_micro_credits(
        "OPENAI", row.model, 4, 6)


async def test_stream_falls_back_when_langchain_import_fails_before_output(
        monkeypatch):
    async def no_langchain():
        raise ImportError("langchain")
        yield  # pragma: no cover

    monkeypatch.setattr("app.framework.models.stream_or_none",
                        lambda *a, **k: no_langchain())
    g = _gate(chat=StubChatCompleter(tokens=["a", "b"]))
    assert await _drain(g.stream(uuid4(), _ai(), "", "hi", {})) == ["a", "b"]


async def test_stream_langchain_output_skips_the_legacy_client(monkeypatch):
    async def lc():
        yield "x"

    monkeypatch.setattr("app.framework.models.stream_or_none",
                        lambda *a, **k: lc())
    legacy = StubChatCompleter(tokens=["legacy"])
    g = _gate(chat=legacy)
    assert await _drain(g.stream(uuid4(), _ai(), "", "hi", {})) == ["x"]
    assert legacy.got == {}
    assert g.usage.items[0].status == ent.USAGE_SETTLED


async def test_stream_import_error_after_output_fails_and_releases(monkeypatch):
    async def half():
        yield "a"
        raise ImportError("late")

    monkeypatch.setattr("app.framework.models.stream_or_none",
                        lambda *a, **k: half())
    g = _gate()
    got = []
    with pytest.raises(DomainError) as e:
        async for t in g.stream(uuid4(), _ai(), "", "hi", {}):
            got.append(t)
    assert got == ["a"] and e.value.code == "PROVIDER_ERROR"
    assert g.usage.items[0].status == ent.USAGE_RELEASED


@pytest.mark.parametrize("err,code", [
    (not_configured("x"), "NOT_CONFIGURED"),
    (RuntimeError("socket"), "PROVIDER_ERROR"),
])
async def test_stream_failure_releases_the_reservation(err, code):
    g = _gate(chat=StubChatCompleter(err=err))
    assert (await _code(_drain(g.stream(uuid4(), _ai(), "", "hi", {})))
            ).code == code
    (row,) = g.usage.items
    assert row.status == ent.USAGE_RELEASED and row.cost_micro_credits == 0


async def test_stream_failure_without_reservation(monkeypatch):
    monkeypatch.setenv("QUEUE_BACKEND", "redis")
    g = _gate(chat=StubChatCompleter(err=RuntimeError("x")))
    usage = {}
    assert (await _code(_drain(g.stream(uuid4(), _ai(), "", "hi", usage)))
            ).code == "PROVIDER_ERROR"
    assert "usage_ids" not in usage and g.usage.items == []


# ---- AIService.generate ---------------------------------------------------

def _svc(app=None, gate=None):
    s = AIService(FakeDB(), gate or _gate())
    s.ops = StubOperationStore()
    s.usage = StubAiUsageStore()
    s.applications = app if app is not None else StubApplicationStore()
    return s


async def test_generate_requires_ai_and_bounded_prompt():
    s = _svc()
    err = await _code(s.generate(uuid4(), None, "p", uuid4(), []))
    assert err.details == {"field": "ai"}
    for prompt in ("", "x" * 20001):
        err = await _code(s.generate(uuid4(), _ai(), prompt, uuid4(), []))
        assert err.details == {"field": "prompt"}
    assert s.ops.created == []


async def test_generate_application_lookup_failure_is_internal():
    class Broken(StubApplicationStore):
        async def get(self, user_id, id_):
            raise RuntimeError("db")

    s = _svc(app=Broken())
    assert (await _code(s.generate(uuid4(), _ai(), "p", uuid4(), []))
            ).code == "INTERNAL"


async def test_generate_rejects_another_users_application():
    owner = uuid4()
    app = ent.Application(id=uuid4(), user_id=owner, job_id=uuid4(),
                          company="A", title="B", created_at=_now(),
                          updated_at=_now())
    chat = StubChatCompleter(text="nope")
    s = _svc(app=StubApplicationStore(app), gate=_gate(chat=chat))
    assert (await _code(s.generate(uuid4(), _ai(), "p", app.id, []))
            ).code == "NOT_FOUND"
    assert chat.got == {} and s.ops.created == []


async def test_cancelled_completion_releases_its_reservation():
    import asyncio
    g = _gate(chat=StubChatCompleter(err=asyncio.CancelledError()))
    with pytest.raises(asyncio.CancelledError):
        await g.complete(uuid4(), _ai(), "", "hi")
    assert [u.status for u in g.usage.items] == [ent.USAGE_RELEASED]
