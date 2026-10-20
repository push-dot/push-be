# AI 서비스를 Hostinger KVM 2에 올리기

대상은 Ubuntu VPS (2 vCPU / 8 GB)다. Dokploy가 Docker와 Traefik을 맡는다. Cloudflare Worker 기본 경로는 바꾸지 않는다. `AI_ORIGIN`이 비어 있으면 게이트웨이는 지금처럼 `push-be-python` 서비스 바인딩으로 보낸다.

## 준비

1. Hostinger에서 KVM 2를 만들고 Ubuntu를 설치한다.
2. Dokploy를 설치한다. Dokploy가 Docker와 Traefik을 같이 띄운다.
3. AI 호스트 이름(예: `ai.example.com`)의 A 레코드를 이 VPS로 보낸다.
4. Neon에 `db/migrations/0017_rag_chunks.sql`까지 직접 적용한다. 컨테이너는 `RUN_MIGRATIONS=0`이라 기동 때 스키마를 바꾸지 않는다. `AI_FRAMEWORK`는 `legacy`로 둔다.
5. `services/ai/scripts/seed_local.py`는 `APP_ENV=development`가 아니면 종료한다. 프로덕션에서 실행하지 않는다.

## Dokploy

1. Compose 앱을 만들고 이 저장소의 `infra/vps/compose.yaml`을 지정한다. 빌드 컨텍스트는 `services/ai`다.
2. `infra/vps/env.example`의 키를 Dokploy 환경 변수로 넣는다. 값은 커밋하지 않는다.
3. `DATABASE_URL`은 Neon TCP (`sslmode=require`). `DB_DRIVER=asyncpg`를 유지한다. 호스트가 `neon.tech`여도 이 값이 있으면 Neon 와이어 드라이버로 바뀌지 않는다.
4. `AI_SHARED_SECRET`에 긴 임의 문자열을 넣는다. `AI_HOST`는 Traefik `Host()` 규칙에 쓰인다.
5. 배포 후 `https://<AI_HOST>/healthz`가 `{"data":{"status":"ok"}}`를 반환하는지 본다. 그 외 경로는 `x-push-ai-secret`이 없으면 401이다.

## 게이트웨이

Cloudflare 대시보드에서 Worker `push-be`에만 다음을 넣는다. `wrangler.jsonc`는 수정하지 않는다.

| 변수 | 값 |
| --- | --- |
| `AI_ORIGIN` | `https://<AI_HOST>` (끝 슬래시 없음) |
| `AI_SHARED_SECRET` | VPS와 같은 값 |

게이트웨이는 `API`로 분류된 요청만 이 오리진으로 보내고, 헤더 `x-push-ai-secret`을 붙인다. 두 변수를 지우면 다시 `push-be-python` 바인딩을 쓴다.

## 컨테이너가 하는 일

- FastAPI + uvicorn, 포트 8080, 비루트 uid 10001
- Playwright Chromium (`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`)
- `CHAT_EXECUTOR=local`이라 `chat_jobs`를 `FOR UPDATE SKIP LOCKED`로 집어 프로세스 안에서 처리한다. `CF_WORKER`와 `CHAT_EXECUTOR=workflow`는 설정하지 않는다.
- `CHECKPOINTER=postgres`는 `langgraph-checkpoint-postgres`를 쓴다.
- 이미지 업로드는 `/data/sources/images`에 저장한다. 볼륨 이름은 `ai-data`다. R2로 바꿀 자리에는 `shortcut: local disk, swap to R2 at deploy` 주석이 있다.

메모리 한도는 6 GB, Chromium용 `/dev/shm`은 1 GB다.
