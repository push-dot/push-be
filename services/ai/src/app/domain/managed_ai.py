from __future__ import annotations

# Clients usually send no `ai` options. With a managed key configured, the turn runs on the
# plan's managed model (AIGate swaps in model and effort from plan_levers); without one it stays None (local stub).
MANAGED_DEFAULT = {"provider": "OPENAI", "model": "managed", "credentialMode": "MANAGED", "effort": "LOW"}


def with_managed_default(raw: dict | None) -> dict | None:
    if raw:
        return raw
    from app.config import load_config
    return dict(MANAGED_DEFAULT) if load_config().managed_ai_key else None
