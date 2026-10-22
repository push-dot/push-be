# AI 서비스를 Hostinger KVM 2에 올리기

대상은 Ubuntu VPS (2 vCPU / 8 GB)다. Dokploy가 Docker와 Traefik을 맡는다. `AI_ORIGIN`이 비어 있으면 게이트웨이는 지금처럼 `push-be-python` 서비스 바인딩으로 보낸다.

## 준비

1. Hostinger에서 KVM 2를 만들고 Ubuntu를 설치한다.
2. Dokploy를 설치한다. Dokploy가 Docker와 Traefik을 같이 띄운다.
3. AI 호스트 이름(예: `push.devcyjoon.tech`)과 디스패처 호스트 이름(`DISPATCH_HOST`)의 A 레코드를 이 VPS로 보낸다.
4. Neon에 `db/migrations/0024_vectors_1024.sql`까지 직접 적용한다. 컨테이너는 `RUN_MIGRATIONS=0`이라 기동할 때 스키마를 바꾸지 않는다.
   적용한 뒤 VPS 디스크의 업로드 파일을 DB로 옮긴다. 게이트웨이가 업로드·이미지 경로를 core로 보내기 전에 한 번 실행한다. 다시 실행해도 안전하다.
   ```bash
   docker compose exec ai-worker python scripts/migrate_blobs_to_db.py
   ```
5. `services/ai/scripts/seed_local.py`는 `APP_ENV=development`가 아니면 종료한다. 프로덕션에서 실행하지 않는다.

## Dokploy

1. Compose 앱을 만들고 이 저장소의 `infra/vps/compose.yaml`을 지정한다. 빌드 컨텍스트는 `services/ai`다.
2. `infra/vps/env.example`의 키를 Dokploy 환경 변수로 넣는다. 값은 커밋하지 않는다.
3. `DATABASE_URL`은 Neon TCP (`sslmode=require`)다. `DB_DRIVER=asyncpg`를 유지한다.
4. `AI_SHARED_SECRET`, `REDIS_PASSWORD`, `DISPATCH_SECRET`, `ADMIN_TOKEN`에 서로 다른 긴 임의 문자열을 넣는다.
5. 배포한 뒤 두 주소를 확인한다.
   - `https://<AI_HOST>/healthz` → `{"data":{"status":"ok"}}`
   - `https://<DISPATCH_HOST>/healthz` → `{"ok":true}`

## 컨테이너와 메모리

KVM 2는 8,192 MB다. Dokploy, Traefik, 다른 앱이 이미 1.6–2.0 GB를 쓴다. 그래서 이 compose의 한도 합계를 5,056 MB로 맞췄다. 2.0 GB를 빼도 1 GB 이상이 남는다.

| 서비스 | 하는 일 | 한도 |
| --- | --- | --- |
| `ai-worker` | `q:chat:priority` → `q:chat` → `q:document` 순서로 읽는다. 채팅, 기업 AI, 서류 생성, 공고 적합도를 처리한다. `SERVE_API=1`이라 core로 아직 옮기지 않은 Python 경로(임시 `ai-api`)도 같은 프로세스에서 받는다 | 1,280 MB |
| `ingest-worker` | `q:ingest`. 업로드, 링크, GitHub, 공고를 잘라 `rag_nodes`에 색인한다 | 512 MB |
| `dispatcher` | outbox를 Redis Streams로 넘기고, 지연 큐를 승격하고, 멈춘 작업을 되돌린다. `/internal/kick`, `/admin/*`, 경보, 30일 보관 정리를 맡는다 | 128 MB |
| `notify-worker` | `q:notify`. 알림 행을 쓰고 Expo 푸시를 보낸다 | 128 MB |
| `redis` | 큐, 속도 제한, 락, 임베딩 캐시. 외부 포트가 없고 `push-internal` 네트워크에서만 열린다. AOF `everysec`과 RDB 스냅샷을 쓴다. `maxmemory 128mb`, `volatile-lru`라서 TTL이 있는 임베딩 캐시만 밀려나고 큐 데이터는 남는다 | 192 MB |
| `embed` | TEI `BAAI/bge-m3` (1024차원). 가중치만 약 2.3 GB라서 `--max-batch-tokens 2048`, `--max-concurrent-requests 8`로 활성 메모리를 줄였다 | 2,816 MB |
| 합계 | | 5,056 MB |

