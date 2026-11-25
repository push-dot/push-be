"""A role-keyed fake chat model for k-style tests. Parallel subagents and reviewers call in no fixed order,
so replies are picked by role (a marker in the first line of the system prompt), not by call order."""
from __future__ import annotations

import inspect
import json

from langchain_core.messages import AIMessage


def _system_head(messages) -> str:
    for message in messages:
        if getattr(message, "type", "") == "system":
            return str(message.content).split("\n", 1)[0]
    return ""


class RoleModel:
    """script: {marker: [reply, ...] | callable(messages) -> reply}. A reply is a dict (sent as JSON), a
    str, or an AIMessage; a callable may be async (to sleep past a stage limit). A list is consumed in
    order and its last reply repeats. Calls are recorded as (role, tier); "" is a role with no marker."""

    def __init__(self, script: dict, tier: str = "main", *, calls: list | None = None):
        self.script = script
        self.tier = tier
        self.calls: list[tuple[str, str]] = [] if calls is None else calls
        self.bound: list = []

    def tiered(self, tier: str) -> RoleModel:
        """The same script and call log, recorded under another tier."""
        return RoleModel(self.script, tier, calls=self.calls)

    def bind_tools(self, tools, **kwargs):
        self.bound.append(tools)
        return self

    def role(self, messages) -> str:
        head = _system_head(messages)
        return next((marker for marker in self.script if marker and marker in head), "")

    async def ainvoke(self, messages, **kwargs):
        role = self.role(messages)
        self.calls.append((role, self.tier))
        entry = self.script.get(role, {})
        if callable(entry):
            reply = entry(messages)
            if inspect.isawaitable(reply):
                reply = await reply
        elif isinstance(entry, list):
            reply = (entry.pop(0) if len(entry) > 1 else entry[0]) if entry else {}
        else:
            reply = entry
        if isinstance(reply, AIMessage):
            return reply
        content = reply if isinstance(reply, str) else json.dumps(reply, ensure_ascii=False)
        return AIMessage(content=content, usage_metadata={"input_tokens": 10, "output_tokens": 5,
                                                          "total_tokens": 15})
