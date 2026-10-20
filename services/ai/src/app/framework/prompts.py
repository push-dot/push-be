from __future__ import annotations

from app.framework.flag import use_langchain

CONTINUE = "끊긴 지점부터 이어서 작성해."
SYSTEM_TEMPLATE = "{system}"
USER_TEMPLATE = "{user}"

_ROLE = {
    "human": "user",
    "ai": "assistant",
    "system": "system",
    "user": "user",
    "assistant": "assistant",
}


def legacy_messages(system: str, user: str,
                    assistant_prefix: str = "") -> list[dict]:
    messages = ([{"role": "system", "content": system}] if system else []) + [
        {"role": "user", "content": user}]
    if assistant_prefix:
        messages += [
            {"role": "assistant", "content": assistant_prefix},
            {"role": "user", "content": CONTINUE},
        ]
    return messages


def _from_prompt(prompt_cls, system: str, user: str,
                 assistant_prefix: str) -> list[dict]:
    spec = []
    variables = {}
    if system:
        spec.append(("system", SYSTEM_TEMPLATE))
        variables["system"] = system
    spec.append(("user", USER_TEMPLATE))
    variables["user"] = user
    rendered = prompt_cls.from_messages(spec).invoke(variables).to_messages()
    messages = []
    for message in rendered:
        role = _ROLE.get(getattr(message, "type", ""), "user")
        messages.append({"role": role, "content": message.content})
    if assistant_prefix:
        messages += [
            {"role": "assistant", "content": assistant_prefix},
            {"role": "user", "content": CONTINUE},
        ]
    return messages


def render_messages(system: str, user: str, assistant_prefix: str = "",
                    prompt_cls=None) -> list[dict]:
    """Prompt variables only. Caller text is never pasted into the template."""
    if use_langchain():
        cls = prompt_cls
        if cls is None:
            try:
                from langchain_core.prompts import ChatPromptTemplate as cls
            except ImportError:
                cls = None
        if cls is not None:
            return _from_prompt(cls, system, user, assistant_prefix)
    return legacy_messages(system, user, assistant_prefix)