스펙 6장의 예산(합계 7.3 GB)은 Dokploy가 쓰는 메모리를 빼지 않은 값이라 이렇게 바꿨다.

- 임시 `ai` 컨테이너(512 MB)를 없앴다. `ai-worker`가 같은 앱을 함께 띄운다.
- `rerank`(TEI `bge-reranker-v2-m3`)는 기본으로 띄우지 않는다. 이 모델도 가중치가 약 2.3 GB라 5 GB 안에 들어가지 않는다. 재정렬은 `RERANK_PROVIDER=similarity`(기본값)로 임베딩 코사인 유사도를 쓴다. 쓰려면 `EMBEDDING_PROVIDER=api`로 바꿔 `embed`를 멈추거나 VPS를 올린 뒤 `docker compose --profile rerank up -d rerank`를 실행하고 `RERANK_PROVIDER=tei`를 넣는다.
- `embed`가 메모리 부족으로 재시작되면 `EMBEDDING_PROVIDER=api`로 바꾸고 `embed`를 멈춘다. 그러면 합계가 2,240 MB로 줄어든다.

배포한 뒤 `docker stats`로 실제 사용량을 확인한다.

## 전환과 되돌리기

| 변수 | 값 | 되돌리기 |
| --- | --- | --- |
| `QUEUE_BACKEND` | `redis` | `postgres`로 바꾸면 `ai-worker`의 API 프로세스가 다시 `chat_jobs`를 직접 처리한다. core에도 같은 값을 넣는다 |
| `EMBEDDING_PROVIDER` | `tei` | `api`로 바꾸면 OpenAI 호환 `/embeddings`(1024차원)를 쓴다 |
| `RERANK_PROVIDER` | `similarity` | `tei`는 `rerank` 프로필을 띄웠을 때만 쓴다 |
| `RAG_ENGINE` | `legacy` | `run_eval.py` 결과가 기준선보다 낮지 않을 때만 `llamaindex`로 바꾼다 |

`RAG_ENGINE=llamaindex`로 바꾸기 전에 `q:ingest`에 `{"reindex": true}` 작업을 넣어 기존 업로드를 `rag_nodes`에 색인한다.

## 처리량 측정

`embed`가 뜬 뒤 컨테이너 안에서 측정한다. 업로드 1건(청크 60개)을 30초 안에 색인하는 것이 목표다.

```bash
docker compose exec ingest-worker python scripts/bench_embed.py
docker compose exec ingest-worker python eval/rag/run_eval.py --engine llamaindex
```

`meetsTarget`이 `false`면 VPS를 올리거나 `EMBEDDING_PROVIDER=api`를 기본으로 둔다.

## 관리 엔드포인트

디스패처 호스트에서 `Authorization: Bearer <ADMIN_TOKEN>`으로 부른다.

| 요청 | 결과 |
| --- | --- |
| `GET /admin/queue/stats` | 스트림별 `{length, oldestAgeSec, pending}`, 작업 종류별 24시간 `{waitP50, waitP95, runP50, runP95, failRate, dead}`, `neon:{dbSizeBytes, ragNodes}` |
| `GET /admin/jobs?status=DEAD` | 작업 목록 (최대 200건) |
| `POST /admin/jobs/{id}/retry` | `DEAD`·`FAILED` 작업을 `QUEUED`로 되돌리고 크레딧을 다시 예약한다 |
| `POST /admin/jobs/{id}/cancel` | `QUEUED`·`RETRY`·`RUNNING` 작업을 취소하고 예약을 해제한다 |
| `POST /admin/queues/{name}/pause`, `/resume` | 워커가 그 스트림을 읽지 않게 하거나 다시 읽게 한다 |

