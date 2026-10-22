from __future__ import annotations

from langchain_core.messages import AIMessage


class ScriptedChat:
    def __init__(self, replies: list[dict]):
        self.replies = list(replies)
        self.seen: list = []

    def bind_tools(self, tools, **kwargs):
        return self

    async def ainvoke(self, messages, **kwargs):
        self.seen.append(messages)
        reply = self.replies.pop(0) if self.replies else {"content": "done"}
        return AIMessage(
            content=reply.get("content") or "",
            tool_calls=reply.get("tool_calls") or [],
        )
