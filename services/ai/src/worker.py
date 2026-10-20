"""Cloudflare Workers entrypoint.

Local uvicorn keeps using ``app.main:app``. This module is loaded by
``pywrangler`` / ``wrangler`` (``python_workers`` compatibility flag).
"""

from __future__ import annotations

import asyncio
import os
import time

from app.jobs import set_job_scheduler
from app.main import app, ensure_ready

_ENV_KEYS = (
    "DATABASE_URL", "APP_ENV", "DB_DRIVER", "PG_TRANSPORT", "RUN_MIGRATIONS",
    "CHAT_EXECUTOR", "CHAT_EXECUTOR_REMOTE", "AI_ORIGIN",
    "LLM_STREAM", "SSE_MAX_POLLS", "BLOB_STORE", "CHECKPOINTER",
    "DEV_AUTH_TOKEN", "DEV_USER_ID",
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
    "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
    "OPENROUTER_API_KEY", "OPENAI_API_KEY", "AI_BASE_URL",
    "OPENCODE_GO_API_KEY", "OPENCODE_GO_BASE_URL", "BYOK_MASTER_KEY",
    "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_PRO", "STRIPE_PRICE_ULTRA",
    "STRIPE_SUCCESS_URL", "STRIPE_CANCEL_URL", "STRIPE_PORTAL_RETURN_URL",
    "GOOGLE_GMAIL_BETA_ENABLED", "EXPERIMENTS",
    "CF_ACCOUNT_ID", "CF_API_TOKEN", "STORAGE_DIR",
)


