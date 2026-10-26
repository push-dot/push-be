<h1 align="center">Push BE</h1>

<p align="center">
  <strong>근거 기반 커리어 문서를 단계별 게이트로 생성하는 AI 워크플로 백엔드</strong>
</p>

<p align="center">
  Python 3.13 · FastAPI · LangGraph · PostgreSQL 16 + pgvector · asyncpg
</p>

---

**push-be**는 Push의 API 서버다. 채팅 요청을 `chat_jobs` 큐에 넣고 워커가 LangGraph 워크플로를 실행하며, 각 Phase는 구조적 interrupt 게이트로 사용자 승인을 기다린다. 토큰은 `chat_events`를 통해 SSE로 스트리밍되고, 클라이언트가 끊겨도 이벤트가 DB에 남아 재연결할 수 있다.

## 저장소 배치

```
services/gateway     TypeScript Worker `push-be`. 인증 캐시, 속도 제한, 캐시, 라우팅
services/core-api    TypeScript Worker `push-be-core`. 인증, 대화, 결제, 키 저장, 공고, 캘린더
services/ai          Python Worker `push-be-python`. LangGraph, LLM, 임베딩, 크론, 사용량 기록
packages/contracts   FastAPI OpenAPI와 그 스펙으로 만든 TypeScript 타입
db/migrations        SQL 마이그레이션
infra                로컬 docker compose. VPS는 infra/vps
```

`packages/ts-shared`는 두지 않았다. 게이트웨이와 코어가 각자 타임스탬프 도우미를 둔다. 응답 바이트를 바꾸지 않으려고 게이트웨이 읽기 경로를 공유 패키지로 옮기지 않았다.

게이트웨이가 직접 답하는 읽기(건강 확인, `/auth/me`, 대화 목록, 메시지 목록, 활성 스트림, 모델 목록, 채용 사이트)는 그대로다. 그 외 비-AI 경로 중 코어가 구현한 것은 `CORE` 바인딩으로 `push-be-core`에 간다. AI 경로와 아직 옮기지 않은 CRUD는 `API` 바인딩으로 `push-be-python`에 간다. `POST /conversations/:id/messages`는 코어가 크레딧을 확인하고 잡을 넣은 뒤, Python의 `POST /internal/chat/schedule`로 Workflow만 예약한다. 게이트웨이는 `/internal`을 404로 막고 `x-push-internal`을 넘기지 않는다.

Python 안에서는 LangGraph를 `app/graphs`로, FastAPI 라우터를 `app/api`로, PDF·웹 페이지 파싱을 `app/ingest`로 옮겼다. 도메인과 인프라 계층은 그대로다. RAG는 `app/graphs/chat.py`의 답변 준비와 `app/infrastructure/store_evidence_chunks.py`에 남아 있다. 검색이 프롬프트 조립과 한 함수 안에 있고, 청크 저장소는 인프라 어댑터라 `app/rag`로 자르면 경계만 생기고 호출은 그대로다.

## 핵심 설계

- **단계 게이트 워크플로** — `app/graphs/chat.py`의 LangGraph가 Phase 0–6을 실행하고, 각 게이트에서 interrupt로 멈춰 사용자 입력을 받는다. 모델 재량이 아니라 구조로 진행을 통제
- **내구 큐 + 워커** — core가 `ai_jobs`·`outbox`·크레딧 예약을 한 트랜잭션에 쓰고 `202 {jobId}`를 돌려준다. VPS 디스패처가 outbox를 Redis Streams(`q:chat:priority`, `q:chat`, `q:document`, `q:ingest`, `q:notify`)로 넘기고, 종류별 워커가 consumer group으로 처리한다. 원본 기록은 Postgres라서 Redis가 비어도 다시 채운다. 진행 상태는 `GET /api/v1/ai/jobs/{id}`. 운영은 [infra/vps/README.md](infra/vps/README.md)
- **재연결 가능한 SSE** — `GET /conversations/{id}/messages/stream/active`가 진행 중 잡의 이벤트를 처음부터 재생해 이탈→복귀해도 스트림 복원
- **근거 RAG** — LlamaIndex `SentenceSplitter`(512/64)로 자르고 TEI `bge-m3`(1024차원)로 임베딩해 `rag_nodes`에 둔다. 검색은 pgvector 밀집 검색과 `pg_trgm` 키워드 검색을 합친 뒤 `bge-reranker-v2-m3`로 재정렬한다. 모든 검색은 사용자나 회사 필터가 있어야 한다. `RAG_ENGINE=legacy`면 기존 `rag_chunks` 경로를 쓴다
- **역할별 모델 라우팅** — `AIGate`가 generate/research/임베딩 역할별로 다른 모델을 호출. Push가 제공하는 관리형 모델만 쓴다. 사용자 API 키는 받지 않는다
- **문서 파이프라인** — 생성 산출물을 `내 서류` 문서 버전으로 동기화하고 PDF(ReportLab)·DOCX(직접 zip+XML)로 렌더링
- **지원 항목 자동 연결** — 공고 URL 감지 시 JobPosting + Application을 생성(또는 `source_url`로 중복 제거)하고 대화에 링크
- **A/B 실험** — `EXPERIMENTS` env로 시드, 사용자별 결정적 배정과 이벤트 집계
- **요청 상관키** — 미들웨어가 `x-request-id`를 수신·생성·에코하고 `http_request` JSON 로그에 `requestId`·`statusCode`·`durationMs`를 남김

## 아키텍처

```
앱·웹 ─► gateway ─► core ── ai_jobs + outbox + credit_reservations (한 트랜잭션) ─► 202 {jobId}
                      │                     │
                      │ POST /internal/kick │ 15분 스윕
                      ▼                     ▼
          VPS dispatcher ─► Redis Streams ─► ai-worker (LangGraph + LangChain)
                                          ├► ingest-worker (LlamaIndex → rag_nodes, TEI)
                                          └► notify-worker (Expo 푸시)
                                                │
                       chat_events · ai_jobs 상태 ─► gateway SSE / GET /api/v1/ai/jobs/{id}
```

