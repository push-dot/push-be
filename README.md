<p align="center">
  <img src="assets/logo/push-app-icon-dark-tile.png" width="128" alt="Push 마스코트" />
</p>

<h1 align="center">Push BE</h1>

<p align="center">
  <strong>Push의 API. 게이트웨이 Worker, 코어 Worker, VPS의 Python AI</strong>
</p>

<p align="center">
  Node 22 · TypeScript 7 · Wrangler 4 · Python 3.12+ · FastAPI · LangGraph · Postgres 16 · pgvector · Redis
</p>

---

**push-be**는 Push 클라이언트가 호출하는 `/api/v1`이다. 공개 입구는 Cloudflare Worker `push-be`다. 인증과 CRUD는 Worker `push-be-core`가 맡고, AI 실행은 VPS의 Python 프로세스가 맡는다. 운영 DB는 Neon이다. 로컬 DB는 pgvector Postgres 16이다.

채팅을 큐에 넣는 요청은 `202`와 작업 id를 바로 돌려준다. 개인 이력서 워크플로는 `app/harness/personal/resume`의 LangGraph가 `mode_select` → `intake` → `analyze` → `strategy` → `craft` → `review` → `publish` → `present` 순으로 가고, 게이트에서 사용자 입력을 기다린다. 기업 대화는 `app/harness/employer`다. 두 하네스 id는 `app/harness/registry.py`의 `personal`, `employer`다. 토큰과 상태 이벤트는 `chat_events`에 남고, 게이트웨이 SSE가 그 행을 다시 보낸다.

## 아키텍처

```
클라이언트
    │  HTTPS /api/v1
    ▼
gateway Worker `push-be`          npm 패키지 push-be-front
    ├─ 아래 「게이트웨이가 직접 답하는 경로」
    ├─ ownerOf → core  ──서비스 바인딩 CORE──►  push-be-core  ──Neon HTTP──►  Postgres
    └─ ownerOf → python ── AI_ORIGIN (x-push-ai-secret) ──►  VPS
                                                              ├─ ai-worker (SERVE_API=1, LangGraph)
                                                              ├─ dispatcher (:8091, outbox → Redis)
                                                              ├─ ingest-worker
                                                              ├─ notify-worker (Expo 푸시)
                                                              ├─ redis
                                                              └─ embed (TEI). rerank는 compose 프로파일
```

`/internal`과 소유가 애매한 경로는 게이트웨이가 404로 막는다. 공개 계약은 `packages/contracts/openapi.json`이다. 경로마다 `x-owner`가 `gateway`, `core`, `ai` 중 하나다. 스펙 소스는 `packages/contracts/spec/*.ts`이고, `npm run contracts`가 `openapi.json`과 `src/schema.ts`를 다시 만든다. gateway·core·ai 테스트가 실제 라우트와 스펙이 어긋나면 실패한다.

게이트웨이가 직접 답하는 경로 (`services/gateway/src/handler.ts`):

| 메서드와 경로 | 내용 |
| --- | --- |
| `GET /healthz`, `GET /api/v1/healthz` | 건강 확인 |
| `GET /api/v1/auth/me` | 액세스 토큰으로 사용자. 인증 캐시가 있다 |
| `GET /api/v1/conversations` | 대화 목록 |
| `GET /api/v1/conversations/:id/messages` | 메시지 목록 |
| `GET /api/v1/conversations/:id/messages/stream/active` | `chat_events`를 SSE로 재생 |
| `POST /api/v1/conversations/:id/messages/stream` | 코어에 202를 받은 뒤 게이트웨이가 SSE를 연다 |
| `POST /api/v1/conversations/:id/stream/cancel` | 스트림 취소 |
| `GET /api/v1/ai/models` | 모델 카탈로그 |
| `GET /api/v1/integrations/job-sites` | 채용 사이트 체크리스트 |
| `OPTIONS` | CORS |

