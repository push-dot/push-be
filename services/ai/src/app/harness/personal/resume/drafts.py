_PREFERRED = ("markdown", "text", "summary", "message")


def draft_text(drafts) -> str:
    if not isinstance(drafts, dict):
        return ""
    for key in _PREFERRED:
        value = drafts.get(key)
        if isinstance(value, str) and value.strip():
            return value
    for value in drafts.values():
        if isinstance(value, str) and value.strip():
            return value
    return ""
