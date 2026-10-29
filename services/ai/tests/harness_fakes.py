from __future__ import annotations

from types import SimpleNamespace
from uuid import UUID, uuid4

from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver

CONV = UUID("77777777-7777-4777-8777-777777777777")
USER = UUID("88888888-8888-4888-8888-888888888888")


class Rows:
    def __init__(self, conversation: dict | None = None):
        self.conversation = conversation or {"company_id": None, "resume_state": None}
        self.executed: list = []
        self.approvals: dict = {}

    def q(self):
        return self

    async def fetchrow(self, sql, *args):
        if "FROM conversations" in sql:
            return self.conversation
        if "FROM approvals" in sql:
            return self.approvals.get(str(args[0]))
        return None

    async def fetch(self, sql, *args):
        return []

    async def execute(self, sql, *args):
        self.executed.append((sql, args))
        if "UPDATE conversations SET resume_state" in sql:
            self.conversation = {**self.conversation, "resume_state": args[1]}
        if sql.lstrip().startswith("INSERT INTO approvals"):
            kind = args[2] if isinstance(args[2], str) else "TOOL_ACTION"
            self.approvals[str(args[0])] = {"id": args[0], "kind": kind}
        if "UPDATE approvals SET tool_args" in sql:
            row = self.approvals.get(str(args[0]))
            if row is not None:
                row["tool_args"] = args[1]
        return "UPDATE 1"

    async def run(self, work):
        return await work()


class Gate:
    def __init__(self):
        self.settled: list = []
        self.released: list = []
        self.reserved: list = []

    async def check(self, user_id, ai):
        ai.model = "gate-model"

    async def _route(self, user_id, ai):
        return SimpleNamespace(base_url="http://llm.test"), "key", ai.model, None

    async def _reserve(self, user_id, ai, system, user, job_id=None):
        self.reserved.append(job_id)
        return uuid4()

    async def _settle(self, usage_id, model, input_tokens, output_tokens):
        self.settled.append((model, input_tokens, output_tokens))

    async def _release(self, usage_id):
        self.released.append(usage_id)


class ScriptedLC:
    """Stands in for ChatOpenAI. Class attributes hold the script per test."""

    replies: list = []
    bound: list = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def bind_tools(self, tools, **kwargs):
        ScriptedLC.bound.append(tools)
        return self

    async def ainvoke(self, messages, **kwargs):
        reply = ScriptedLC.replies.pop(0) if ScriptedLC.replies else {"content": "done"}
        return AIMessage(
            content=reply.get("content") or "",
            tool_calls=reply.get("tool_calls") or [],
            usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
        )


def service(rows: Rows | None = None):
    conversation = SimpleNamespace(id=CONV, application_id=None, title="대화", revision=1)
    messages: list = []
    ops: list = []

    async def get(user_id, id_):
        return conversation

    async def create_message(message):
        messages.append(message)

    async def create_op(op):
        ops.append(op)

    async def attach_operations(op_id, ids):
        return None

    async def company_plan(company_id):
        return "PRO"

    return SimpleNamespace(
        db=rows or Rows(),
        conversations=SimpleNamespace(
            get=get, create_message=create_message, upsert_user_message=create_message,
            company_plan=company_plan),
        ops=SimpleNamespace(create=create_op),
        usage=SimpleNamespace(attach_operations=attach_operations),
        ai=Gate(),
        _checkpointer=MemorySaver(),
        messages=messages,
        ops_created=ops,
    )


def managed_ai() -> dict:
    return {"provider": "OPENAI", "model": "managed", "effort": "LOW"}


async def run(runtime, payload: dict, thread: str = str(CONV)) -> list:
    out = []
    async for item in runtime.astream(payload, {"configurable": {"thread_id": thread}}):
        out.append(item)
    return out