그 밖의 분기는 `services/gateway/src/routes/owner.ts`의 `ownerOf`다. Python으로 가는 예는 근거 가져오기, 공고·문서·면접·프로젝트의 AI 실행, `operations`, 승인 결정, 대화 공유와 아티팩트다. 인증, 대화 쓰기, 결제, 공고·지원·회사·소셜·프로필, 문서 enqueue, `GET /api/v1/ai/jobs/:id`는 코어다.

코어가 채팅을 넣을 때는 `chat_jobs`에 쓴다. 그 밖의 AI 작업은 `ai_jobs`와 `outbox`에 쓴다. `QUEUE_BACKEND=redis`이면 디스패처가 outbox를 Redis Streams로 넘긴다. 스트림은 `q:chat:priority`, `q:chat`, `q:document`, `q:ingest`, `q:notify`다. fit 작업도 `q:document`를 쓴다. `QUEUE_BACKEND=postgres`이면 프로세스 안 채팅 폴러가 `chat_jobs`를 가져간다. 그 폴러는 `CHAT_EXECUTOR=external`이거나 큐가 redis이면 켜지지 않는다 (`services/ai/src/app/jobs.py`).

근거 검색은 `app/rag`다. 임베딩 차원은 1024이고, 제공자는 `EMBEDDING_PROVIDER`다. `tei`면 TEI 컨테이너, 그 외 API 모드면 OpenAI 호환 `/embeddings`다. 재정렬 기본은 유사도이고, `RERANK_PROVIDER=tei`일 때만 TEI rerank를 쓴다. rerank 서비스는 compose 프로파일 `rerank`다.

`app/graphs/`에는 `resume_prompt.py`가 있다. 채팅 그래프는 `app/harness/`에 있다.

## 기술 스택

| 영역 | 버전·선택 |
| --- | --- |
| Node | CI와 로컬 권장은 22 |
| TypeScript | gateway·core 7.0.2 |
| Wrangler | 4.152.0 |
| Neon 드라이버 | `@neondatabase/serverless` 1.2.0 |
| Python | `requires-python >= 3.12`. Docker 이미지는 3.15.0. CI 테스트 매트릭스는 3.12와 3.15 |
| 패키지 | uv. 잠금 파일 `services/ai/uv.lock`. CI의 setup-uv는 10.3.2 |
| HTTP | FastAPI, pydantic, uvicorn(`local` extra) |
| 그래프 | langgraph, langgraph-checkpoint-postgres (`local` extra) |
| DB 드라이버 | asyncpg, psycopg (`local` extra). 마이그레이션 extra는 asyncpg와 websockets |
| 큐 | redis 클라이언트. 운영 브로커 이미지는 `infra/vps/compose.yaml`의 Redis |
| RAG | llama-index-core, llama-index-vector-stores-postgres (`local` extra) |
| 문서 | ReportLab, opendataloader-pdf, pypdf. 브라우저 추출은 Playwright |
| 로컬 Postgres | `pgvector/pgvector:pg16`, 호스트 5434 |
| CI test-ai Postgres | `postgres:16` (pgvector 없음). `test-db`는 pgvector pg16 |
| 운영 DB | Neon. VPS compose는 Postgres 컨테이너를 띄우지 않는다 |

Python extra는 `local`(uvicorn, asyncpg, 브라우저, PDF, llama-index), `test`(pytest, fakeredis), `migrate`(asyncpg, websockets)이다. 린트 그룹은 ruff와 mypy다.

## 구조

```
services/gateway/       Worker push-be. npm 패키지 push-be-front
services/core-api/      Worker push-be-core. 크론 15 * * * *
services/ai/            FastAPI, 하네스, 워커, scripts/migrate.py
  src/app/api/          라우터
  src/app/harness/      LangGraph (personal, employer)
  src/app/workers/      dispatcher, ai, ingest, notify
  src/app/rag/          검색
  src/app/ingest/       페이지·파일 파싱
packages/contracts/     OpenAPI 스펙과 생성 타입
db/migrations/          0001_init.sql … 0034_drop_legacy_rag.sql
db/tests/               schema_checks.sql
infra/docker-compose.yml
infra/vps/              운영 compose, Traefik, env.example, 배포 스크립트
```

