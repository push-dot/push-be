from __future__ import annotations

from langchain_core.messages import SystemMessage

from app.framework.untrusted import as_data
from app.harness.memory import COMPACT_ABOVE, _held
from app.harness.registry import REGISTRY
from app.harness.runtime import HarnessRuntime
from tests.harness_fakes import CONV, USER, Rows, managed_ai, run, service
from tests.test_thread_memory import UsageLC

COMPANY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


async def test_a_long_company_thread_is_folded_into_a_summary_the_agent_reads():
    UsageLC.calls, UsageLC.models, UsageLC.seen = [], [], []
    svc = service(Rows({"company_id": COMPANY, "resume_state": None}))
    runtime = HarnessRuntime(svc, model_cls=UsageLC)
    for index in range(30):
        await run(runtime, {
            "text": f"우리 회사 채용 기준 {index} " + ("가" * 2400),
            "user_id": USER, "conversation_id": CONV,
            "job_id": f"{index:08d}-0000-4000-8000-000000000000",
            "access_mode": "AUTO", "ai": managed_ai(), "context": {},
        })
    graph = runtime._graph(REGISTRY["employer"])
    values = (await graph.aget_state({"configurable": {"thread_id": str(CONV)}})).values
    summary = (values.get("summary") or "").strip()
    assert summary, "the company thread was compacted"
    assert _held(values["messages"], summary) <= COMPACT_ABOVE + 20
    sent = UsageLC.seen[-1]
    assert isinstance(sent[1], SystemMessage)
    assert sent[1].content == as_data(summary, "summary", None)
