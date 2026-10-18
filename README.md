<h1 align="center">Push BE</h1>

<p align="center">
  <strong>근거 기반 커리어 문서를 단계별 게이트로 생성하는 AI 워크플로 백엔드</strong>
</p>

<p align="center">
  Python 3.13 · FastAPI · LangGraph · PostgreSQL 16 + pgvector · asyncpg
</p>

---

**push-be**는 Push의 API 서버다. 채팅 요청을 `chat_jobs` 큐에 넣고 워커가 LangGraph 워크플로를 실행하며, 각 Phase는 구조적 interrupt 게이트로 사용자 승인을 기다린다. 토큰은 `chat_events`를 통해 SSE로 스트리밍되고, 클라이언트가 끊겨도 이벤트가 DB에 남아 재연결할 수 있다.

## 핵심 설계

- **단계 게이트 워크플로** — `app/graph/chat.py`의 LangGraph가 Phase 0–6을 실행하고, 각 게이트에서 interrupt로 멈춰 사용자 입력을 받는다. 모델 재량이 아니라 구조로 진행을 통제
- **내구 큐 + 워커** — `chat_jobs` 테이블 + `FOR UPDATE SKIP LOCKED` 워커. 서버가 재시작돼도 잡이 PENDING으로 돌아가 재실행
- **재연결 가능한 SSE** — `GET /conversations/{id}/messages/stream/active`가 진행 중 잡의 이벤트를 처음부터 재생해 이탈→복귀해도 스트림 복원
- **근거 RAG** — evidence를 청킹·임베딩해 pgvector로 top-k 검색 후 프롬프트 주입
- **역할별 모델 라우팅** — `AIGate`가 generate/research/임베딩 역할별로 다른 모델을 호출. 관리형 모델과 BYOK 모두 지원
- **문서 파이프라인** — 생성 산출물을 `내 서류` 문서 버전으로 동기화하고 PDF(ReportLab)·DOCX(직접 zip+XML)로 렌더링
- **지원 항목 자동 연결** — 공고 URL 감지 시 JobPosting + Application을 생성(또는 `source_url`로 중복 제거)하고 대화에 링크
- **A/B 실험** — `EXPERIMENTS` env로 시드, 사용자별 결정적 배정과 이벤트 집계
- **요청 상관키** — 미들웨어가 `x-request-id`를 수신·생성·에코하고 `http_request` JSON 로그에 `requestId`·`statusCode`·`durationMs`를 남김

## 아키텍처

```
POST /messages/stream ──► chat_jobs INSERT ──► SSE (job_id 구독)
                                │
                     워커: FOR UPDATE SKIP LOCKED
                                │
                     LangGraph 실행 → chat_events 기록
                     (토큰/상태/done, interrupt 게이트)
                                │
                     PostgreSQL: conversations, messages,
                     evidence(+pgvector), jobs, applications,
                     documents, chat_jobs, chat_events
```

계층은 Presentation(라우터·스키마) → Domain(서비스·상태기계) → Infrastructure(DB·외부 API 클라이언트) 방향으로만 의존한다.

## Cloudflare Workers + Neon 배포

로컬 `uvicorn`은 그대로다. `docker compose`의 Postgres(5434)와 `asyncpg`, 상주 `chat_jobs` 루프, 파일시스템 산출물, 토큰 스트리밍을 쓴다. Cloudflare 무료 Workers에 올릴 때는 같은 FastAPI 앱을 Pyodide Python Worker로 실행하고, DB는 Neon 무료 플랜에 둔다.

### 선택한 구조

FastAPI와 LangGraph를 Python Worker(`src/worker.py`, `workers.asgi`)에 남겼다. 라우터·도메인·그래프를 TypeScript로 다시 쓰지 않는다.

Neon 접속은 앱의 대화형 트랜잭션(`db.run` / `db.do`)을 지키기 위해 Postgres 와이어 프로토콜 클라이언트(`app/pgproto.py`)를 쓴다.

- 노트북에서 마이그레이션: TCP + TLS (`PG_TRANSPORT=tcp`, `sslmode=require`)
- Worker: WebSocket `wss://<host>/v2` (`PG_TRANSPORT=websocket`). 프레임은 Neon 서버리스 드라이버와 같고, TLS 안의 Postgres는 평문이다

Hyperdrive는 무료 플랜(쿼리 10만/일)에 포함되지만 클라이언트가 node-postgres / postgres.js다. Python Worker는 `asyncpg`·`psycopg` 네이티브 확장을 로드하지 못한다. Neon의 HTTP `/sql`은 한 요청 안의 비대화형 배치만 받는다. 둘 다 이 앱의 트랜잭션 형태와 맞지 않아 와이어 클라이언트를 택했다.