## 경보

디스패처는 1분마다 Redis만 보고, 15분 스윕 때 DB를 본다. Neon 무료 플랜이 쉬는 상태로 들어갈 수 있도록 1분 주기로는 DB에 연결하지 않는다.

| 조건 | 기준 | 주기 |
| --- | --- | --- |
| `queue_wait` | 가장 오래 기다린 메시지가 120초를 넘는다 | 1분 |
| `dead_recent` | 최근 10분 안에 `q:dead`에 들어온 작업이 있다 | 1분 |
| `heartbeat_lost` | 하트비트가 끊겨 `RETRY`로 되돌린 작업이 있다 | 15분 |
| `db_size` | DB 크기가 `NEON_STORAGE_LIMIT_BYTES`의 80% 이상이다 | 15분 |

같은 조건은 30분에 한 번만 보낸다. 조건이 풀리면 `[복구]`를 보낸다. Discord 웹훅(`DISCORD_ALERT_WEBHOOK_URL`)으로 보내고, 실패하면 Resend(`RESEND_API_KEY`)로 `ALERT_EMAIL_TO`에 메일을 보낸다. 임베딩 처리량 경보는 아직 없다. 처리량은 `bench_embed.py`로 배포 전에 잰다.

코드 밖에서 준비할 것:

1. Discord에 `#push-alerts` 채널과 웹훅을 만들어 `DISCORD_ALERT_WEBHOOK_URL`에 넣는다.
2. Better Stack 무료 업타임 체크 2개(게이트웨이 `/healthz`, `https://<AI_HOST>/healthz`)를 만들고 같은 Discord 채널에 연결한다.

## 보관 정리

15분 스윕마다 끝난 지 30일이 지난 `ai_jobs`(`DONE`, `FAILED`, `DEAD`, `CANCELLED`)를 지운다. `outbox`, `chat_events`, `credit_reservations`는 함께 지워지고, `ai_usage.job_id`는 `NULL`이 된다. 비용 기록인 `ai_usage` 행은 남는다.

## 로그와 추적

워커는 작업이 끝날 때마다 JSON 한 줄을 남긴다.

```json
{"jobId": "…", "type": "chat", "step": "done", "docIds": null, "promptHash": null, "tokensIn": null, "tokensOut": null, "latencyMs": 812}
```

`step`은 `done`, `failed`, `delayed`, `cancelled` 중 하나다. 핸들러가 `ctx.log`에 `docIds`, `promptHash`, `tokensIn`, `tokensOut`을 채우면 그 값이 들어간다.

추적 수집기는 아직 붙이지 않는다. 나중에 OpenTelemetry를 붙일 때 쓸 span 이름은 다음과 같다.

| span | 범위 |
| --- | --- |
| `queue.job/<type>` | 워커가 작업 하나를 처리하는 전체 구간 |
| `rag.ingest` | 읽기 → 자르기 → 임베딩 → 저장 |
| `rag.search` | 밀집 검색 + 키워드 검색 + 재정렬 |
| `llm.call` | 모델 호출 한 번 |

## 게이트웨이와 core

Cloudflare 대시보드에 넣는다. `wrangler.jsonc`는 수정하지 않는다.

| Worker | 변수 | 값 |
| --- | --- | --- |
| `push-be` | `AI_ORIGIN` | `https://push.devcyjoon.tech` (끝 슬래시 없음) |
| `push-be`, `push-be-core` | `AI_SHARED_SECRET` | VPS와 같은 값 |
| `push-be-core` | `QUEUE_BACKEND` | VPS와 같은 값 |
| `push-be-core` | `DISPATCH_ORIGIN` | `https://<DISPATCH_HOST>` |
| `push-be-core` | `DISPATCH_SECRET` | VPS와 같은 값 |

core는 작업을 넣고 커밋한 뒤 `DISPATCH_ORIGIN/internal/kick`을 부른다. 이 호출이 실패해도 작업은 `outbox`에 남고, 다음 15분 스윕에서 처리된다.
