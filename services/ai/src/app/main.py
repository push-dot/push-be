from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from app.config import Config, load_config
from app.db import DB, NotFoundError, create_pool, migrations_dir, run_migrations
from app.jobs import external_jobs, runs_local_chat_worker
from app.domain.errors import DomainError
from app.infrastructure.crypto import new_key_cipher
from app.infrastructure.google_client import GoogleClient
from app.infrastructure.oauth import OAuthClient, provider_configs
from app.infrastructure.openai_client import OpenAIClient
from app.infrastructure.stripe_client import StripeClient
from app.infrastructure.store_auth import IdempotencyStore, UserStore
from app.infrastructure.store_evidence import SourceStore
from app.domain.services.ai import AIGate, AIService
from app.domain.services.application import ApplicationService
from app.domain.services.approval import ApprovalService
from app.domain.services.auth import AuthService
from app.domain.services.billing import BillingService
from app.domain.services.calendar import CalendarService
from app.domain.services.conversation import ConversationService
from app.domain.services.document import DocumentService
from app.domain.services.evidence import EvidenceService
from app.domain.services.experiment import ExperimentService
from app.domain.services.google import GoogleService
from app.domain.services.resume_workflow import ResumeWorkflowService
from app.domain.services.interview import InterviewService
from app.domain.services.job import JobService
from app.domain.services.operation import OperationService
from app.domain.services.project import ProjectService
from app.api.errors import (
    BodyLimitMiddleware, RequestIDMiddleware, domain_error_handler,
    http_error_handler, unhandled_error_handler, validation_error_handler,
)
from app.api.gateway_secret import SharedSecretMiddleware
from app.api.middleware import ApiMiddleware
from app.api.routers import (
    ai, applications, approvals, conversations, documents, evidence,
    internal, interviews, jobs, operations, projects,
)
from app.api.routers.evidence import MAX_SOURCE_BYTES


@dataclass(slots=True, frozen=True)
class ConfigView:
    google_configured: bool = False
    gmail_beta: bool = False
    managed_ai: bool = False
    managed_go: bool = False
    stripe_configured: bool = False
    job_site_adapters: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class Deps:
    auth: AuthService
    evidence: EvidenceService
    jobs: JobService
    applications: ApplicationService
    documents: DocumentService
    projects: ProjectService
    interviews: InterviewService
    calendar: CalendarService
    conversations: ConversationService
    resume_workflow: ResumeWorkflowService
    approvals: ApprovalService
    operations: OperationService
    ai: AIService
    google: GoogleService
    billing: BillingService
    experiments: ExperimentService
    sources: SourceStore
    idem: IdempotencyStore
    cfg: ConfigView
    storage_dir: str


def _healthz() -> JSONResponse:
    return JSONResponse(content={"data": {"status": "ok"}}, status_code=200)


async def ensure_ready(app: FastAPI, cfg: Config | None = None) -> None:
    if getattr(app.state, "deps", None) is not None:
        return
    lock = getattr(app.state, "_ready_lock", None)
    if lock is None:
        lock = app.state._ready_lock = asyncio.Lock()
    async with lock:
        if getattr(app.state, "deps", None) is not None:
            return
        await _bootstrap(app, cfg or load_config())