채팅 잡은 요청이 끝나면 사라지는 Worker 안에서 `FOR UPDATE SKIP LOCKED` 루프를 돌리지 않는다. Cloudflare Workflow `ChatWorkflow`가 `claim` → `resolve_context` → `generate_reply` → `persist`를 스텝으로 나눈다. 스텝마다 무료 플랜 CPU 10ms가 새로 주어진다. I/O(LLM, Neon, DNS) 대기 시간은 CPU에 포함되지 않는다. 크론 `* * * * *`가 남아 있는 PENDING 잡을 `nudge_pending`으로 다시 깨운다. 큐는 컨슈머 호출 하나에 CPU 예산이 하나라 스텝 분리에 쓰지 않았다.

### Workers에서 바뀌는 동작

| 영역 | 로컬 | Workers |
| --- | --- | --- |
| DB 드라이버 | `asyncpg` | `app/pgproto.py` (Neon WebSocket) |
| 잡 실행 | 프로세스 안 루프, 토큰 스트리밍 | Workflow 스텝, `LLM_STREAM=0` |
| 체크포인터 | `langgraph-checkpoint-postgres` | `MemorySaver` + `chat_jobs.checkpoint` |
| SSE | 폴링 최대 1500 | 폴링 최대 20, `retry: 400`, `id` / `Last-Event-ID` |
| 파일 | `./data/sources`, 워크스페이스 파일 | `sources.content`, `workspace_files` |
| PDF 텍스트 | opendataloader-pdf (실패 시 pypdf) | pypdf |
| PDF 렌더 | ReportLab | ReportLab이 없으면 CID PDF (HYGothic-Medium, 폰트 미포함) |
| DOCX | zip+XML | 동일 |
| 페이지 수집 | IP 고정 httpx, 짧으면 Playwright | HTTPS + DNS-over-HTTPS, 짧으면 Browser Rendering |
| 암호 | AES-256-GCM (순수 Python, `cryptography`와 동일 포맷) | 동일 |

`LLM_STREAM=0`은 완성 응답을 한 번 받은 뒤 48자 단위로 `chat_events`에 토큰 이벤트를 넣는다. 글자가 나오는 순간의 라이브 스트림은 로컬에만 있다. 클라이언트는 `retry: 400`과 `id:`를 보고 `GET /conversations/{id}/messages/stream/active?after=` 또는 `Last-Event-ID`로 이어서 재생한다.

BYOK 키는 `BYOK_MASTER_KEY`가 있으면 잡 payload에 암호화해 넣고, Workflow 파라미터로도 넘긴다. 크론이 마스터 키 없이 재시도하면 그 키는 복호화되지 않는다.

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

pgvector는 모든 Neon 플랜에 있다. `migrations/0009_evidence_vectors.sql`이 `CREATE EXTENSION IF NOT EXISTS vector;`를 실행한다. SQL Editor에서 미리 켜도 된다.

### 2. 마이그레이션

Worker 안에서 마이그레이션을 돌리지 않는다. CPU 한도와 매 콜드 스타트 실행을 피하기 위해 `RUN_MIGRATIONS=0`이다. `develop`나 `main`에 푸시해도 스키마는 바뀌지 않는다. 5432로 나가는 노트북에서 실행하거나, Actions의 **Migrate database**를 수동 실행한다.

기본 전송은 TCP다. 나가는 5432가 막혀 있으면 `PG_TRANSPORT=websocket`으로 Neon의 `wss://<host>/v2`를 쓴다. 프로토콜은 같고, 호스트는 여전히 pooler가 아닌 Direct다.

```bash
PG_TRANSPORT=websocket \
DATABASE_URL='postgresql://USER:PASSWORD@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require' \
  python scripts/migrate.py
```

```bash
pip install -e ".[local]"
DATABASE_URL='postgresql://USER:PASSWORD@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require' \
  python scripts/migrate.py
```

`migrations/`의 `0001`–`0014`가 순서대로 적용된다. `0014_workers_blobs.sql`은 `chat_jobs.checkpoint`, `sources.content`, `workspace_files`를 추가한다.

### 3. 시크릿

`wrangler.jsonc`의 `vars`는 비밀이 아닌 기본값이다 (`DB_DRIVER=neon`, `PG_TRANSPORT=websocket`, `CHAT_EXECUTOR=workflow`, `LLM_STREAM=0`, `BLOB_STORE=db`, `SSE_MAX_POLLS=20`, `RUN_MIGRATIONS=0`). `DATABASE_URL`은 vars에 넣지 않는다.