def _patch_to_thread() -> None:
    async def inline(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    asyncio.to_thread = inline


def apply_env(env) -> None:
    """Copy Worker bindings into ``os.environ`` for the existing config loader."""
    if env is None:
        return
    for key in _ENV_KEYS:
        try:
            value = getattr(env, key, None)
        except Exception:
            value = None
        if value is None or value == "":
            continue
        os.environ[key] = str(value)
    os.environ["CF_WORKER"] = "1"
    os.environ.setdefault("DB_DRIVER", "neon")
    os.environ.setdefault("PG_TRANSPORT", "websocket")
    os.environ.setdefault("RUN_MIGRATIONS", "0")
    os.environ.setdefault("CHAT_EXECUTOR", "workflow")
    os.environ.setdefault("LLM_STREAM", "1")
    os.environ.setdefault("BLOB_STORE", "db")
    os.environ.setdefault("SSE_MAX_POLLS", "20")
    _patch_to_thread()


async def _create_workflow(env, job_id: str, byok: str, claim: str = "") -> None:
    binding = getattr(env, "CHAT_WORKFLOW", None)
    if binding is None:
        return
    body = {
        "id": f"chat-{job_id}-{int(time.time() * 1000)}",
        "params": {
            "jobId": str(job_id),
            "byok": byok or "",
            "claim": claim or "",
        },
    }
    try:
        await binding.create(body)
        return
    except TypeError:
        pass
    from js import Object
    from pyodide.ffi import to_js
    await binding.create(to_js(body, dict_converter=Object.fromEntries))


def _begin_db_scope():
    from app.pgproto import begin_request_scope
    return begin_request_scope()


async def _end_db_scope(scope) -> None:
    db = getattr(app.state, "db", None)
    pool = getattr(db, "pool", None)
    end = getattr(pool, "end_request_scope", None)
    if end is None:
        return
    try:
        await end(scope)
    except Exception:
        pass


def _install_scheduler(env) -> None:
    async def schedule(job_id: str, byok: str, claim: str = "") -> None:
        await _create_workflow(env, job_id, byok, claim)

    set_job_scheduler(schedule)


def _payload(event) -> dict:
    if isinstance(event, dict):
        raw = event.get("payload") or {}
    else:
        raw = getattr(event, "payload", None) or {}
    if isinstance(raw, dict):
        return raw
    try:
        from pyodide.ffi import to_py
        return dict(to_py(raw))
    except Exception:
        return {
            "jobId": getattr(raw, "jobId", ""),
            "byok": getattr(raw, "byok", "") or "",
            "claim": getattr(raw, "claim", "") or "",
        }


try:
    from workers import WorkerEntrypoint, WorkflowEntrypoint, asgi
except ImportError:  # imported outside the Workers runtime
    class WorkflowEntrypoint:  # type: ignore[no-redef]
        pass

    class WorkerEntrypoint:  # type: ignore[no-redef]
        pass

    asgi = None


def _step_config(timeout: str, limit: int = 5) -> dict:
    # A step killed by the free-plan CPU limit fails the attempt. Workflows
    # retry it with exponential backoff. The node itself is idempotent, so
    # a retry does not duplicate chat_events from the attempt that died.
    return {
        "retries": {
            "limit": limit,
            "delay": "2 seconds",
            "backoff": "exponential",
        },
        "timeout": timeout,
    }


_NODE_TIMEOUTS = {
    "resolve_context": "1 minute",
    "prepare_reply": "2 minutes",
    "generate_reply": "3 minutes",
    "persist": "1 minute",
}

# One Workflow invocation per entry. claim, resolve_context, and
# prepare_reply share the first invocation: each extra step was a new
# worker start plus a Neon WebSocket, and that gap is what the client
# waited through before the first status. generate and persist stay
# apart so the model call and the write each get a CPU budget.
WORKFLOW_STEP_PLAN = (
    ("prepare", ("resolve_context", "prepare_reply"), "3 minutes"),
    ("generate_reply", ("generate_reply",), _NODE_TIMEOUTS["generate_reply"]),
    ("persist", ("persist",), _NODE_TIMEOUTS["persist"]),
)


class ChatWorkflow(WorkflowEntrypoint):
    """Three steps: prepare (claim + context), generate, persist."""

    async def run(self, event, step):
        apply_env(self.env)
        # ensure_ready runs before any step. Its socket is closed here so a
        # suspended step cannot reuse it, and each step opens its own.
        scope = _begin_db_scope()
        try:
            await ensure_ready(app)
        finally:
            await _end_db_scope(scope)
        await self._run(event, step)

    async def _run(self, event, step):
        payload = _payload(event)
        job_id = str(payload.get("jobId") or "")
        claim = str(payload.get("claim") or "")
        if not job_id:
            return
        svc = app.state.deps.conversations

        # step.do injects dependencies by parameter name, so names are
        # closed over rather than passed as default arguments.
        def make_step(step_name, nodes, timeout):
            @step.do(step_name, config=_step_config(timeout))
            async def run_step():
                scope = _begin_db_scope()
                try:
                    if step_name == "prepare":
                        claimed = await svc.claim_for_workflow(job_id, claim)
                        if claimed != "ok":
                            return claimed
                    for node in nodes:
                        result = await svc.exec_chat_node(job_id, node, claim)
                        if result != "ok":
                            return result
                    return "ok"
                finally:
                    await _end_db_scope(scope)

            return run_step

        for step_name, nodes, timeout in WORKFLOW_STEP_PLAN:
            if await make_step(step_name, nodes, timeout)() != "ok":
                return


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        apply_env(self.env)
        _install_scheduler(self.env)
        if asgi is None:
            raise RuntimeError("workers package is not installed")
        scope = _begin_db_scope()
        try:
            return await asgi.fetch(app, request, self.env)
        finally:
            await _end_db_scope(scope)

    async def scheduled(self, controller, env=None, ctx=None):
        # WorkerEntrypoint handlers get bindings on self.env; the positional
        # env argument is empty on this runtime.
        env = getattr(self, "env", None) or env
        apply_env(env)
        _install_scheduler(env)
        scope = _begin_db_scope()
        try:
            await ensure_ready(app)
            await app.state.deps.conversations.nudge_pending()
            from app.ratelimit import sweep
            await sweep(app.state.db.pool)
        finally:
            await _end_db_scope(scope)