계층은 `app/api`(라우터·스키마) → Domain(서비스·상태기계) → Infrastructure(DB·외부 API 클라이언트) 방향으로만 의존한다. 파싱은 `app/ingest`, 그래프는 `app/graphs`다.

## Cloudflare Workers + Neon 배포

로컬 `uvicorn`은 그대로다. `docker compose`의 Postgres(5434)와 `asyncpg`, 상주 `chat_jobs` 루프, 파일시스템 산출물, 토큰 스트리밍을 쓴다. Cloudflare 무료 Workers에 올릴 때는 같은 FastAPI 앱을 Pyodide Python Worker로 실행하고, DB는 Neon 무료 플랜에 둔다.

### 선택한 구조

FastAPI와 LangGraph를 Python Worker(`services/ai/src/worker.py`, `workers.asgi`)에 남겼다. AI가 아닌 CRUD(인증, 대화 생성·수정, 결제, 키, 공고, 캘린더)는 TypeScript 코어 Worker `push-be-core`(`services/core-api`)로 옮겼다. 그래프와 AI 경로는 Python에 남는다.

Neon 접속은 앱의 대화형 트랜잭션(`db.run` / `db.do`)을 지키기 위해 Postgres 와이어 프로토콜 클라이언트(`app/pgproto.py`)를 쓴다.

- 노트북에서 마이그레이션: TCP + TLS (`PG_TRANSPORT=tcp`, `sslmode=require`)
- Worker: WebSocket `wss://<host>/v2` (`PG_TRANSPORT=websocket`). 프레임은 Neon 서버리스 드라이버와 같고, TLS 안의 Postgres는 평문이다. 리전은 `DATABASE_URL`의 호스트에만 있다. `ap-southeast-1`이든 `ap-northeast-1`이든 호스트가 `.neon.tech`로 끝나면 Neon 드라이버를 쓰고, 소켓 주소는 그 호스트의 `wss://<host>/v2`다. 프런트 Worker는 URL을 `@neondatabase/serverless`에 그대로 넘긴다

Hyperdrive는 무료 플랜(쿼리 10만/일)에 포함되지만 클라이언트가 node-postgres / postgres.js다. Python Worker는 `asyncpg`·`psycopg` 네이티브 확장을 로드하지 못한다. Neon의 HTTP `/sql`은 한 요청 안의 비대화형 배치만 받는다. 둘 다 이 앱의 트랜잭션 형태와 맞지 않아 와이어 클라이언트를 택했다.

채팅 잡은 요청이 끝나면 사라지는 Worker 안에서 `FOR UPDATE SKIP LOCKED` 루프를 돌리지 않는다. Cloudflare Workflow `ChatWorkflow`는 호출 세 번이다. `prepare`가 claim과 `resolve_context`, `prepare_reply`를 한 번에 돌리고, 그 다음 `generate_reply`, `persist`다. 스텝마다 무료 플랜 CPU 10ms가 새로 주어지고, 스텝을 나눌 때마다 Worker 기동과 Neon WebSocket이 한 번씩 더 든다. I/O(LLM, Neon, DNS) 대기 시간은 CPU에 포함되지 않는다. 크론 `* * * * *`는 생성된 지 60초가 넘은 PENDING 잡만 다시 예약하고, 하트비트가 워크플로 타임아웃·재시도 예산(약 55분)보다 오래된 RUNNING 잡만 PENDING으로 되돌린다. 방금 시작된 잡은 건드리지 않는다. 큐는 컨슈머 호출 하나에 CPU 예산이 하나라 스텝 분리에 쓰지 않았다.

### Workers에서 바뀌는 동작

| 영역 | 로컬 | Workers |
| --- | --- | --- |
| DB 드라이버 | `asyncpg` | `app/pgproto.py` (Neon WebSocket) |
| 잡 실행 | 프로세스 안 루프, 토큰 스트리밍 | Workflow 스텝 3개, `LLM_STREAM=1` |
| 체크포인터 | `langgraph-checkpoint-postgres` | `MemorySaver` + `chat_jobs.checkpoint` |
| SSE | 폴링 최대 1500 | 폴링 최대 20, `retry: 400`, `id` / `Last-Event-ID` |
| 파일 | `./data/sources`, 워크스페이스 파일 | `sources.content`, `workspace_files` |
| PDF 텍스트 | opendataloader-pdf (실패 시 pypdf) | pypdf |
| PDF 렌더 | ReportLab | ReportLab이 없으면 CID PDF (HYGothic-Medium, 폰트 미포함) |
| DOCX | zip+XML | 동일 |
| 페이지 수집 | IP 고정 httpx, 짧으면 Playwright | HTTPS + DNS-over-HTTPS, 짧으면 Browser Rendering |
| 암호 | AES-256-GCM (순수 Python, `cryptography`와 동일 포맷) | 동일 |

`LLM_STREAM=1`은 generate 스텝에서 모델 응답을 한 번의 HTTP 스트림으로 받는다. 상태 이벤트는 바로 `chat_events`에 넣고, 첫 토큰도 바로 넣는다. 그 다음 토큰은 약 160자 또는 50ms 단위로 묶는다. 글자마다 INSERT를 하지 않고, 스텝이 끝날 때까지 한 덩어리로 두지도 않는다. 소켓은 그 스텝의 Neon 연결 하나다. `LLM_STREAM=0`이면 완성문을 받은 뒤 48자 단위로 넣는다. 클라이언트는 `retry: 400`과 `id:`를 보고 `GET /conversations/{id}/messages/stream/active?after=` 또는 `Last-Event-ID`로 이어서 재생한다.