async def _bootstrap(app: FastAPI, cfg: Config) -> None:
    # Everything opened here is closed in reverse order by _shutdown, or
    # right away if a later step (migrations, seeding) raises.
    async with AsyncExitStack() as stack:
        pool = await create_pool(cfg.database_url)
        stack.push_async_callback(pool.close)
        db = DB(pool)
        migrations = migrations_dir()
        if migrations.is_dir() and os.environ.get("RUN_MIGRATIONS", "1") != "0":
            await run_migrations(pool, str(migrations))
        if cfg.app_env == "development" and cfg.dev_auth_token:
            try:
                await UserStore(db).get(cfg.dev_user_id)
            except NotFoundError:
                await UserStore(db).upsert_dev_user(cfg.dev_user_id)

        cipher = new_key_cipher(cfg.token_encryption_key) if cfg.token_encryption_key else None
        oauth = OAuthClient()
        stack.push_async_callback(oauth.aclose)
        openai = OpenAIClient(base_url=cfg.ai_base_url, config=cfg)
        stack.push_async_callback(openai.aclose)
        openai_go = OpenAIClient(base_url=cfg.opencode_go_base_url)
        stack.push_async_callback(openai_go.aclose)
        gapi = GoogleClient(cfg.google.client_id, cfg.google.client_secret)
        stack.push_async_callback(gapi.aclose)
        stripe = StripeClient(cfg.stripe_secret)
        stack.push_async_callback(stripe.aclose)

        gate = AIGate(db, cfg.managed_ai_key, openai,
                      go_chat=openai_go, go_key=cfg.opencode_go_key, config=cfg)
        auths = AuthService(db, oauth, provider_configs(cfg), cfg.app_env,
                            cfg.dev_auth_token, cfg.dev_user_id)
        approvals = ApprovalService(db)
        evidence_svc = EvidenceService(db)
        applications = ApplicationService(db, approvals,
                                          cfg.job_site_adapters)
        jobs_svc = JobService(db, approvals, gate)
        documents = DocumentService(db, approvals, gate)
        projects = ProjectService(db, approvals, gate)
        interviews = InterviewService(db, gate)
        calendar = CalendarService(db)
        ai_svc = AIService(db, gate)
        operations = OperationService(db, evidence_svc)
        google = GoogleService(
            db, cipher, gapi, cfg.google.client_id, cfg.google.client_secret,
            "https://accounts.google.com/o/oauth2/v2/auth", cfg.gmail_beta)
        billing = BillingService(
            db, stripe, bool(cfg.stripe_secret),
            {"PRO": cfg.stripe_price_pro, "ULTRA": cfg.stripe_price_ultra},
            cfg.stripe_success_url, cfg.stripe_cancel_url,
            cfg.stripe_portal_url, cfg.stripe_webhook_secret)
        experiments_svc = ExperimentService(db)
        await experiments_svc.seed(cfg.experiments)

        conversations = ConversationService(
            db, gate, await _chat_checkpointer(cfg, stack), documents,
            jobs_svc, applications)
        if runs_local_chat_worker():
            await conversations.start_worker()
            stack.push_async_callback(conversations.stop_worker)
        resume_workflow = ResumeWorkflowService(
            db, applications, jobs_svc, documents, evidence_svc, approvals)
        view = ConfigView(
            google_configured=bool(cfg.google.client_id
                                   and cfg.google.client_secret),
            gmail_beta=cfg.gmail_beta, managed_ai=bool(cfg.managed_ai_key),
            managed_go=bool(cfg.opencode_go_key),
            stripe_configured=bool(cfg.stripe_secret),
            job_site_adapters=cfg.job_site_adapters)
        app.state.deps = Deps(
            auth=auths, evidence=evidence_svc, jobs=jobs_svc,
            applications=applications, documents=documents,
            projects=projects, interviews=interviews, calendar=calendar,
            conversations=conversations, resume_workflow=resume_workflow,
            approvals=approvals,
            operations=operations, ai=ai_svc, google=google,
            billing=billing, experiments=experiments_svc,
            sources=SourceStore(db),
            idem=IdempotencyStore(db), cfg=view,
            storage_dir=cfg.storage_dir)
        app.state.db = db
        app.state.exit_stack = stack.pop_all()


async def _chat_checkpointer(cfg: Config, stack: AsyncExitStack) -> Any:
    # Workflow steps keep their own checkpoint in chat_jobs. Workers do not
    # import LangGraph's saver during bootstrap.
    if external_jobs():
        return None
    if os.environ.get("CHECKPOINTER") == "memory":
        from langgraph.checkpoint.memory import MemorySaver
        return MemorySaver()
    from app.db import open_chat_checkpointer
    saver, saver_pool = await open_chat_checkpointer(cfg.database_url)
    stack.push_async_callback(saver_pool.close)
    return saver


async def _shutdown(app: FastAPI) -> None:
    stack: AsyncExitStack | None = getattr(app.state, "exit_stack", None)
    app.state.exit_stack = None
    if stack is not None:
        await stack.aclose()


def create_app(cfg: Config | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await ensure_ready(app, cfg)
        try:
            yield
        finally:
            await _shutdown(app)

    app = FastAPI(lifespan=lifespan)
    app.add_exception_handler(DomainError, domain_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(HTTPException, http_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)

    app.add_middleware(ApiMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "tauri://localhost", "http://tauri.localhost",
            "https://tauri.localhost"],
        allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
        allow_credentials=True,
        allow_headers=["Origin", "Content-Type", "Accept", "Authorization",
                       "Idempotency-Key", "X-Request-Id"],
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"])
    app.add_middleware(BodyLimitMiddleware, limit=MAX_SOURCE_BYTES)
    app.add_middleware(SharedSecretMiddleware)
    app.add_middleware(RequestIDMiddleware)

    for r in (evidence.router, jobs.router, applications.router,
              documents.router, projects.router, interviews.router,
              conversations.router, approvals.router,
              operations.router, ai.router):
        app.include_router(r, prefix="/api/v1")
    app.include_router(internal.router)

    app.get("/healthz")(_healthz)
    app.get("/api/v1/healthz")(_healthz)
    return app


app = create_app()