Python이 `/api/v1`에 올리는 라우터는 `evidence`, `jobs`, `applications`, `documents`, `projects`, `interviews`, `conversations`, `approvals`, `operations`, `ai`다. `internal` 라우터는 접두사 없이 붙는다. `GET /healthz`와 `GET /api/v1/healthz`도 앱에 있다.

투명 배경 마크는 `assets/logo/push-mark-dark-transparent.svg`와 `assets/logo/push-mark-white-transparent.svg`다.

## 로컬 실행

게이트웨이와 코어는 Neon HTTP 드라이버라 로컬 compose의 Postgres에 붙지 않는다. compose는 Postgres와 AI uvicorn만 띄운다. 게이트웨이 주석은 `cd services/gateway && npx wrangler dev`다. 노트북의 uvicorn은 게이트웨이를 거치지 않고 8080으로 직접 호출한다.

```bash
docker compose -f infra/docker-compose.yml up -d --build
```

호스트 5434의 DB 이름·사용자·비밀번호는 compose 파일의 `POSTGRES_*`다. AI 컨테이너는 `RUN_MIGRATIONS=1`, `DB_DRIVER=asyncpg`, `PG_TRANSPORT=tcp`, `APP_ENV=development`로 기동하고 `../db`를 `/db`에 읽기 전용으로 마운트한다. Redis와 워커 프로세스는 이 파일에 없다. `QUEUE_BACKEND`를 비우면 Python 기본값은 `postgres`라서 uvicorn 프로세스가 채팅 폴러를 돌린다.

AI만 호스트에서 띄울 때:

```bash
cd services/ai
uv sync --locked --extra local --extra test
# 저장소 루트 .env.example 을 .env 로 복사한 뒤 DATABASE_URL 을 로컬 Postgres에 맞춘다
uv run python scripts/migrate.py
PYTHONPATH=src uv run uvicorn app.main:app --port 8080
```

```bash
cd services/gateway && npx wrangler dev
cd services/core-api && npx wrangler dev
```

`AI_ORIGIN`이 비어 있으면 게이트웨이의 AI 경로는 500 `NOT_CONFIGURED`다. 오리진은 `https`여야 한다.

## 환경 변수

값은 적지 않는다. 예시 파일은 저장소 루트 `.env.example`과 `infra/vps/env.example`이다. `.env.example`의 `LLM_STREAM`, `CF_ACCOUNT_ID`, `CF_API_TOKEN`은 `services/ai/src`가 읽지 않는다.

### gateway (`FrontEnv`)

`APP_ENV`, `AUTH_CACHE_TTL`, `AI_ORIGIN`, `AI_SHARED_SECRET`, `DATABASE_URL`, `DEV_AUTH_TOKEN`, `DEV_USER_ID`, `INTERNAL_API_SECRET`, `JOB_SITES_CACHE_TTL`, `MANAGED_AI`, `MANAGED_GO`, `MODEL_CACHE_TTL`, `SSE_MAX_POLLS`

`MANAGED_AI`, `MANAGED_GO`, 캐시 TTL, `SSE_MAX_POLLS`는 `services/gateway/wrangler.jsonc`의 vars다. `DATABASE_URL`과 시크릿은 Worker 시크릿으로 둔다.

### core (`CoreEnv`)