모든 AI 잡은 Push 관리형 모델로 돈다. 클라이언트가 보낸 provider와 model은 쓰지 않고, AIGate가 플랜(`plan_levers`)에 맞는 모델과 effort를 고른다. 큐에 넣는 AI 잡은 모두 크레딧을 예약한다.

### 무료 한도

한도를 넘기면 유료로 넘어가는 설정은 `wrangler.jsonc`에 넣지 않았다. `limits.cpu_ms`를 10보다 크게 두면 배포가 유료 플랜을 요구할 수 있다.

**Cloudflare Workers Free** ([limits](https://developers.cloudflare.com/workers/platform/limits/))

- 요청 10만/일 (크론·Workflow 호출과 공유)
- HTTP·크론·Workflow 스텝당 CPU 10ms. 응답을 스트리밍하는 동안 wall time은 제한이 없다
- 서브리퀘스트 50/요청, 동시 외부 연결 6
- Worker 크기 64 MiB, 메모리 128 MB, 기동 1초
- 계정당 크론 트리거 5개, 최소 간격 1분
- 환경 변수 64개, 값 5 KB

**Workflows Free** — 스텝 3,000/일, 인스턴스 동시 100, 워크플로당 스텝 1,024, 스텝 결과 1 MiB. 채팅 1건이 스텝 4개(`claim` + 노드 3)이므로 하루 수백 건 규모다.

**Browser Rendering Free** — 10분/일, 동시 브라우저 3. `CF_ACCOUNT_ID`와 `CF_API_TOKEN`이 없으면 정적 HTML 추출만 한다.

**Hyperdrive Free** — 쿼리 10만/일. 이 배포는 사용하지 않는다.

**Neon Free** — 프로젝트당 스토리지 1 GB, 컴퓨트 100 CU-hours/월, 비활성 5분 뒤 scale-to-zero (끌 수 없음), pgvector 포함. 콜드 스타트는 첫 쿼리 지연으로 나타난다.

### 무료 한도 안에서 완전히 같지 않은 것

- Pyodide에서 LangGraph를 처음 컴파일하는 요청은 CPU 10ms를 넘길 수 있다. 스텝을 나눈 것은 그 이후의 실행을 위한 것이고, 첫 부트스트랩이 죽으면 유료 플랜에서 `limits.cpu_ms`를 올리는 것이 탈출구다. 이 저장소의 배포 검증은 자격 증명 없이 끝나서 Worker 런타임에서 그 숫자를 측정하지 못했다.
- Workflow 스텝 3,000/일을 넘기면 그날의 추가 채팅 잡은 시작되지 않는다.
- 서브리퀘스트 50은 evidence 임베딩이 많이 비어 있는 RAG에서 먼저 닿을 수 있다.
- Worker는 TCP 목적지를 IP로 고정할 수 없다. DNS-over-HTTPS로 사설 IP를 거절한 뒤 요청하지만, 그 사이의 DNS rebinding 창은 로컬 프록시보다 넓다.
- `MemorySaver`는 isolate가 죽으면 그래프 중간 상태가 사라진다. 잡 재시도는 `chat_jobs`와 `chat_jobs.checkpoint`가 맡는다. 그래프에 LangGraph `interrupt()`는 없다.
- Workers에서는 `finish=length`여도 이어서 생성하지 않는다. 로컬 스트림은 최대 3라운드까지 이어 간다.
- 레이트 리밋은 isolate 메모리다. 인스턴스마다 따로 센다.

### 1. Neon 프로젝트

1. [Neon 콘솔](https://console.neon.tech)에서 프로젝트를 만든다. Postgres 16.
2. **Direct** 연결 문자열을 복사한다. 호스트에 `-pooler`가 없어야 한다. 대화형 트랜잭션과 extended query를 쓰므로 트랜잭션 모드 풀러는 맞지 않는다.
3. `sslmode=require`를 붙인다.

```
postgresql://USER:PASSWORD@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require
```

pgvector는 모든 Neon 플랜에 있다. `db/migrations/0009_evidence_vectors.sql`이 `CREATE EXTENSION IF NOT EXISTS vector;`를 실행한다. SQL Editor에서 미리 켜도 된다.

### 2. 마이그레이션

Worker 안에서 마이그레이션을 돌리지 않는다. CPU 한도와 매 콜드 스타트 실행을 피하기 위해 `RUN_MIGRATIONS=0`이다. `develop`나 `main`에 푸시해도 스키마는 바뀌지 않는다. 5432로 나가는 노트북에서 실행하거나, Actions의 **Migrate database**를 수동 실행한다.

노트북에서 직접 돌릴 때의 기본 전송은 TCP다. `sslmode=require`는 암호화를 하고 인증서는 검사하지 않는다. TLS는 asyncio가 시작한다. 나가는 5432가 막혀 있으면 `PG_TRANSPORT=websocket`으로 Neon의 `wss://<host>/v2`를 쓴다. 프로토콜은 같고, 호스트는 여전히 pooler가 아닌 Direct다. Actions의 **Migrate database**는 기본이 websocket이고, 실행할 때 tcp로 바꿀 수 있다.

```bash
PG_TRANSPORT=websocket \
DATABASE_URL='postgresql://USER:PASSWORD@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require' \
  python services/ai/scripts/migrate.py
```

```bash
cd services/ai
pip install -e ".[local]"
DATABASE_URL='postgresql://USER:PASSWORD@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require' \
  python scripts/migrate.py
```

`db/migrations/`의 `0001`–`0015`가 순서대로 적용된다. `0014_workers_blobs.sql`은 `chat_jobs.checkpoint`, `sources.content`, `workspace_files`를 추가한다. `0015_rate_limits.sql`은 공유 속도 제한 카운터다.

### 3. 시크릿

`services/ai/wrangler.jsonc`의 `vars`는 비밀이 아닌 기본값이다 (`DB_DRIVER=neon`, `PG_TRANSPORT=websocket`, `CHAT_EXECUTOR=workflow`, `LLM_STREAM=1`, `BLOB_STORE=db`, `SSE_MAX_POLLS=20`, `RUN_MIGRATIONS=0`). `DATABASE_URL`은 vars에 넣지 않는다.

[uv](https://docs.astral.sh/uv/)로 Workers 도구를 설치한 뒤 시크릿을 넣는다.

```bash
cd services/ai
uv sync --group dev
printf '%s' 'postgresql://USER:PASSWORD@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require' \
  | uv run pywrangler secret put DATABASE_URL
uv run pywrangler secret put OPENROUTER_API_KEY
```

`uv run pywrangler secret put`은 `services/ai/wrangler.jsonc`의 이름인 `push-be-python`에 넣는다. 프런트 Worker `push-be`에는 `DATABASE_URL`만 따로 넣는다. `npx wrangler secret put DATABASE_URL --name push-be`. Python 의존성 번들은 `pywrangler`가 맞춘다.

| 이름 | 필요 |
| --- | --- |
| `DATABASE_URL` | 필수. Direct 호스트, `sslmode=require` |
| `OPENROUTER_API_KEY` | 관리형 모델. `OPENAI_API_KEY`와 하나 이상 |
| `MODEL_FREE` | 개인 FREE 모델. 비우면 `deepseek/deepseek-v4.1-flash` |
| `MODEL_PRO` | 개인 PRO와 기업 BASIC 모델. 비우면 `anthropic/claude-sonnet-5-5` |
| `MODEL_ULTRA` | 개인 ULTRA와 기업 PRO 모델. 비우면 `anthropic/claude-opus-5-5` |
| `MODEL_EMPLOYER_ULTRA` | 기업 ULTRA 모델. 비우면 `anthropic/claude-fable-5-1` |
| `OPENROUTER_DEEPSEEK_PROVIDERS` | FREE 모델 OpenRouter `provider.order`. 쉼표로 구분. 비우면 `Together,Fireworks,Novita`. FREE 요청은 `provider.ignore`에 `DeepSeek`을 넣는다 |
| `OPENAI_API_KEY` | OpenAI 호환 관리형 호출을 쓸 때 |
| `OPENCODE_GO_API_KEY` | OpenCode Go 모델을 쓸 때 |
| `BYOK_MASTER_KEY` | Google 연동 OAuth 토큰을 암호화할 때. 이름은 예전 그대로다 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google 로그인 |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub 로그인 |
| `MAIL_FROM` | 이메일 발신 주소. 운영 값은 `Push <no-reply@push.mail.devcyjoon.tech>`. 비우면 로컬 로거는 `noreply@push.local` |
| `RESEND_API_KEY` | 키가 있으면 운영 메일은 Resend로 보낸다. 키가 없고 EMAIL 바인딩이 있으면 그 바인딩으로 보낸다. 둘 다 없으면 로컬 로거를 쓴다 |
| `EXPO_ACCESS_TOKEN` | 있으면 알림을 Expo Push로 `user_devices`에 보낸다. 없으면 푸시는 보내지 않는다 |
| `INTERNAL_JOB_TOKEN` | `POST /api/v1/internal/notifications/run`과 `ai-done`의 Bearer. 없으면 그 경로는 503 |
| `APP_WEB_ORIGIN` | 인증·재설정 링크 origin. 비우면 `http://localhost:5174` |
| `OAUTH_REDIRECT_ORIGINS` | 추가 OAuth redirect origin. 쉼표로 구분. 경로는 `/auth/callback` |
| `NTS_SERVICE_KEY` | 국세청 사업자 진위확인 serviceKey. 비우면 사업자 확인은 503 |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | 결제 |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ULTRA` | 개인 Pro/Ultra 가격 ID |
| `STRIPE_PRICE_EMPLOYER_BASIC`, `STRIPE_PRICE_EMPLOYER_PRO`, `STRIPE_PRICE_EMPLOYER_ULTRA` | 기업 Basic/Pro/Ultra 가격 ID |
| `STRIPE_PRICE_TOPUP` | 크레딧 충전 가격 ID |
| `IAP_PRODUCT_PRO`, `IAP_PRODUCT_ULTRA`, `IAP_PRODUCT_TOPUP` | 앱 상품 ID |
| `IAP_TOPUP_CREDITS` | 인앱 충전 크레딧. 비우면 300 |
| `APPLE_IAP_KEY`, `GOOGLE_PLAY_KEY`, `GOOGLE_PLAY_PACKAGE` | 영수증 검증. Google 웹훅 본문은 `GOOGLE_PLAY_KEY`를 SPKI 공개키(ES256·RS256)로 서명 검증한다. 가져올 수 없으면 503. 비우면 503 |
| `APPLE_ROOT_PEM`, `GOOGLE_OIDC_AUDIENCE`, `GOOGLE_OIDC_KEY` | App Store 웹훅은 인증서 체인이 이 루트까지 이어져야 한다. Google Play 웹훅은 Bearer OIDC의 aud와 고정 공개키가 맞아야 한다. 비우거나 읽을 수 없으면 503 |
| `DEV_AUTH_TOKEN`, `DEV_USER_ID` | 개발 인증. 프로덕션에서는 비운다 |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | Browser Rendering. 없으면 정적 추출만 |
| `EXPERIMENTS` | JSON. 5 KB를 넘으면 시크릿으로 둔다. 예시 값은 `.env.example`에 있다 |

`AI_BASE_URL`, Stripe 리다이렉트 URL, `GOOGLE_GMAIL_BETA_ENABLED`는 `services/ai/wrangler.jsonc` vars다.

### 4. 로컬 개발

asyncpg 경로:

```bash
docker compose -f infra/docker-compose.yml up -d --build
```

compose는 pgvector Postgres(호스트 5434)와 AI 서비스(uvicorn, `RUN_MIGRATIONS=1`, 8080)를 띄운다. 게이트웨이와 코어는 Neon HTTP 드라이버라 이 Postgres에 붙지 않는다. Hostinger KVM에 같은 이미지를 올리는 절차는 `infra/vps/README.md`에 있다. `AI_ORIGIN`을 비워 두면 게이트웨이는 지금처럼 `push-be-python` 서비스 바인딩을 쓴다. 오리진 예시는 `https://push.devcyjoon.tech`다.

```bash
cd services/gateway && npx wrangler dev
```

노트북에서 AI만 직접 띄울 때:

```bash
cd services/ai
pip install -e ".[local,test]"
# 저장소 루트의 .env.example 을 .env 로 복사. DATABASE_URL 은 localhost:5434
python scripts/migrate.py
PYTHONPATH=src uvicorn app.main:app --port 8080
```

Workers 런타임 (`wrangler dev`). 시크릿은 `.dev.vars` 또는 이미 넣은 Worker 시크릿을 쓴다. `.dev.vars`는 커밋하지 않는다. 명령은 `services/ai`에서 실행한다. 엔트리가 `src/worker.py`라 업로드 루트는 `src/`다.

```bash
cd services/ai
uv sync --group dev
uv run pywrangler dev
# wrangler dev 도 동일하다
```

게이트웨이와 코어 테스트는 저장소 루트에서 `npm test`다. `npm run typecheck`는 두 서비스에 `tsc --noEmit`을 돌린다.

```bash
cd services/ai
pip install -e ".[local,test]"
python -m pytest
```

### 5. 배포

트래픽은 TypeScript 프런트 Worker `push-be`가 먼저 받는다. 공개 주소는 그대로 `https://push-be.<account>.workers.dev`다. 채팅 생성처럼 CPU가 무거운 요청만 서비스 바인딩으로 Python Worker `push-be-python`에 넘긴다. Python Worker는 `workers.dev` 주소를 열지 않는다.

```bash
# 1. Python Worker (크론, Workflow, 서비스 바인딩 대상)
cd services/ai && uv run pywrangler deploy
# 2. 코어 Worker (비-AI CRUD, 게이트웨이의 CORE 바인딩 대상)
cd ../.. && npm ci && npm exec -w push-be-core -- wrangler deploy
# 3. 게이트웨이 Worker (공개 URL). 이름은 그대로 push-be
npm exec -w push-be-front -- wrangler deploy
```

프런트 배포는 빈 크론 목록으로 `push-be`에 남아 있는 분당 스케줄을 지운다. Python 배포의 크론은 유지된다.

Python 엔트리포인트는 `services/ai/src/worker.py`다. `pywrangler`는 그 파일이 있는 `services/ai/src/`만 올리고, `services/ai` 밖의 `.venv`와 `.venv-workers`는 번들에 넣지 않는다. `services/ai` 루트에 엔트리를 두면 가상환경까지 올라가 `multipart: message too large`로 배포가 실패한다. 이력서 지시문 `app/resources/**/*.md`는 `services/ai/wrangler.jsonc`의 Data 규칙으로 같이 올라가고, Worker 안에서는 `Path(__file__)`로 읽는다.

프런트 Worker가 직접 처리하는 경로:

| 메서드와 경로 | 이유 |
| --- | --- |
| `GET /healthz` | DB도 Python도 타지 않는다 |
| `GET /api/v1/healthz` | Python은 타지 않는다. 공개 속도 제한을 Neon에 기록한다. 이 isolate가 이미 한도에 닿았으면 그 분은 다시 쓰지 않는다 |
| `GET /api/v1/auth/me` | 액세스 토큰 SHA-256과 사용자. 남은 할당량이 있고 인증 캐시가 5초 안이면 Neon을 건너뛴다 |
| `GET /api/v1/conversations` | 목록. 매번 Neon에서 읽는다. 생성·수정·아카이브는 코어 |
| `GET /api/v1/conversations/:id/messages` | 메시지 목록. 매번 Neon에서 읽는다 |
| `GET /api/v1/conversations/:id/messages/stream/active` | `chat_events`를 SSE로 다시 보낸다. 생성 시작(`POST .../messages`, `POST .../stream`)은 Python |
| `GET /api/v1/ai/models` | 정적 카탈로그. 관리형 모델만 돌려준다 |
| `GET /api/v1/integrations/job-sites` | 어댑터가 모두 꺼진 고정 체크리스트 |
| `OPTIONS` | CORS 프리플라이트 |

그 밖의 경로는 `services/gateway/src/routes/owner.ts`의 `ownerOf`가 정한다. AI 경로와 아직 옮기지 않은 CRUD는 Python, 코어가 구현한 CRUD는 코어로 간다. `/internal`은 404다. 상태 코드, `{"data": ...}` / `{"error": ...}` 모양, `x-request-id`, `Idempotency-Key`는 코어도 Python 미들웨어와 같은 모양으로 처리한다.

캐시. Workers KV는 쓰지 않는다. 무료 플랜 쓰기가 하루 1,000번이라 대화가 생길 때마다 키를 쓰면 그 한도가 먼저 끝난다. 대화 목록과 메시지 목록은 isolate에 두지 않는다. 세대 번호가 그 isolate에만 있어서, 다른 isolate나 Workflow가 쓴 행을 최대 몇 초 동안 빠뜨렸다. 그 두 경로는 요청마다 Neon을 읽고, ETag가 같으면 본문 없이 304를 준다.

| 응답 | 저장 | TTL | 무효화 |
| --- | --- | --- | --- |
| 액세스 토큰 → 사용자 | isolate. 키는 토큰 SHA-256 | `AUTH_CACHE_TTL` 초, 기본 5, 최대 5. `0`이면 끈다 | 그 isolate의 `POST /api/v1/auth/logout`와 `POST /api/v1/auth/refresh`가 2xx이면 바로 지우고 남은 할당량도 버린다. 다른 isolate는 최대 5초 동안 이전 토큰을 인정할 수 있다. 만료된 토큰, 429, `hits`가 없는 행은 넣지 않는다 |
| `GET /api/v1/conversations`, `GET .../messages` | 캐시하지 않는다 | | 사용자 본인의 쓰기 직후에도 다음 읽기가 Neon의 현재 행을 본다 |
| `GET /api/v1/ai/models` | Cache API | `MODEL_CACHE_TTL` 초, 기본 600. 응답은 `private` | TTL이 지나면 사라진다. 캐시 키는 토큰 SHA-256이다 |
| `GET /api/v1/integrations/job-sites` | Cache API | `JOB_SITES_CACHE_TTL` 초, 기본 3600. 응답은 `public` | 체크리스트가 바뀌면 `services/gateway/src/middleware/cache.ts`의 캐시 URL 버전을 올린다 |
| `GET .../messages/stream/active` | 캐시하지 않는다 | | 이벤트는 요청 시점의 `chat_events`여야 한다 |

요금제 이름(`PLAN_FREE`, `PLAN_PRO`, `PLAN_ULTRA`)과 크레딧은 Python 상수다. Neon에 요금제 카탈로그가 없고, `GET /billing`은 사용자별이라 프런트가 캐시하지 않고 Python으로 넘긴다.

사용자 읽기와 `GET /api/v1/auth/me`는 `Cache-Control: private, no-cache`, `Vary: Authorization`, weak ETag다. `If-None-Match`가 같으면 본문 없이 304다. 304도 목록과 메시지는 Neon을 읽은 뒤 만든다. 시각은 `to_char(... AT TIME ZONE 'UTC')`로 마이크로초까지 문자열로 읽고, Python `jsonutil._ts`와 같은 `...644999Z`로 맞춘다. JS `Date`는 밀리초만 있어서 `.644999`를 `.644000`으로 깎고 ETag와 커서를 흔들었다. 커서는 그 마이크로초와 id를 함께 담는다. 모델은 `private, max-age`, 채용 사이트는 `public, max-age`다. Neon 드라이버의 timestamptz 파서도 끈다. Python이 밀리초 시계를 float로 바꿔 `...999` 마이크로초를 저장하던 시각은 `time.time_ns`로 고친다.

속도 제한 할당량. isolate가 한 번에 큰 수를 선점하면, 요청을 몇 번만 처리한 isolate가 많아질 때 카운터만 차고 실제 응답은 그 일부다. 그래서 첫 선점은 1건이고, 그 선점을 만료 전에 다 쓴 isolate만 다음 선점이 2, 4, 8로 커진다. 한 번의 상한은 8이다. 버킷이 읽기 상한에 가까우면 부여량은 `min(선점, max(1, (상한 - hits) / 16))`까지 줄어들고, 상한에 닿으면 0이다. 응답 뒤에 남은 수는 `waitUntil`로 `hits`에서 뺀다. 같은 isolate에서 겹친 요청은 그 남은 수를 하나로 더하고, 마지막 타이머가 아직 어느 요청에도 안 넘긴 수 전부를 한 번에 뺀다. 지연은 짧고, 카운터가 상한 근처면 바로 반환한다. 남은 수가 1이고 카운터가 읽기 상한의 4분의 1 아래면 그 한 건은 Neon에 돌려주지 않는다. 그 이상은, 그 isolate가 다음 요청을 받지 않아도 행에 남지 않는다. 분이 바뀌거나 로그아웃해도 남은 수를 반환한다. 프런트 읽기는 공유 한도의 90%에서 멈춘다. 사용자 600이면 읽기는 540까지이고, 나머지 60은 같은 `user:{id}:{분}` 행을 쓰는 Python 쓰기가 가져간다. `hits`는 그 상한을 넘지 않는다. 이 문이 더한 수는 `granted`다. 그 값은 `hits`를 읽어서 빼지 않는다. 문 하나의 스냅샷은 행 잠금을 기다리는 동안 옛 값을 보므로, 그 뺄셈은 동시에 들어온 선점에서 부여량을 부풀린다. 같은 `UPDATE`가 증가분을 `expires_at`에 초 단위로도 적고, `RETURNING`이 그 차이를 `granted`로 돌려준다. 그 몇 초는 분 버킷을 지울 때만 쓰인다. 할당량이 떨어지면 인증 조회와 같은 문으로 다시 선점한다. 이미 가득 찬 버킷을 본 isolate는 그 분 동안 다시 쓰지 않는다. 분이 바뀌면 할당량이 비어 있으므로 첫 요청이 Neon을 친다.

인증 캐시가 맞은 모델·채용 사이트 조회는 남은 할당량이 있는 동안 Neon 0번이다. 목록과 메시지는 매번 Neon을 읽는다. 인증과 속도 제한만 할당량 안에서 줄어든다.

`MANAGED_AI`와 `MANAGED_GO`는 프런트 Worker vars다. 시크릿이 아니다. Python Worker에 `OPENROUTER_API_KEY` 또는 `OPENAI_API_KEY`가 있으면 `MANAGED_AI=1`, `OPENCODE_GO_API_KEY`가 있으면 `MANAGED_GO=1`로 맞춘다. 기본값은 `1`과 `0`이다.

채팅 Workflow 호출은 `prepare`, `generate_reply`, `persist` 세 번이다. `prepare` 안에서 claim, `resolve_context`, `prepare_reply`가 같은 Neon 연결을 쓴다. 각 호출은 재시도 5회, 2초에서 지수 백오프다. 타임아웃은 prepare 3분, generate 3분, persist 1분이다. 스텝이 CPU 한도로 죽으면 체크포인트의 `event_id` 이후 이벤트만 지우고 다시 실행한다. 이미 끝난 노드는 건너뛴다. 같은 노드가 3번 실패하면 잡을 `FAILED`로 닫는다. 예약마다 claim 토큰이 하나 생기고, 그 토큰이 `chat_jobs.checkpoint`에 들어간다. generate와 persist는 `UPDATE ... WHERE claim = $토큰`으로 주인만 이벤트, 사용량, 상태를 쓴다. 토큰을 잃은 실행은 조용히 멈춘다. `DONE`과 `FAILED`는 덮어쓰지 않는다. 프로덕션에서 `completion`이 없으면 로컬 스텁 문장을 저장하지 않고 스텝을 재시도한다. `ai_usage`는 잡과 용도마다 한 행이다. 메시지를 큐에 넣는 HTTP 요청은 LangGraph를 컴파일하지 않는다. 컴파일은 Workflow 스텝 안에서 노드 함수를 처음 부를 때 일어난다.

`POST /api/v1/conversations/:id/messages`는 대화 확인, `chat_jobs` 삽입, 사용자 메시지 삽입, 상태 이벤트 `대기 중`을 한 문으로 처리한 뒤 Workflow만 예약하고 바로 `202`를 돌려준다. 사용자 메시지 id는 잡 id로 정해져 재시도해도 한 행이다. 거절된 요청(도메인 오류)은 그 행을 지운다. persist는 그 행에 첨부 파일과 operation id를 채우고, 새로 넣는 것은 어시스턴트 답장뿐이다. 본문은 `status: QUEUED`와 `result.value.jobId`다. 모델 호출이 끝날 때까지 기다리지 않는다. SSE는 그 `대기 중`을 202 직후에 볼 수 있고, 토큰은 generate 스텝이 흘리는 동안 `chat_events`에 쌓인다. 완료된 operation은 `POST .../messages/stream`과 `GET .../messages/stream/active`로 받는다. 큐에 넣는 요청의 멱등 키는 코어 Worker가 처리한다. 스트림과 사용량 기록은 Python에 남는다. 인증은 액세스 토큰과 사용자를 한 조회로 읽는다.

Neon 연결은 요청마다 따로 연다. isolate에 소켓 하나를 두지 않는다. fetch, 크론, Workflow 스텝이 끝나면 그 연결만 닫는다. 그래서 동시에 들어온 요청이 서로의 WebSocket을 갈아끼우지 않는다. 무료 플랜은 isolate에서 밖으로 나가는 연결이 동시에 6개다. 그 한도는 그대로다.

속도 제한은 사용자 600회/분, 공개 경로 60회/분이고 Neon `rate_limits` 한 행을 원자적으로 올린다. 이미 한도에 닿은 요청은 `hits < limit` 조건 때문에 카운터를 더 올리지 않는다. 같은 행은 잠기므로 한 버킷이 한도를 넘겨 증가하지 않는다. isolate가 그 분이 가득 찬 것을 본 뒤에는 같은 키를 다시 쓰지 않는다. isolate 메모리만 쓰면 프로세스가 나뉘었을 때 한도가 배로 늘었다. Cloudflare Rate Limiting 바인딩은 colo마다 따로 세고 Workers 무료 플랜 포함 기능이 아니며 Python Worker에서 호출할 수 없다. Durable Objects SQLite는 무료 플랜에 있지만 호출마다 무료 요청 한도를 쓰고 Python 바인딩이 더 필요하다. Neon은 두 Worker가 이미 연결한 저장소라 격리와 지역을 넘어 같은 카운터를 쓴다. 창은 UTC 1분이다. 분 경계에서는 한도가 한 번 더 허용될 수 있다. 프런트 Worker의 인증된 GET은 할당량이 없으면 사용자 조회와 1건부터 커지는 선점을 SQL 한 문으로 보낸다. 선점 상한은 8이고, 읽기 상한 근처에서는 `(상한 - hits) / 16`보다 크게 받지 않는다. 읽기 상한은 공유 한도의 90%다. 쓰지 않은 수는 응답 뒤 `waitUntil` 한 번으로 모아 돌려준다. 남은 수가 1이고 카운터가 읽기 상한에서 멀면 그 조회는 생략한다. 그 문은 `hits`를 한도 위로 올리지 않는다. `GET /conversations`, `GET /conversations/:id/messages`, 활성 SSE의 첫 조회, 모델 카탈로그 캐시 미스는 그 문에 목록까지 붙일 수 있다. 할당량이 남아 있으면 목록과 메시지는 데이터만 Neon에서 읽고, `/auth/me`와 캐시에 있는 카탈로그는 Neon을 건너뛴다. 모델과 채용 사이트의 Cache API가 맞고 인증 캐시와 할당량도 있으면 Neon은 0번이다. `GET /healthz`는 DB를 타지 않는다. `GET /api/v1/healthz`는 공개 카운터만 Neon에 기록한다. 테이블이 아직 없으면 그 요청만 isolate 메모리로 세고, 다음 요청에서 Neon을 다시 시도한다. 스키마는 `db/migrations/0015_rate_limits.sql`이고 배포가 적용하지 않는다. 수동 마이그레이션을 한 번 돌린 뒤부터 공유 한도가 켜진다. 만료된 분은 Python Worker의 크론이 지운다.

게이트웨이 Worker `services/gateway/wrangler.jsonc`는 `"triggers": {"crons": []}`를 둔다. 이 이름(`push-be`)에 남아 있던 분당 크론은 배포만으로는 지워지지 않고, 스케줄 함수가 없는 Worker를 매일 약 1,440번 호출했다. 빈 목록이 그 트리거를 지운다. Python Worker `push-be-python`의 `* * * * *`는 그대로다. 코어 Worker는 `15 * * * *`에 북마크 공고 마감 3일 전 알림과 `remind_at`이 지난 일정 알림을 만든다. `INTERNAL_JOB_TOKEN`이 없으면 그 호출은 503이다.

### 6. GitHub Actions

`.github/workflows/ci.yml`이 테스트를 돌리고, 그 테스트가 통과한 뒤 Workers에 배포한다. 러너는 GitHub 무료 분량의 `ubuntu-latest`다. `actions/checkout`와 `actions/setup-python`은 존재하는 메이저 태그 `v7`에, `actions/setup-node`는 `v6`에 고정한다. `astral-sh/setup-uv`는 떠 있는 `v10` 태그가 없어서 `v10.3.0`에 고정한다. pip, npm, uv 캐시를 쓴다.

- **CI** — pull request, 그리고 `develop`와 `main` push에서 바뀐 서비스만 돌린다. `services/ai`는 `python -m pytest`(Postgres 16), `services/gateway`와 `services/core-api`는 `npm test`와 `tsc --noEmit`, `db`는 pgvector에 `services/ai/scripts/migrate.py`를 적용한다. 같은 워크플로가 Python, 코어, 게이트웨이의 `wrangler deploy --dry-run`을 확인한다. Python 번들에 `.venv`가 들어 있거나 40 MiB를 넘으면 배포로 넘어가지 않는다. `main` 푸시는 경로와 상관없이 이 검사를 모두 돌린다.
- **CD** — push가 `main`일 때만 배포한다. 순서는 `push-be-python`, `push-be-core`, `push-be`다. 배포 브랜치를 바꾸려면 저장소 Actions 변수 `DEPLOY_BRANCH`를 설정한다. 변수가 없으면 `main`이다. 그 브랜치가 `develop`나 `main`이 아니면 `on.push.branches`에도 추가한다.

배포 잡은 코드와 wrangler vars만 올린다. `pywrangler secret put` / `wrangler secret put`은 호출하지 않고, KV 네임스페이스도 만들지 않는다. Worker에 이미 넣어 둔 런타임 시크릿은 배포를 거듭해도 그대로다.

프런트 Worker(`push-be`)와 코어 Worker(`push-be-core`)에 `DATABASE_URL`이 필요하다. 둘 다 Neon HTTP(`@neondatabase/serverless`)를 쓴다. 코어는 연동 OAuth 토큰을 암호화하므로 `BYOK_MASTER_KEY`도 필요하다. 이름은 예전 그대로다. 저장소 시크릿 `DATABASE_URL`과 `BYOK_MASTER_KEY`가 있으면 CD가 `wrangler secret put`으로 코어에 넣는다. 없으면 기존 Worker 시크릿을 덮어쓰지 않으니 첫 배포 뒤에 직접 넣는다.

```bash
printf '%s' "$DATABASE_URL" | npx wrangler secret put DATABASE_URL --name push-be-core
printf '%s' "$BYOK_MASTER_KEY" | npx wrangler secret put BYOK_MASTER_KEY --name push-be-core
```

OAuth와 Stripe 시크릿(`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ULTRA`, `STRIPE_PRICE_EMPLOYER_BASIC`, `STRIPE_PRICE_EMPLOYER_PRO`, `STRIPE_PRICE_EMPLOYER_ULTRA`, `STRIPE_PRICE_TOPUP`, `IAP_PRODUCT_PRO`, `IAP_PRODUCT_ULTRA`, `IAP_PRODUCT_TOPUP`, `IAP_TOPUP_CREDITS`, `APPLE_IAP_KEY`, `GOOGLE_PLAY_KEY`, `GOOGLE_PLAY_PACKAGE`)도 코어에 둔다. 비어 있으면 해당 기능은 Python과 같이 `NOT_CONFIGURED`다. 이름이 같은 게이트웨이 Worker를 덮어쓰면 기존 `push-be`의 `DATABASE_URL`이 남는다.

Python Worker 이름은 `push-be-python`으로 바뀐다. 시크릿은 Worker 이름에 붙어 있으므로 새 이름에는 자동으로 복사되지 않는다. CD는 값을 가지고 있지 않아 복사하지 않는다. 첫 배포 전에 기존 `push-be`와 같은 시크릿을 `push-be-python`에 한 번 넣는다. `DATABASE_URL`, `OPENROUTER_API_KEY`, 그리고 쓰던 `OPENAI_API_KEY`, `OPENCODE_GO_API_KEY`, `BYOK_MASTER_KEY`, OAuth, Stripe, `CF_API_TOKEN`이 대상이다.

```bash
printf '%s' "$DATABASE_URL" | npx wrangler secret put DATABASE_URL --name push-be-python
printf '%s' "$OPENROUTER_API_KEY" | npx wrangler secret put OPENROUTER_API_KEY --name push-be-python
```

GitHub 저장소 시크릿 (Settings → Secrets and variables → Actions):

| 이름 | 쓰임 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 배포에 필수. Workers Scripts를 편집할 수 있는 API 토큰 |
| `CLOUDFLARE_ACCOUNT_ID` | 배포에 필수. Cloudflare 계정 ID |
| `DATABASE_URL` | 수동 마이그레이션에만 필요. Direct 호스트, `sslmode=require` |

`OPENROUTER_API_KEY`는 GitHub 시크릿으로 두지 않는다. Worker 시크릿으로 한 번 넣으면 된다.

마이그레이션은 배포에 붙이지 않았다. 스키마 변경은 코드 푸시와 별개로 Neon을 바꾸고, 잘못된 SQL이 매 배포마다 적용되면 코드보다 되돌리기 어렵다. Actions 탭에서 **Migrate database**를 직접 실행한다. 기본 전송은 websocket(`wss://<direct-host>/v2`)이고, 5432가 열리면 입력에서 tcp를 고른다. 이 작업은 `services/ai/scripts/migrate.py`만 돌리고 Worker 시크릿은 갱신하지 않는다.
