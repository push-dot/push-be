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


def chosen_document_text(inputs) -> str:
    if not isinstance(inputs, dict):
        return ""
    for key in ("document", "markdown", "text"):
        value = inputs.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def drafts_from_chosen(drafts, inputs) -> dict:
    current = dict(drafts) if isinstance(drafts, dict) else {}
    if draft_text(current):
        return current
    chosen = chosen_document_text(inputs)
    if not chosen:
        return current
    return {"markdown": chosen}