`AI_ORIGIN`, `AI_SHARED_SECRET`, `APP_ENV`, `APP_WEB_ORIGIN`, `APPLE_BUNDLE_ID`, `APPLE_CLIENT_ID`, `APPLE_IAP_KEY`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_ROOT_PEM`, `APPLE_TEAM_ID`, `DATABASE_URL`, `DEV_AUTH_TOKEN`, `DEV_USER_ID`, `DISPATCH_ORIGIN`, `DISPATCH_SECRET`, `EXPO_ACCESS_TOKEN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_GMAIL_BETA_ENABLED`, `GOOGLE_OIDC_AUDIENCE`, `GOOGLE_OIDC_KEY`, `GOOGLE_PLAY_KEY`, `GOOGLE_PLAY_PACKAGE`, `IAP_PRODUCT_PRO`, `IAP_PRODUCT_TOPUP`, `IAP_PRODUCT_ULTRA`, `IAP_TOPUP_CREDITS`, `INTERNAL_API_SECRET`, `INTERNAL_JOB_TOKEN`, `MAIL_FROM`, `MANAGED_AI`, `MANAGED_GO`, `NTS_SERVICE_KEY`, `OAUTH_REDIRECT_ORIGINS`, `PENDING_SIGNUP_SECRET`, `PHONE_CODE_COOLDOWN_SEC`, `PHONE_CODE_MAX_ATTEMPTS`, `PHONE_CODE_TTL_SEC`, `PHONE_SMS_MODE`, `QUEUE_BACKEND`, `RESEND_API_KEY`, `STRIPE_CANCEL_URL`, `STRIPE_PORTAL_RETURN_URL`, `STRIPE_PRICE_EMPLOYER_BASIC`, `STRIPE_PRICE_EMPLOYER_PRO`, `STRIPE_PRICE_EMPLOYER_ULTRA`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TOPUP`, `STRIPE_PRICE_ULTRA`, `STRIPE_SECRET_KEY`, `STRIPE_SUCCESS_URL`, `STRIPE_WEBHOOK_SECRET`, `TOKEN_ENCRYPTION_KEY`

`EMAIL`은 문자 환경 변수가 아니라 선택 Cloudflare Email 바인딩이다. `QUEUE_BACKEND`와 `DISPATCH_ORIGIN`의 운영 기본은 `services/core-api/wrangler.jsonc`의 vars다.

### Python·VPS

`load_config`와 워커가 읽는 이름:

`ADMIN_TOKEN`, `AI_BASE_URL`, `AI_SHARED_SECRET`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`, `APP_ENV`, `BLOB_STORE`, `CHAT_EXECUTOR`, `CHECKPOINTER`, `CORE_ORIGIN`, `DATABASE_URL`, `DB_DRIVER`, `DEV_AUTH_TOKEN`, `DEV_USER_ID`, `DISCORD_ALERT_WEBHOOK_URL`, `DISPATCH_PORT`, `DISPATCH_SECRET`, `EMBEDDING_API_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_API_MODEL`, `EMBEDDING_PROVIDER`, `EXPERIMENTS`, `EXPO_ACCESS_TOKEN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_GMAIL_BETA_ENABLED`, `INTERNAL_API_SECRET`, `LISTEN_ADDR`, `MODEL_EMPLOYER_ULTRA`, `MODEL_FREE`, `MODEL_PRO`, `MODEL_ULTRA`, `NEON_STORAGE_LIMIT_BYTES`, `OPENAI_API_KEY`, `OPENCODE_GO_API_KEY`, `OPENCODE_GO_BASE_URL`, `OPENROUTER_API_KEY`, `OPENROUTER_DEEPSEEK_PROVIDERS`, `PGDATABASE`, `PGHOST`, `PGPASSWORD`, `PGPORT`, `PGUSER`, `PG_TRANSPORT`, `PLAYWRIGHT_NO_SANDBOX`, `PORT`, `PUSH_RESUME_DIR`, `QUEUE_BACKEND`, `QUEUE_CONCURRENCY`, `QUEUE_CONSUMER`, `QUEUE_GROUP`, `REDIS_URL`, `RERANK_PROVIDER`, `RESEND_API_KEY`, `RUN_MIGRATIONS`, `SERVE_API`, `STORAGE_DIR`, `STRIPE_CANCEL_URL`, `STRIPE_PORTAL_RETURN_URL`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ULTRA`, `STRIPE_SECRET_KEY`, `STRIPE_SUCCESS_URL`, `STRIPE_WEBHOOK_SECRET`, `TEI_EMBED_MODEL`, `TEI_EMBED_URL`, `TEI_RERANK_URL`, `TOKEN_ENCRYPTION_KEY`

