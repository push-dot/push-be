from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from app.domain import entities as ent
from app.domain.services.conversation import ConversationService
from tests.stubs import (
    FakeDB, StubAiUsageStore, StubApplicationStore,
    StubDocumentStore, StubEvidenceStore, StubOperationStore,
)


def _now():
    return datetime.now(timezone.utc)


def _conv(user_id=None, application_id=None, archived=False, revision=1):
    return ent.Conversation(
        id=uuid4(), user_id=user_id or uuid4(), revision=revision,
        application_id=application_id, archived=archived,
        created_at=_now(), updated_at=_now())


def _svc(convs, apps=None, docs=None, ev=None, ops=None, gate=None,
         usage=None):
    svc = ConversationService(FakeDB(), gate, None)
    svc.conversations = convs
    svc.applications = apps or StubApplicationStore()
    svc.documents = docs or StubDocumentStore()
    svc.evidence = ev or StubEvidenceStore()
    svc.ops = ops or StubOperationStore()
    if usage is not None:
        svc.usage = usage
    return svc


def _managed_ai():
    return ent.AiOptions(provider="OPENAI", model="openai/gpt-5.6-luna",
                         effort="LOW")


def _gate_for(user_id, plan, embeds):
    from app.domain.services.ai import AIGate
    from tests.stubs import StubChatCompleter, StubUserStore

    gate = AIGate(FakeDB(), "sk-managed", StubChatCompleter())
    gate.users = StubUserStore(ent.User(
        id=user_id, provider="dev", provider_subject="d", display_name="Ada",
        created_at=_now(), plan=plan))
    gate.usage = StubAiUsageStore()

    async def embed(*args, **kwargs):
        embeds["n"] += 1
        return []

    gate.embed = embed
    return gate


class _Chunks:
    def __init__(self, chunks):
        self.chunks = chunks

    async def astream(self, _state, config=None, stream_mode=None):
        for chunk in self.chunks:
            yield chunk
