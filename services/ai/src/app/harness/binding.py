"""What a turn binds for its tools: the services, the core client and the AI gate.

Kept apart from any one harness so push-agent's tools read them without importing the personal harness.
"""

from __future__ import annotations

import contextvars

bound_services: contextvars.ContextVar = contextvars.ContextVar(
    "harness_services", default=None)

bound_core: contextvars.ContextVar = contextvars.ContextVar("resume_core", default=None)


def current_ai_gate():
    svc = bound_services.get()
    gate = getattr(svc, "ai", None) if svc is not None else None
    if gate is None or not hasattr(gate, "_reserve"):
        return None
    return gate