큐 시간 한도: `HEARTBEAT_LIMIT_CHAT_S`, `HEARTBEAT_LIMIT_EMPLOYER_AI_S`, `HEARTBEAT_LIMIT_DOCUMENT_S`, `HEARTBEAT_LIMIT_FIT_S`, `HEARTBEAT_LIMIT_INGEST_S`, `HEARTBEAT_LIMIT_NOTIFY_S`, `JOB_DEADLINE_CHAT_S`, `JOB_DEADLINE_EMPLOYER_AI_S`, `JOB_DEADLINE_DOCUMENT_S`, `JOB_DEADLINE_FIT_S`, `JOB_DEADLINE_INGEST_S`, `JOB_DEADLINE_NOTIFY_S`, `VISIBILITY_Q_CHAT_PRIORITY_S`, `VISIBILITY_Q_CHAT_S`, `VISIBILITY_Q_DOCUMENT_S`, `VISIBILITY_Q_INGEST_S`, `VISIBILITY_Q_NOTIFY_S`

VPS compose가 환경으로 만드는 이름: `AI_HOST`, `DISPATCH_HOST`, `REDIS_PASSWORD`, `AI_WORKER_CONCURRENCY`(`QUEUE_CONCURRENCY`로 들어간다), `INGEST_WORKER_CONCURRENCY`(ingest의 `QUEUE_CONCURRENCY`). Redis 컨테이너의 `REDISCLI_AUTH`는 `REDIS_PASSWORD`와 같다.

운영 compose는 `DB_DRIVER=asyncpg`, `PG_TRANSPORT=tcp`, `CHAT_EXECUTOR=local`, `BLOB_STORE=db`, `CHECKPOINTER=postgres`, `RUN_MIGRATIONS=0`, `QUEUE_BACKEND` 기본 `redis`를 넣는다. 절차와 한도는 `infra/vps/README.md`에 있다.

### GitHub Actions 배포

배포 job이 비어 있으면 실패하는 이름: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `VPS_HOST`, `VPS_SSH_KEY`, `VPS_SSH_HOST_KEY`, `DATABASE_URL`, `REDIS_PASSWORD`, `AI_SHARED_SECRET`, `INTERNAL_API_SECRET`, `DISPATCH_SECRET`, `ADMIN_TOKEN`, `TOKEN_ENCRYPTION_KEY`, `OPENROUTER_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `GOOGLE_CLIENT_SECRET`, `GH_OAUTH_CLIENT_SECRET`, `AI_HOST`, `DISPATCH_HOST`, `GOOGLE_CLIENT_ID`, `GH_OAUTH_CLIENT_ID`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ULTRA`

`GH_OAUTH_CLIENT_ID`는 VPS와 코어에서 `GITHUB_CLIENT_ID`로, `GH_OAUTH_CLIENT_SECRET`은 `GITHUB_CLIENT_SECRET`으로 들어간다.

배포가 값이 있을 때만 `.env`에 쓰는 추가 이름: `OPENAI_API_KEY`, `EMBEDDING_API_KEY`, `RESEND_API_KEY`, `DISCORD_ALERT_WEBHOOK_URL`, `EXPO_ACCESS_TOKEN`, `CORE_ORIGIN`, `QUEUE_BACKEND`, `EMBEDDING_PROVIDER`, `EMBEDDING_API_MODEL`, `RERANK_PROVIDER`, `AI_BASE_URL`, `NEON_STORAGE_LIMIT_BYTES`, `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`, `AI_WORKER_CONCURRENCY`, `INGEST_WORKER_CONCURRENCY`