[uv](https://docs.astral.sh/uv/)로 Workers 도구를 설치한 뒤 시크릿을 넣는다.

```bash
uv sync --group dev
printf '%s' 'postgresql://USER:PASSWORD@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require' \
  | uv run pywrangler secret put DATABASE_URL
uv run pywrangler secret put OPENROUTER_API_KEY
```

`wrangler`가 PATH에 있으면 같은 설정으로 `wrangler secret put DATABASE_URL`, `wrangler deploy`를 실행해도 된다. Python 의존성 번들은 `pywrangler`가 맞춘다.

| 이름 | 필요 |
| --- | --- |
| `DATABASE_URL` | 필수. Direct 호스트, `sslmode=require` |
| `OPENROUTER_API_KEY` | 관리형 모델. `OPENAI_API_KEY`와 하나 이상 |
| `OPENAI_API_KEY` | OpenAI 호환 관리형 호출을 쓸 때 |
| `OPENCODE_GO_API_KEY` | OpenCode Go 모델을 쓸 때 |
| `BYOK_MASTER_KEY` | 저장된 BYOK를 재시도·크론에서 복호화할 때 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google 로그인 |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub 로그인 |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | 결제 |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ULTRA` | Pro/Ultra 가격 ID |
| `DEV_AUTH_TOKEN`, `DEV_USER_ID` | 개발 인증. 프로덕션에서는 비운다 |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | Browser Rendering. 없으면 정적 추출만 |
| `EXPERIMENTS` | JSON. 5 KB를 넘으면 시크릿으로 둔다. 예시 값은 `.env.example`에 있다 |

`AI_BASE_URL`, Stripe 리다이렉트 URL, `GOOGLE_GMAIL_BETA_ENABLED`는 `wrangler.jsonc` vars다.

### 4. 로컬 개발

asyncpg 경로:

```bash
docker compose up -d
pip install -e ".[local,test]"
# .env.example 을 .env 로 복사. DATABASE_URL 은 localhost:5434
python scripts/migrate.py
uvicorn app.main:app --port 8080
```

Workers 런타임 (`wrangler dev`). 시크릿은 `.dev.vars` 또는 이미 넣은 Worker 시크릿을 쓴다. `.dev.vars`는 커밋하지 않는다.

```bash
uv sync --group dev
uv run pywrangler dev
# wrangler dev 도 동일하다
```

테스트:

```bash
pip install -e ".[local,test]"
python -m pytest
```

### 5. 배포

```bash
uv run pywrangler deploy
# 또는 wrangler deploy
```

엔트리포인트는 `src/worker.py`다. `pywrangler`는 그 파일이 있는 `src/`만 올리고, 저장소 루트의 `.venv`와 `.venv-workers`는 번들에 넣지 않는다. 루트에 엔트리를 두면 가상환경까지 올라가 `multipart: message too large`로 배포가 실패한다. 이력서 지시문 `app/resources/**/*.md`는 `wrangler.jsonc`의 Data 규칙으로 같이 올라가고, Worker 안에서는 `Path(__file__)`로 읽는다.

배포된 주소는 `https://push-be.<account>.workers.dev` 형태다. `workers_dev`가 켜져 있다.

### 6. GitHub Actions

`.github/workflows/ci.yml`이 테스트를 돌리고, 그 테스트가 통과한 뒤 Workers에 배포한다. 러너는 GitHub 무료 분량의 `ubuntu-latest`다. `actions/checkout`와 `actions/setup-python`은 존재하는 메이저 태그 `v7`에 고정한다. `astral-sh/setup-uv`는 떠 있는 `v10` 태그가 없어서 `v10.3.0`에 고정한다. pip와 uv 캐시를 쓴다.

- **CI** — pull request, 그리고 `develop`와 `main` push에서 `python -m pytest`를 실행한다. Postgres 16 서비스가 와이어 프로토콜 테스트까지 포함한다. 같은 워크플로가 `pywrangler deploy --dry-run`으로 번들 크기를 확인하고, `.venv`가 들어 있거나 40 MiB를 넘으면 배포로 넘어가지 않는다.
- **CD** — push가 `main`일 때만 `uv run pywrangler deploy`를 실행한다. 배포 브랜치를 바꾸려면 저장소 Actions 변수 `DEPLOY_BRANCH`를 설정한다. 변수가 없으면 `main`이다. 그 브랜치가 `develop`나 `main`이 아니면 `on.push.branches`에도 추가한다.

배포 잡은 코드와 `wrangler.jsonc`의 vars만 올린다. `pywrangler secret put` / `wrangler secret put`은 호출하지 않는다. Worker에 이미 넣어 둔 `DATABASE_URL`, `OPENROUTER_API_KEY` 같은 런타임 시크릿은 배포를 거듭해도 그대로다.

GitHub 저장소 시크릿 (Settings → Secrets and variables → Actions):

| 이름 | 쓰임 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 배포에 필수. Workers Scripts를 편집할 수 있는 API 토큰 |
| `CLOUDFLARE_ACCOUNT_ID` | 배포에 필수. Cloudflare 계정 ID |
| `DATABASE_URL` | 수동 마이그레이션에만 필요. Direct 호스트, `sslmode=require` |

`OPENROUTER_API_KEY`는 GitHub 시크릿으로 두지 않는다. Worker 시크릿으로 한 번 넣으면 된다.

마이그레이션은 배포에 붙이지 않았다. 스키마 변경은 코드 푸시와 별개로 Neon을 바꾸고, 잘못된 SQL이 매 배포마다 적용되면 코드보다 되돌리기 어렵다. Actions 탭에서 **Migrate database**를 직접 실행한다. 이 작업은 `scripts/migrate.py`만 돌리고 Worker 시크릿은 갱신하지 않는다.