브랜치 변수 `DEPLOY_BRANCH`가 비어 있으면 배포 브랜치는 `main`이다. 마이그레이션 워크플로는 시크릿 `DATABASE_URL`과 입력 `transport`(`tcp` 또는 `websocket`)를 쓴다.

## 테스트

```bash
npm ci
npm test          # push-be-front, push-be-core. node --test
npm run typecheck
npm run contracts

cd services/ai
uv sync --locked --extra test
uv run python -m pytest

# CI와 같이 커버리지까지
uv run python -m pytest --cov=app --cov-report=term

# ruff, mypy. CI lint-ai는 continue-on-error
uv sync --locked --extra local --extra test --group lint
uv run ruff check .
uv run ruff format --check .
uv run mypy
```

커버리지 스크립트는 `npm run test:coverage -w push-be-front`와 `npm run test:coverage -w push-be-core`다.

DB 검사는 마이그레이션 뒤에 `db/tests/schema_checks.sql`을 실행한다. VPS compose 검사는 `infra/vps/test/run.sh`다.

## 배포

`.github/workflows/ci.yml`

| job | 언제 | 내용 |
| --- | --- | --- |
| `changes` | PR, `develop`·`main` push | 경로 필터 |
| `test-ai` | ai 또는 vps 경로 | pytest, Python 3.12·3.15, Postgres 16 |
| `lint-ai` | ai 경로 | ruff, mypy. 실패해도 job은 넘어간다 |
| `test-gateway` | gateway 경로 | `push-be-front` 테스트·타입체크 |
| `test-core` | core 경로 | `push-be-core` |
| `test-db` | db 경로 | `migrate.py` 후 `schema_checks.sql` |
| `bundle-core`, `bundle-gateway` | 해당 경로 | `wrangler deploy --dry-run` |
| `test-vps` | vps 경로 또는 배포 | `infra/vps/test/run.sh` |
| `deploy` | `DEPLOY_BRANCH`(기본 `main`) push이고 필요한 테스트가 성공일 때 | VPS 이미지, `push-be-core`, `push-be` |

배포 명령은 워크플로와 같다.

```bash
# services/core-api 와 services/gateway 에서. AI_HOST 는 저장소 변수
npx wrangler deploy --var AI_ORIGIN:https://${AI_HOST}
```

그 다음 각 디렉터리에서 `npx wrangler secret bulk`로 시크릿을 넣는다. 빈 값은 빼고, 이미 있는 시크릿은 유지한다. VPS는 `/opt/push-be/.env`를 다시 쓰고 `infra/vps/compose.yaml`로 올린다. 배포 뒤 `https://<AI_HOST>/healthz`와 `https://<DISPATCH_HOST>/healthz`가 200인지 확인한다.

Python Worker `push-be-python`은 배포하지 않는다. 게이트웨이 `workers_dev`는 켜져 있고, 코어 `workers_dev`는 꺼져 있다. 코어 크론은 `15 * * * *`이다. 게이트웨이 크론 목록은 비어 있다.

스키마는 배포에 포함되지 않는다. Actions의 **Migrate database**(`workflow_dispatch`)가 `services/ai/scripts/migrate.py`를 실행한다. 전송 기본은 `tcp`다. `db/migrations/`는 파일 이름 순으로 한 번씩 적용되고 `schema_migrations`에 기록된다. 적용한 파일은 고치지 않고 다음 번호로 추가한다.

`develop`에 대한 PR과 push는 바뀐 경로의 테스트만 돌린다. `DEPLOY_BRANCH`(기본 `main`) push는 ai, gateway, core, db 테스트를 모두 켜고 `deploy`를 켠다. `test-vps`는 vps 경로이거나 `deploy`가 켜졌을 때 돈다.
