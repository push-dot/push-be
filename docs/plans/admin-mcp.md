# Admin MCP 서버

소유자의 MCP 클라이언트가 Streamable HTTP와 고정 헤더 `Authorization: Bearer <token>`으로 Push를 관리자로서 다루게 한다. 읽기는 플랫폼 통계, 사용자, 회사, 채용공고, 지원서다. 쓰기는 회사를 대신한 채용공고 생성과 상태 `OPEN` / `CLOSED` / `DRAFT` 변경뿐이다. 직접 동기는 운영 `job_postings`가 비어 있어, 어시스턴트로 공고를 넣고 상태를 바꾸는 것이다.

이 문서는 구현 계획이다. 이 브랜치는 코드를 바꾸지 않는다. 구현 브랜치는 프로덕션에 배포하지 않고, 프로덕션 시크릿을 넣지 않고, 유료 LLM을 호출하지 않고, Neon main 브랜치에 쓰지 않는다.

기준 커밋은 `develop`의 `6430ea2`다. 아래 경로는 그 트리에서 확인했다.

| 사실 | 위치 |
| --- | --- |
| npm workspaces | 루트 `package.json`: `services/gateway`, `services/core-api`, `packages/contracts`. lockfile은 루트 `package-lock.json` 하나 (lockfileVersion 3) |
| Worker | `services/core-api`, `services/gateway`. wrangler `4.158.0`, `compatibility_date` `2026-10-17`, `compatibility_flags` `nodejs_compat`, `placement` `aws:ap-southeast-1` |
| 코어는 공개 호스트가 아님 | `services/core-api/wrangler.jsonc`의 `workers_dev: false`. 게이트웨이 서비스 바인딩 `CORE`만 호출한다 |
| 게이트웨이 공개 이름 | 스크립트 `push-be`, 스테이징 `push-be-staging`. 모든 응답은 `withCors`를 거친다 (`services/gateway/src/handler.ts`) |
| 게이트웨이 라우팅 | `ownerOf`가 목록에 없는 경로를 `deny`로 두고 404를 반환한다. `/internal`은 전달하지 않는다 (`services/gateway/src/routes/owner.ts`) |
| DB | `services/core-api/src/index.ts`. 단건은 `@neondatabase/serverless` `1.2.0`의 HTTP `neon()`. 트랜잭션은 WebSocket `Client`와 `inTransaction` |
| 요청 문맥 | `Ctx` = `request`, `env`, `deps`, `rid`, `url`, `user`, `now` (`services/core-api/src/types.ts`). 실패는 `HttpError(status, code, message, details)` (`services/core-api/src/http.ts`) |
| 공고 생성 | `createPosting` (`services/core-api/src/routes/postings.ts`). `verifiedCompany`로 멤버십과 `verified_at`을 확인하고, `searchFields(title + " " + company)`로 `search_text` / `search_choseong` / `search_jamo`를 채우고, `revision` 1, `closed_at` NULL, `status`는 `DRAFT` 또는 `OPEN`(기본 `OPEN`)으로 `INSERT`한다. 이어서 `enqueueIngest`가 `ai_jobs`와 디스패처를 깨운다 |
| 공개 오픈 조건 | `openClause`: `status = 'OPEN' AND closed_at IS NULL` (`recruiting-shared.ts`) |
| 사용자용 상태 변경 | `patchPosting`은 `closed_at`이 있으면 `OPEN`을 거절한다. `closePosting`만 `CLOSED`와 `closed_at`을 쓴다. 둘 다 `expectedRevision`이 같아야 하고 `revision`을 1 올린다 |
| 기존 멱등 | `idempotency_keys.user_id`는 `users`에 대한 NOT NULL FK다 (`db/migrations/0001_init.sql`). 관리자 주체로는 재사용할 수 없다 |
| 레이트 리밋 | `services/core-api/src/ratelimit.ts`의 `allow()`. 테이블 `rate_limits` (`0015_rate_limits.sql`). KV나 Cloudflare rate limit 바인딩은 없다 |
| 배포 | `.github/workflows/ci.yml`. `develop` push는 GitHub environment `staging`, `DEPLOY_BRANCH`(기본 `main`) push는 `production`. 마이그레이션은 `.github/workflows/migrate.yml`의 `workflow_dispatch`만 적용한다 |
| 테스트 | `node --experimental-strip-types --test`. 코어는 `Deps.query` 목과 `SQL_CAPTURE` (`scripts/sql-check/register.mjs`). `test-db`가 그 SQL을 마이그레이션된 Postgres에서 `PREPARE`한다 |
| 다음 마이그레이션 번호 | `db/migrations/0052_bots.sql` 다음이 `0053` |

## 결정

| 항목 | 선택 |
| --- | --- |
| 프로세스 | 새 Worker `services/admin-mcp` (npm 이름 `push-be-admin-mcp`) |
| 도메인 재사용 | `services/core-api/src/domain/posting-write.ts`를 상대 경로로 import. 공고 INSERT와 검색 필드 계산은 이 함수만 가진다 |
| 전송 | `@modelcontextprotocol/server` `2.4.0`의 `WebStandardStreamableHTTPServerTransport`. `sessionIdGenerator: undefined`, `enableJsonResponse: true`. Durable Object 없음 |
| 스키마 | `zod` `4.6.7` (`z.object`). 서버 패키지가 의존하는 `zod` `^4.2.0`과 같은 메이저 |
| 인증 | Worker 시크릿 `ADMIN_MCP_TOKEN`. SHA-256 다이제스트 비교. 비었거나 32자 미만이면 모든 `/mcp`가 401. OAuth 없음 |
| SQL 도구 | 넣지 않는다. 아래 「버린 도구」에 이유를 적었다 |
| 쓰기 | `admin_create_posting`, `admin_set_posting_status`. 멱등 키 필수. ingest 큐는 넣지 않는다 |
| 감사 | 성공한 쓰기와 처리된 도메인 오류는 `admin_audit_log`. 요청 단위 메타데이터는 Workers 구조화 로그 |
| 배포 이름 | `push-be-admin-mcp`, `push-be-admin-mcp-staging` |
| URL | `https://push-be-admin-mcp.youngjoon568.workers.dev/mcp`, `https://push-be-admin-mcp-staging.youngjoon568.workers.dev/mcp` |

## 1. 어디에 두는가

검토한 세 자리와, 각각이 깨지는 지점은 다음과 같다.

게이트웨이 라우트로 두는 안. 게이트웨이의 `handle`은 모든 응답에 `withCors`를 붙인다. 공개 오리진은 `push-be` / `push-be-staging`이고, `ALLOWED_HEADERS`에 `authorization`이 있다. 관리자 토큰을 그 오리진에 두면 브라우저 CORS 경로와 시크릿 배포 단위가 사용자 API와 같아진다. `ownerOf`에 경로를 추가해야 전달되므로, 누락은 404, 오타난 허용은 공개 입구가 된다. 공고 INSERT도 게이트웨이에 없다.

코어 Worker의 라우트로 두는 안. 재사용은 가장 쉽다. 다만 `workers_dev: false`인 이유 그대로, 이 스크립트를 workers.dev에 올리면 `/api/v1` 전체(인증, 결제 웹훅, `internal/notifications`)가 게이트웨이의 `ownerOf`를 우회해 공개된다. workers.dev는 스크립트 단위라 `/mcp`만 열 수 없다. MCP SDK를 코어 번들에 넣으면 사용자 요청의 콜드 스타트와 `bundle-core` 한도가 관리자 기능에 묶인다. `handle` 앞단의 Bearer 분기(`services/core-api/src/handler.ts`)에 관리자 예외를 넣으면, 분기를 잘못 탔을 때 사용자 인증이 건너뛰어진다.

코어에 내부 라우트를 추가하고 서비스 바인딩으로 호출하는 안. `POST /api/v1/internal/admin/postings`를 `INTERNAL_API_SECRET`으로 잠그면 `createPosting`을 HTTP로 재사용할 수 있다. 게이트웨이는 그 경로를 오늘 `deny`한다. 이후 `isCore`에 한 줄이 들어가면 공개 게이트웨이가 관리자 쓰기를 전달한다. 또 `createPosting`은 `verifiedCompany`라서 호출자가 그 회사의 검증된 멤버여야 한다. 빈 `job_postings`를 시드하는 관리자는 그 멤버십을 갖지 않을 수 있다. 내부 라우트는 그 검사를 풀어 주는 두 번째 구현이 되고, 바인딩과 시크릿과 라우트가 함께 늘어난다.

선택: 새 Worker `services/admin-mcp`. 공개 게이트웨이와 코어 스크립트는 그대로 둔다. 이 Worker만 `workers_dev: true`다. 게이트웨이 `services` 배열과 `ownerOf`에는 넣지 않는다. 롤백은 이 스크립트와 시크릿만 대상으로 한다.

코드 공유는 워크스페이스 패키지를 새로 만들지 않고, 코어 안의 도메인 모듈을 상대 import 한다.

```ts
import { insertPosting, parsePostingWrite, setPostingStatus } from "../../core-api/src/domain/posting-write.ts";
import { queryForms } from "../../core-api/src/hangul.ts";
import { allow } from "../../core-api/src/ratelimit.ts";
import { HttpError, hashJson } from "../../core-api/src/http.ts";
import { decodeCursor, encodeCursor } from "../../core-api/src/time.ts";
import { isMissingRelation } from "../../core-api/src/db.ts";
```

`posting-write.ts`가 `searchFields`(`services/core-api/src/hangul.ts`, `es-hangul` `2.4.0`)와 지금의 `textOf` / `intOf` / `stringList` / `dateOf` / `imageKeyOf` / `httpsUrl` / `JOB_CATEGORIES` 검사를 호출한다. `createPosting`은 본문을 읽고 `verifiedCompany`를 확인한 뒤 `parsePostingWrite`와 `insertPosting`을 호출하고, 그 다음에만 기존 `enqueueIngest`를 호출한다. 관리자 도구는 `insertPosting`에서 멈춘다. ingest는 임베딩 큐(`q:ingest`)를 깨우므로 관리자 시드가 유료 임베딩이나 AI 워커를 부르지 않게 한다. 검색은 `search_text` / `search_choseong` / `search_jamo`가 INSERT에 들어가면 동작한다.

상대 import를 패키지 export로 바꾸지 않는 이유: `HttpError`와 필드 검사와 SQL이 이미 코어에 있고, `sql-check`의 `extract-ts.mjs`는 `services/core-api/tsconfig.json`의 `src/**/*.ts`를 본다. 도메인 파일을 코어 `src`에 두면 그 추출이 그대로 적용된다. `packages/`로 옮기면 검사기, tsconfig, 공개 라우트의 import를 한 번에 옮겨야 한다.

admin-mcp가 import 해도 되는 코어 파일은 위 목록뿐이다. `db.ts`에서는 `isMissingRelation`과 `Query` 타입만 쓴다. `src/index.ts`, `handler.ts`, `routes/postings.ts`, `routes/recruiting-shared.ts`는 import 하지 않는다. `recruiting-shared.ts`는 `push/notify.ts`를 최상위에서 import 하므로, 필드 검사가 그 파일에 남아 있으면 번들이 알림과 디스패처를 끌어올 수 있다. 구현 단계의 번들 검사가 `enqueueIngest`나 `q:notify`를 찾으면, 필드 검사 함수를 `services/core-api/src/domain/fields.ts`로 옮기고 `recruiting-shared.ts`와 `posting-write.ts`가 그 파일을 import 하게 한다. 동작은 같고 의존만 가늘어진다.

DB 연결은 `services/core-api/src/index.ts`의 `neonQuery` / `neonTransaction`을 관리자 Worker의 `src/db.ts`에 같은 형태로 둔다. 코어 `index.ts`를 import 하면 `scheduled`와 기본 export가 따라온다. 읽기 도구는 HTTP `neon()`. 쓰기 도구의 멱등 행, INSERT 또는 UPDATE, 감사 행은 WebSocket `Client` 하나의 트랜잭션이다. Neon HTTP는 문장마다 autocommit이라, INSERT가 성공하고 감사 insert가 실패하면 기록이 없다.

`package.json` 의존성 (정확한 버전):

```json
{
  "name": "push-be-admin-mcp",
  "private": true,
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/server": "2.4.0",
    "@neondatabase/serverless": "1.2.0",
    "es-hangul": "2.4.0",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@types/node": "22.20.5",
    "typescript": "7.0.2",
    "wrangler": "4.158.0"
  }
}
```

루트 `package.json`의 `workspaces`에 `services/admin-mcp`를 넣고, `test`와 `typecheck` 스크립트에 `-w push-be-admin-mcp`를 추가한다. lockfile은 루트에서 `npm install`로 갱신한다. 두 번째 lockfile은 만들지 않는다. `@modelcontextprotocol/core` `2.4.0`은 서버 패키지가 끌어오므로 직접 의존으로 적지 않는다. `zod`는 도구 스키마를 우리가 import 하므로 직접 의존으로 고정한다. 서버 패키지의 의존 범위는 `zod` `^4.2.0`이라 `4.6.7`과 맞다. peerDependencies는 없다 (2026-10-23 게시본 `2.4.0` 기준).

## 2. 전송과 라이브러리

검토한 라이브러리:

`agents`의 `McpAgent`. Cloudflare 예제는 Durable Object에 세션을 둔다. 스크립트 마이그레이션, DO 바인딩, 유휴 과금이 생기고, 요청마다 같은 isolate를 가정한다. 클라이언트는 세션 없이 Bearer만 보내므로 이 상태가 필요 없다.

`@modelcontextprotocol/sdk` `1.32.2` (v1 유지보수 라인). Streamable HTTP는 있으나 프로토콜은 `2025-11-25`까지고, 패키지 exports에 `workerd` 조건이 없다. v1은 2026-07-28을 넣지 않는다고 npm 페이지가 적는다.

`@modelcontextprotocol/server` `2.4.0`. v2 안정 라인이고 2026-07-28을 구현한다. `dist` exports의 `_shims`에 `workerd` 조건이 있다. 타입 주석의 Workers 예제가 `McpServer`를 요청마다 만들고 `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })`로 `fetch`의 `Response`를 반환한다. `enableJsonResponse: true`이면 SSE 대신 `application/json` 한 덩어리를 반환한다 (기본값은 SSE). `validateSession`은 `sessionIdGenerator === undefined`이면 바로 return 하므로, 이전 `initialize`를 기억하지 않아도 `tools/list`와 `tools/call`을 받는다. `maxRequestBodySize` 기본값은 4 MiB다.

`createMcpHandler`. v2의 2026-07-28 엔트리이고 기본 `legacy: 'stateless'`로 2025 Streamable HTTP도 받는다. 토큰 검사는 하지 않고 (`authInfo`는 통과만 한다), `enableJsonResponse` 옵션이 없다. SSE가 기본이면 Worker CPU 시간 동안 스트림을 붙잡는다.

선택: 요청마다 새 `McpServer`와 새 transport.

```ts
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
  maxRequestBodySize: 1_048_576,
});
await server.connect(transport);
return transport.handleRequest(request, { parsedBody });
```

서버 정보는 `{ name: "push-admin", version: "1.0.0" }`다. 도구만 등록한다. resource와 prompt는 없다.

`registerTool` 시그니처 (2.4.0 `mcp` 타입): `registerTool(name, { title, description, inputSchema, outputSchema, annotations }, callback)`. `inputSchema`는 `z.object(...)`다. 콜백 반환은 `{ content: [{ type: "text", text }], structuredContent }`다. `annotations`에 `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint: false`를 넣는다.

JSON-RPC 배치는 거절한다. 본문을 1 MiB에서 자르고 파싱한 뒤, 최상위가 배열이면 HTTP 400 `{"error":"batch not accepted"}`를 반환하고 transport에 넘기지 않는다. 한 HTTP 요청이 쓰기를 여러 번 열지 못하게 한다. 본문을 이미 읽었으므로 transport에는 `parsedBody`를 넘긴다. 크기 검사는 `parsedBody`를 넘기면 transport가 건너뛰므로, 우리가 먼저 한다.

`Accept`에는 `application/json`이 있어야 한다. 스모크와 테스트는 `Accept: application/json, text/event-stream`을 보낸다.

프로토콜 확인 지점: 인프로세스 `initialize`가 `result.protocolVersion`으로 `2025-03-26`, `2025-06-18`, `2025-11-25`, `2026-07-28` 중 하나를 반환해야 한다. 클라이언트가 2026-07-28 봉투만 보내고 이 transport가 거절하면, 인증 래퍼는 유지한 채 fetch 본문만 `createMcpHandler(factory, { legacy: "stateless" })`로 바꾼다. 그 경우에도 SSE 응답이 나오면 `enableJsonResponse`와 같은 단일 JSON 응답이 되는지 테스트를 다시 통과시켜야 한다. 첫 구현은 transport 직결이다.

`node:crypto`의 `timingSafeEqual` 대신 WebCrypto SHA-256을 쓴다. 게이트웨이 `secretEquals`(`services/gateway/src/http.ts`)와 같은 방식이라 `nodejs_compat`의 crypto 폴리필에 인증을 묶지 않는다. `nodejs_compat`는 Neon WebSocket `Client` 때문에 켠다.

## 3. 인증

시크릿 이름은 `ADMIN_MCP_TOKEN`이다. 게이트웨이, 코어, VPS `.env`에는 넣지 않는다. `ADMIN_TOKEN`(디스패처 `/admin/*`)과는 다른 값이다.

흐름:

1. `GET /healthz`만 인증 없이 200 `{"ok":true}`다. DB를 치지 않고, 시크릿 값이나 `configured` 플래그를 반환하지 않는다. 그 외 경로 중 `/mcp`가 아니면 404다.
2. `/mcp`는 `POST`만 받는다. `GET`과 `DELETE`와 `OPTIONS`는 405다. `access-control-allow-origin`을 어떤 응답에도 넣지 않는다.
3. `ADMIN_MCP_TOKEN`이 없거나, trim 한 길이가 32 미만이면 401 `{"error":"unauthorized"}`다. 서버 로그에 `kind: "admin_mcp_unconfigured"`만 남긴다. 토큰 값은 로그에 넣지 않는다.
4. `Authorization`이 `Bearer `로 시작하지 않거나 토큰이 다르면 같은 401 본문이다. 누락과 불일치를 본문으로 구분하지 않는다.
5. 비교는 양쪽 SHA-256 hex가 같을 때다. 어느 쪽이든 비어 있으면 false다. 구현은 `services/gateway/src/http.ts`의 `secretEquals`와 같은 8줄이고, 게이트웨이 모듈은 import 하지 않는다 (캐시 미들웨어가 따라온다).
6. 인증 전에 isolate 메모리로 IP당 분당 30회를 센다. 키는 `cf-connecting-ip`만 쓰고, 없으면 `"unknown"` 한 버킷이다. `x-forwarded-for`는 클라이언트가 넣을 수 있으므로 쓰지 않는다. 이 한도는 isolate 밖과 공유되지 않는다. 실제 방어는 32자 이상 임의 토큰이다.
7. 인증 뒤에 `allow(query, "admin-mcp", ip, 60, nowMs)`로 `rate_limits`에 분당 60회를 센다. 코어와 같은 분 버킷이라 추가 인프라가 없다. 초과는 429 `{"error":"rate_limited"}`다. DB가 실패하면 `allow`의 기존 메모리 폴백을 그대로 쓴다.

토큰은 사람이 `openssl rand -base64 32`로 만들어 GitHub environment 시크릿에 넣는다. 구현 에이전트는 값을 생성해 로그나 PR에 적지 않는다. OAuth, `requireBearerAuth`, `verifyBearerToken`은 쓰지 않는다. 그 API는 audience와 `WWW-Authenticate` 챌린지용이다.

## 4. 도구

공통 규칙:

- 이름 접두사는 `admin_`다. AI 워커의 `apply_to_posting`과 같은 snake_case다.
- 목록의 `limit` 기본은 20, 최대는 50이다. 커서는 코어 `encodeCursor` / `decodeCursor` (`createdAt|id`의 base64url)다. 잘못된 커서는 도구 오류 `VALIDATION_ERROR`, `details.field = "cursor"`다.
- 목록 SQL은 상수를 유지한다. 선택 조건은 `($n::uuid IS NULL OR ...)` 형태다. 문자열을 이어 붙여 WHERE를 만들지 않는다. `sql-check`가 상수로 접을 수 있어야 한다.
- `SELECT *`는 쓰지 않는다. `password_hash`, `phone`, `provider_subject`, `access_tokens`, `refresh_tokens`, `phone_codes`, `stripe_customer_id`, `notes`, `applicant_snapshot`은 SELECT 목록에 없다.
- 도구 입력 실패와 `HttpError`는 throw 하지 않고 `isError: true`와 `structuredContent: { code, message, details }`로 반환한다. SDK가 throw를 프로토콜 오류로 바꾸면 필드 정보가 사라진다.
- 읽기 도구의 annotations는 `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`다.
- 쓰기 두 개의 `idempotencyKey`는 UUID다. 없으면 `VALIDATION_ERROR`.

### 읽기

`admin_platform_stats`. 입력 `z.object({})`. 출력:

```ts
z.object({
  users: z.number().int(),
  companies: z.number().int(),
  companiesVerified: z.number().int(),
  postings: z.number().int(),
  postingsOpen: z.number().int(),
  postingsDraft: z.number().int(),
  postingsClosed: z.number().int(),
  applications: z.number().int(),
})
```

한 문장이다. `count(*)::int` 서브쿼리. open은 `status = 'OPEN' AND closed_at IS NULL`, draft는 `status = 'DRAFT'`, closed는 `status = 'CLOSED' OR closed_at IS NOT NULL`, verified는 `companies.verified_at IS NOT NULL`.

`admin_get_user`. 입력은 `id`(uuid)와 `email`(최대 320) 중 정확히 하나. `.refine`. 출력은 `id`, `displayName`, `email`, `locale`, `accountType` (`is_employer`가 참이면 `EMPLOYER`, 아니면 `PERSONAL`), `provider`, `createdAt`, `companyId`, `companyRole`. email은 `lower(u.email) = lower($1)`. 없으면 `NOT_FOUND`.

`admin_list_users`. 입력 `query` (최대 200, 선택), `limit`, `cursor`. `query`가 있으면 `display_name ILIKE` 또는 `email ILIKE`. 사용자 테이블에는 초성 컬럼이 없다.

`admin_get_company`. 입력은 `id`(uuid), `name`(1–200), `bNo`(1–20) 중 정확히 하나. 출력은 `id`, `name`, `bNo`, `verifiedAt`, `plan`, `industry`, `website`, `createdAt`, `deletionRequestedAt`, `postingCount`. `postingCount`는 `job_postings`의 `company_id` 개수다.

`admin_list_companies`. 입력 `query`, `limit`, `cursor`. `query`는 `name ILIKE` 또는 `b_no` 동등 비교다.

`admin_get_posting`. 입력 `{ id: uuid }`. 출력은 공개 DTO에 더해 `companyId`, `status`, `revision`, `closedAt`, `draftSource`, `searchText`, `searchChoseong`, `searchJamo`, `description`, `requirements`, `workConditions`, `preferred`, `createdAt`. 검색 필드를 넣는 이유는 시드 뒤 초성 컬럼이 비었는지 어시스턴트가 확인하기 위해서다. `search_text`는 `title + " " + company`라 비밀이 아니다.

`admin_list_postings`. 입력 `status` (`DRAFT` | `OPEN` | `CLOSED`, 선택), `companyId`, `query` (최대 200), `limit`, `cursor`. `openClause`를 걸지 않는다. 상태 필터가 없으면 DRAFT와 CLOSED도 나온다. `query`가 있으면 `queryForms`로 공개 목록과 같은 `title` / `company` ILIKE, `search_choseong`, `search_jamo` 조건을 쓴다. `query`가 없으면 그 조건은 `$1::text IS NULL`로 건너뛴다. `ILIKE '%%'`로 전체 일치시키지 않는다.

`admin_get_application`. 입력 `{ id: uuid }`. 출력은 `id`, `userId`, `revision`, `stage`, `company`, `title`, `appliedAt`, `createdAt`, `updatedAt`, `postingId` (`jobs.source_posting_id`). `notes`는 넣지 않는다.

`admin_list_applications`. 입력 `userId`, `postingId`, `stage`, `limit`, `cursor`. `stage`는 `DISCOVERED`, `PREPARING`, `READY`, `APPLIED`, `SCREENING`, `INTERVIEW`, `OFFER`, `ACCEPTED`, `REJECTED`, `WITHDRAWN` (`services/core-api/src/routes/applications.ts`의 `validStage`). 필터가 모두 비어도 `limit`만큼만 반환한다.

### 쓰기

`admin_create_posting`. annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`.

입력:

```ts
z.object({
  idempotencyKey: z.uuid(),
  companyId: z.uuid(),
  company: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(300),
  jobCategory: z.enum(["dev", "data", "design", "plan", "marketing", "sales", "hr", "ops"]),
  careerMin: z.number().int().min(0).max(80),
  careerMax: z.number().int().min(0).max(80).nullable().optional(),
  location: z.string().min(1).max(80),
  employmentType: z.enum(["full_time", "contract", "intern", "freelance", "dispatch"]),
  description: z.string().min(1).max(50000),
  skills: z.array(z.string().min(1).max(40)).max(30).optional(),
  requirements: z.array(z.string().min(1).max(500)).max(50).optional(),
  preferred: z.array(z.string().min(1).max(500)).max(50).optional(),
  workConditions: z.record(z.string(), z.unknown()).optional(),
  imageKey: z.string().max(200).nullable().optional(),
  sourceUrl: z.string().min(1).max(2000).nullable().optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  status: z.enum(["DRAFT", "OPEN"]).optional(),
})
```

zod는 형태만 본다. 길이(코드포인트), `careerMax >= careerMin`, `imageKey` 정규식, `sourceUrl`의 `httpsUrl`, `workConditions`가 배열이 아닌지는 `parsePostingWrite`가 공개 `createPosting`과 같은 `HttpError`로 거절한다. zod와 도메인 검사가 겹쳐도 도메인 검사가 기준이다. 공개 라우트가 받아들이는 값은 관리자 도구도 받아들이고, 공개 라우트가 거절하는 값은 관리자 도구도 거절한다.

`status`를 생략하면 `OPEN`이다. `CLOSED`로 만들 수는 없다. 공개 `createPosting`이 `CLOSED`를 거절하는 것과 같다. 닫힌 공고가 필요하면 만든 뒤 `admin_set_posting_status`를 부른다.

`companyId`로 `companies` 행을 찾는다. 없으면 `NOT_FOUND`. `verified_at`은 요구하지 않는다. 빈 테이블을 시드할 때 미검증 회사가 막을 수 있기 때문이다. 응답에 `companyVerified: boolean`을 넣어 어시스턴트가 보게 한다. `company`를 생략하면 `companies.name`을 표시 이름으로 쓴다.

`created_by`는 NULL이다. 컬럼은 `users`에 대한 nullable FK다 (`0021_fo_web_design_gaps.sql`). 관리자 주체를 사용자 행으로 만들지 않는다. `draft_source`는 `MANUAL`이다. 체크는 `AGENT` | `MANUAL`만 허용한다 (`0040_web_v2_fields.sql`). `id`는 서버가 `crypto.randomUUID()`로 만든다. 입력에 `id`가 있으면 zod가 거절한다.

INSERT 문장은 지금의 `createPosting` 세 단계( `created_by, draft_source` → `created_by` → 둘 다 없음 )를 그대로 쓴다. `revision`은 1, `closed_at`은 NULL, `status`는 입력값이다. `searchFields(\`${title} ${company}\`)`의 `text` / `choseong` / `jamo`가 `search_text` / `search_choseong` / `search_jamo`다.

출력: `id`, `companyId`, `company`, `title`, `status`, `revision` (1), `closedAt` (null), `companyVerified`, `draftSource`.

`enqueueIngest`, `ai_jobs`, `outbox`, 디스패처 HTTP는 호출하지 않는다. 테스트가 SQL과 fetch 목에 이 문자열이 없음을 확인한다.

`admin_set_posting_status`. annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`. `destructiveHint`는 클라이언트가 닫기를 확인하게 하는 힌트다.

입력:

```ts
z.object({
  idempotencyKey: z.uuid(),
  id: z.uuid(),
  status: z.enum(["DRAFT", "OPEN", "CLOSED"]),
  expectedRevision: z.number().int().positive(),
})
```

동작:

- 행이 없으면 `NOT_FOUND`.
- 현재 `status`가 목표와 같으면 UPDATE 하지 않고 현재 `revision`을 반환한다. `CLOSED`인데 `closed_at`만 비어 있는 불일치는 목표와 다른 것으로 보고 아래에서 고친다.
- `expectedRevision`이 현재 `revision`과 다르고 상태도 다르면 `REVISION_CONFLICT`와 `details.currentRevision`. 공개 `patchPosting`과 같은 코드다.
- `expectedRevision`이 다르지만 상태가 이미 목표와 같으면 성공으로 현재 행을 반환한다. 성공 후 재시도가 revision을 한 번 더 올리지 않는다.
- 상태가 바뀌면 한 UPDATE다.

```sql
UPDATE job_postings
SET status = $3,
    closed_at = CASE
      WHEN $3 = 'CLOSED' THEN COALESCE(closed_at, $4::timestamptz)
      ELSE NULL
    END,
    revision = revision + 1
WHERE id = $1 AND revision = $2
RETURNING id, company_id, company, title, status, revision, closed_at
```

`CLOSED`는 `closed_at`을 유지하거나 지금 시각으로 채운다. `OPEN`과 `DRAFT`는 `closed_at`을 NULL로 만든다. 공개 `patchPosting`은 `closed_at`이 있으면 `OPEN`을 거절한다. 관리자 도구는 시드 실수를 되돌리려고 다시 연다. 공개 목록은 `status = 'OPEN' AND closed_at IS NULL`이라, 다시 연 행만 목록에 나온다. `DRAFT`는 `closed_at`이 NULL이어도 `status` 때문에 공개 목록에 나오지 않는다. 검색 컬럼은 상태가 바뀌어도 다시 계산하지 않는다. 제목이 그대로이기 때문이다.

출력: `id`, `companyId`, `title`, `status`, `revision`, `closedAt`.

멱등 (두 쓰기 공통):

테이블 `admin_idempotency_keys`. 기존 `idempotency_keys`는 `user_id NOT NULL REFERENCES users`라 관리자 행을 넣을 수 없다. 센티넬 사용자는 만들지 않는다.

한 트랜잭션에서 끝나며, 코어 `idempotency_keys`처럼 pending 행을 먼저 커밋하지 않는다. 크래시가 나면 트랜잭션이 롤백되어 키를 다시 쓸 수 있다. `response_body`가 NULL인 행은 만들지 않는다.

1. 인자 JSON을 키 정렬해 SHA-256 (`http.ts`의 `hashJson`)한 값을 `request_hash`로 한다.
2. `INSERT ... ON CONFLICT (tool, key) DO NOTHING RETURNING id`.
3. 새로 들어갔으면 쓰기를 실행하고, 같은 트랜잭션에서 `response_body`와 감사 행을 채운 뒤 커밋한다.
4. 이미 있고 `request_hash`가 같으면 저장된 `response_body`를 반환하고 쓰기는 하지 않는다. 동시에 같은 키로 들어온 두 요청은 UNIQUE가 직렬화한다. 진 쪽은 이긴 쪽이 커밋한 응답을 읽는다.
5. 이미 있고 해시가 다르면 도구 오류 `IDEMPOTENCY_CONFLICT`. 기존 행은 유지한다.

필드 검사와 회사 `SELECT`는 이 트랜잭션보다 먼저 한다. 그 단계에서 난 `VALIDATION_ERROR`와 회사 `NOT_FOUND`는 멱등 행을 남기지 않고, 감사 autocommit만 한다. 상태가 이미 목표와 같아 UPDATE가 없는 성공도 멱등 행과 감사 행은 커밋한다. 트랜잭션 안에서는 멱등 INSERT가 공고 쓰기보다 먼저다.

`REVISION_CONFLICT`를 비롯해 커밋 전에 반환하는 도구 오류는 트랜잭션을 롤백한다. 멱등 행도 사라져, 같은 키로 다시 보낼 수 있다. 그 오류의 감사 행은 롤백 뒤 autocommit INSERT 한 번이다. 이 INSERT가 실패해도 클라이언트에는 도메인 오류를 그대로 반환한다. 성공한 쓰기의 감사 행은 본 트랜잭션 안에만 둔다. 감사가 실패하면 공고 쓰기도 롤백된다.

### 버린 도구: 임의 SQL

`admin_query_sql`은 넣지 않는다. 강제할 수 있는 형태가 이 저장소의 연결 방식으로는 닫히지 않는다.

코어가 쓰는 `DATABASE_URL`은 Neon 소유자 역할이다. `BEGIN READ ONLY`와 `SET LOCAL statement_timeout`은 그 세션 안에서는 듣는다. 그러나 사용자가 넘긴 SQL을 파라미터 없는 simple query로 실행하면 한 문자열에 여러 문장이 들어갈 수 있고, `COMMIT` 뒤에 `INSERT`가 읽기 전용 트랜잭션 밖으로 나간다. `;` 금지와 주석 금지는 우회가 남는다. 소유자 역할은 `statement_timeout`을 0으로 바꿀 수 있고, `password_hash`와 토큰 해시 테이블을 SELECT 할 수 있다. 행 상한은 Postgres 세션 설정에 없다. 클라이언트가 200행만 읽는 것은 서버의 스캔을 막지 못한다.

닫으려면 별도 역할(테이블별 `GRANT SELECT`, 비밀 컬럼 제외), 그 역할의 연결 문자열, extended protocol의 단일 문장, 서버가 사용자 SQL보다 먼저 거는 timeout이 필요하다. `CREATE ROLE`은 이 저장소 마이그레이션(테이블 DDL만)과 다르고, 역할은 브랜치 밖 설정에 가깝다. v1의 읽기 도구가 통계와 조회를 담당하므로 SQL 도구 없이 간다.

나중에 넣으려면 위 역할과 단일 문장 강제가 테스트로 증명된 뒤다. 그 전까지 도구 목록에 이름을 올려 두지 않는다. 모델이 추측으로 호출할 이름을 만들지 않기 위해서다.

### 하지 않는 쓰기

공고 삭제, 공고 본문 수정, 지원 단계 변경, 사용자 정지, 비밀번호, 결제, 크레딧, 회사 검증 처리, `enqueueIngest`, 공개 `Idempotency-Key` 헤더 경유 호출. 본문 수정이 필요해지면 `patchPosting`의 필드 대입을 `posting-write.ts`로 옮긴 뒤 도구를 추가한다. 이번 범위는 시드와 상태다.

## 5. 감사

구조화 로그만 두면 Workers observability에 남지만, 나중에 “누가 어떤 공고를 열었는지”를 SQL로 볼 수 없다. 테이블을 남긴다. 로그도 남긴다. 둘의 내용이 다르다.

`db/migrations/0053_admin_mcp.sql`은 추가만 한다. 기존 테이블을 `ALTER`하지 않는다. `DROP`과 데이터 `UPDATE`가 없다. 코어의 `migration-0040.test.ts`처럼 파일 텍스트를 읽어 그 성질을 assert 한다.

```sql
CREATE TABLE admin_idempotency_keys (
    id uuid PRIMARY KEY,
    tool text NOT NULL,
    key uuid NOT NULL,
    request_hash text NOT NULL,
    response_body jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tool, key)
);

CREATE TABLE admin_audit_log (
    id uuid PRIMARY KEY,
    tool text NOT NULL,
    idempotency_key uuid,
    args jsonb NOT NULL,
    result jsonb,
    ok boolean NOT NULL,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_log_created_idx ON admin_audit_log (created_at DESC, id DESC);
```

`admin_audit_log`에 들어가는 경우: 커밋된 쓰기 성공, 그리고 도구가 반환한 도메인 오류(`NOT_FOUND`, `VALIDATION_ERROR`, `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`). 성공 행은 쓰기와 같은 트랜잭션이고, 도메인 오류 행은 롤백 뒤의 autocommit이다. 자세한 순서는 §4 멱등 절과 같다. `args`는 도구 입력 JSON이다. 토큰은 입력에 없다. `result`는 성공 출력 또는 오류 `structuredContent`다.

들어가지 않는 경우: 401, 429, 배치 거절, zod가 도구 콜백 전에 거절한 입력, 예상 밖 예외. 이건 로그로만 남긴다.

로그 한 줄:

```json
{"kind":"admin_mcp","rid":"...","tool":"admin_create_posting","ok":true,"code":null,"ms":12}
```

`rid`는 게이트웨이 `requestIdOf`와 같이 `^[A-Za-z0-9._:-]{1,128}$`만 받아들이고, 아니면 `req_` + `crypto.randomUUID()`다. `Authorization`, 토큰, `description`, SQL 텍스트는 로그에 넣지 않는다.

마이그레이션 적용은 기존 `Migrate database` `workflow_dispatch`다. push는 마이그레이션하지 않는다. 구현 에이전트는 이 워크플로를 실행하지 않는다. 사람이 environment `staging`으로만 돌린다. `production`은 이 작업의 뒤 단계이며, 이 계획의 구현 PR이 Neon main에 쓰게 하지 않는다. 테이블이 없으면 쓰기 도구는 `isMissingRelation`을 `NOT_FOUND`로 숨기지 않고 `isError` 코드 `SCHEMA_MISSING`으로 반환한다. 읽기 도구도 같다. 공개 코어의 “컬럼이 없으면 폴백” 패턴을 여기서 쓰지 않는다. 관리자 도구가 조용히 다른 SQL로 내려가면 시드가 검색 필드 없이 들어간다.

## 6. 배포

`services/admin-mcp/wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "push-be-admin-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-17",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "observability": { "enabled": true },
  "placement": { "mode": "targeted", "region": "aws:ap-southeast-1" },
  "triggers": { "crons": [] },
  "vars": { "APP_ENV": "production" },
  "env": {
    "staging": {
      "name": "push-be-admin-mcp-staging",
      "workers_dev": true,
      "triggers": { "crons": [] },
      "vars": { "APP_ENV": "development" }
    }
  }
}
```

`APP_ENV`는 로그용이다. 인증을 끄지 않는다. `DEV_AUTH_TOKEN`을 읽지 않는다. `services` 바인딩, cron, KV, Durable Object는 없다. `workers_dev`를 staging 블록에도 적는 이유는 env가 `vars`를 상속하지 않는 기존 주석과 맞추려는 것이다. dry-run이 `workers_dev`를 env 블록에서 거절하면 최상위에만 둔다. 게이트웨이는 최상위에만 있고 스테이징도 workers.dev에 올라간다.

시크릿은 Worker에 `DATABASE_URL`과 `ADMIN_MCP_TOKEN` 둘뿐이다. `DATABASE_URL`은 그 GitHub environment에 이미 있는 값이다. staging environment의 `DATABASE_URL`은 스테이징 Neon 브랜치고, production environment의 값은 운영 브랜치다. 구현할 때 URL을 복사해 적지 않는다. `wrangler secret bulk`가 CI environment의 값을 넣는다.

GitHub 시크릿 이름 (environment 범위, 저장소 공용 시크릿이 아님):

| Environment | 시크릿 | 용도 |
| --- | --- | --- |
| `staging` | `ADMIN_MCP_TOKEN` | 스테이징 Worker. 운영 토큰과 다른 값 |
| `staging` | `DATABASE_URL` | 기존 스테이징 Neon. 새로 만들지 않음 |
| `production` | `ADMIN_MCP_TOKEN` | 운영 Worker. 구현 PR에서는 값을 넣지 않음 |
| `production` | `DATABASE_URL` | 기존 운영 Neon. 이 작업에서 연결하지 않음 |

사람이 staging 토큰을 넣은 뒤에야 `develop` 배포가 통과한다. CI는 배포 job 첫 단계에서 시크릿이 비었는지만 보고, 값은 스텝 로그에 남기지 않는다 (`ci.yml`의 기존 `!= ''` 검사와 같다). `ADMIN_MCP_TOKEN`을 그 검사 목록에 넣으면, 토큰이 없는 environment는 VPS와 게이트웨이보다 먼저 실패하고 아무것도 배포하지 않는다. `develop`은 staging environment만 보므로 운영 토큰이 없어도 스테이징 배포는 된다. `main`은 production environment의 토큰이 있어야 한다. 운영 토큰을 비운 채로 `main`에 병합하면 운영 배포 전체가 막힌다. 구현 PR을 `main`에 넣기 전에 사람이 운영 토큰을 만든다.

CI `changes` job에 출력 `admin`을 추가한다.

```bash
admin=false
if match '^(services/admin-mcp/|services/core-api/src/(domain/|hangul\.ts|ratelimit\.ts|db\.ts|http\.ts|time\.ts)|package\.json|package-lock\.json|\.github/workflows/ci\.yml)'; then admin=true; fi
```

`develop` 또는 `DEPLOY_BRANCH`로의 push가 배포를 켜는 블록에서 `gateway=true`와 함께 `admin=true`를 설정한다. 그 push는 오늘도 코어와 게이트웨이를 항상 배포한다.

job `test-admin`: `npm ci`, `npm run test:coverage -w push-be-admin-mcp`, `npm run typecheck -w push-be-admin-mcp`. `needs.changes.outputs.admin == 'true'`.

job `bundle-admin`: `services/admin-mcp`에서 `npx wrangler deploy --dry-run --outdir /tmp/push-be-admin-mcp`, 그리고 `--env staging`으로 한 번 더. `gzip -c`한 스크립트가 3 MiB를 넘으면 job을 실패시킨다. Workers 무료 한도가 압축 3 MiB, 유료가 10 MiB다. 계정 플랜을 이 계획에서 확인하지 못했으므로 3 MiB를 기준으로 한다. 초과하면 import를 배럴 `@modelcontextprotocol/server` 한 곳으로 유지한 채, 등록하지 않은 OAuth·stdio 경로가 번들에 들어갔는지 dry-run 산출물에서 찾고, 그래도 넘으면 배포를 멈추고 이 문서에 한도를 갱신한다. 기능을 빼서 크기를 맞추지 않는다.

`test-db`의 `if`에 `admin`을 포함한다. `scripts/sql-check/extract-ts.mjs` 인자에 `services/admin-mcp/tsconfig.json`을 추가한다. SQL 캡처 단계에 다음을 추가한다.

```bash
(cd services/admin-mcp && node --experimental-strip-types --import "$register" --test 'test/**/*.ts')
```

배포 job의 `needs`에 `test-admin`과 `bundle-admin`을 넣고, 코어 시크릿 다음, 게이트웨이 배포 전에 다음을 실행한다.

```bash
# working-directory: services/admin-mcp
npx wrangler deploy $WRANGLER_ENV
# secret bulk JSON: DATABASE_URL, ADMIN_MCP_TOKEN
npx wrangler secret bulk "$file" $WRANGLER_ENV
```

`WRANGLER_ENV`는 오늘과 같이 staging일 때만 `--env staging`이다. 배포 직후:

```bash
host=push-be-admin-mcp
[ "$STAGE" = "staging" ] && host=push-be-admin-mcp-staging
curl -fsS "https://${host}.youngjoon568.workers.dev/healthz"
curl -sS -o /tmp/mcp-unauth -w "%{http_code}" -X POST "https://${host}.youngjoon568.workers.dev/mcp"
# 상태 코드는 401
ADMIN_MCP_URL="https://${host}.youngjoon568.workers.dev/mcp" \
  ADMIN_MCP_TOKEN="$ADMIN_MCP_TOKEN" \
  node "$GITHUB_WORKSPACE/services/admin-mcp/scripts/smoke.mjs"
```

스모크는 `tools/list`만 한다. `tools/call`은 하지 않는다. 토큰을 echo 하지 않는다. wrangler가 인쇄한 workers.dev 호스트의 서브도메인이 `youngjoon568`이 아니면 curl 대상을 그 인쇄 값으로 바꾸고, 이 문서의 URL도 그 값으로 고친다. 저장소 주석은 `<account>.workers.dev`이고, 이 계획의 호스트는 요청에 적힌 `youngjoon568`이다.

`packages/contracts`와 OpenAPI는 바꾸지 않는다. MCP는 `/api/v1` 계약이 아니다. README의 아키텍처 목록에 Worker 한 줄을 추가하는 것은 구현 PR에서 한다. 게이트웨이 코드는 바꾸지 않는다.

## 7. 테스트

러너는 코어와 같다. `node --experimental-strip-types --test 'test/**/*.ts'`. `tsconfig.json`은 코어와 같은 `ES2022`, `moduleResolution: bundler`, `allowImportingTsExtensions`, `strict`, `types: ["node"]`다.

`test/auth.test.ts`가 `fetch` 핸들을 직접 부른다.

- `ADMIN_MCP_TOKEN` 없음, 빈 문자열, 31자 → `POST /mcp` 401. 본문에 `tools`가 없다.
- 헤더 없음, `Bearer`가 아님, 다른 토큰 → 401. 세 응답 본문이 같다.
- 32자 이상 올바른 토큰과 `initialize` → 200, `Content-Type`에 `application/json`, 본문은 JSON-RPC result.
- 같은 토큰으로 `tools/list` → 아래 11개 이름이 모두 있고 그 외 이름은 없다. `admin_platform_stats`, `admin_get_user`, `admin_list_users`, `admin_get_company`, `admin_list_companies`, `admin_get_posting`, `admin_list_postings`, `admin_get_application`, `admin_list_applications`, `admin_create_posting`, `admin_set_posting_status`.
- `GET /mcp` → 405.
- 401과 200 모두 `access-control-allow-origin`이 없다.
- 최상위 JSON 배열 → 400.
- `rate_limits` INSERT가 행을 반환하지 않으면 429.

`test/tools.test.ts`는 코어 `company-card.test.ts`처럼 `Query` 목으로 도구 함수를 부른다. HTTP와 zod를 거친 핸들 테스트도 각 쓰기마다 하나 둔다.

- `admin_platform_stats`가 한 SELECT의 별칭을 출력 필드로 옮긴다.
- `admin_get_user` SQL에 `password_hash`, `phone`, `provider_subject`가 없다.
- `admin_create_posting`의 INSERT에 `search_text`, `search_choseong`, `search_jamo`, `revision`, `status`, `company_id`가 있고, 파라미터에 `searchFields` 결과가 들어간다. `ai_jobs`와 `outbox` SQL은 없다. `fetch`가 호출되지 않는다.
- 같은 `idempotencyKey`와 같은 인자는 두 번째에 INSERT 하지 않고 첫 `id`를 반환한다.
- 같은 키와 다른 `title`은 `IDEMPOTENCY_CONFLICT`이고 INSERT 하지 않는다.
- 없는 `companyId`는 `NOT_FOUND`.
- `jobCategory: "nope"`과 `careerMax < careerMin`은 `VALIDATION_ERROR`.
- `admin_set_posting_status`의 `CLOSED`는 `closed_at`을 채우고, `OPEN`은 NULL로 만들고, 이미 그 상태면 UPDATE SQL이 없다.
- `expectedRevision` 불일치와 다른 상태는 `REVISION_CONFLICT`.
- `admin_list_postings`에 `query`가 있으면 SQL에 `search_jamo`가 있다.
- 관계 없음 오류(`42P01`)는 `SCHEMA_MISSING`이다.

코어 쪽: `createPosting`이 `insertPosting`을 쓰도록 바뀐 뒤에도 `services/core-api/test/company-card.test.ts`와 `recruiting.test.ts`가 수정 없이 통과한다. INSERT 문자열이 바뀌면 테스트를 느슨하게 만들지 말고 SQL을 공개 라우트와 같게 유지한다. `setPostingStatus`를 코어 테스트에서 한 번 호출해, `test-db` 캡처에 그 UPDATE가 들어가게 한다. admin-mcp 테스트만 호출하면 extract는 코어 tsconfig로 문장을 보고, 캡처는 admin 테스트를 돌려야 충족된다. 둘 다 돌린다.

`test/migration-0053.test.ts`는 `0053_admin_mcp.sql`에 두 `CREATE TABLE`이 있고 `DROP`, `ALTER TABLE job_postings`, `UPDATE`, `DELETE`가 없음을 확인한다.

`services/admin-mcp/scripts/smoke.mjs`는 `ADMIN_MCP_URL`과 `ADMIN_MCP_TOKEN`을 읽는다. `initialize` (`protocolVersion`은 `initialize` 응답에 맞춘다. 첫 POST는 `2025-11-25`) 다음에 `tools/list`를 보내고, 위 11개 이름과 다르면 exit 1이다. 인자 없이 실행하면 URL이 없다는 문장만 내고 exit 2다. 쓰기 도구는 호출하지 않는다. CI 배포 스텝이 이 스크립트를 스테이징 또는, `main` 배포라면 운영 호스트에 대해 실행한다. 운영에서의 호출은 `tools/list`뿐이다.

로컬에서 DB가 필요 없는 확인은 `npm test -w push-be-admin-mcp`와 `npm run typecheck -w push-be-admin-mcp`와 wrangler dry-run이다. `wrangler dev`로 스모크를 돌리는 것은 선택이다. 테스트가 핸들을 직접 부르므로 dev 서버는 병합 조건이 아니다.

## 8. 영향 범위와 롤백

바뀌는 것:

- 새 디렉터리 `services/admin-mcp`.
- 루트 `package.json`, `package-lock.json`. lockfile이 바뀌면 기존 path filter가 게이트웨이와 코어 테스트를 켠다.
- `services/core-api/src/domain/posting-write.ts`와, 번들 검사에 걸리면 `domain/fields.ts`. `routes/postings.ts`의 `createPosting`이 그 함수를 호출한다. 공개 HTTP 계약, 상태 코드, ingest 호출은 유지한다.
- `db/migrations/0053_admin_mcp.sql`과 그 파일 테스트.
- `.github/workflows/ci.yml`의 path filter, `test-admin`, `bundle-admin`, `test-db`의 extract 인자, 배포 스텝.
- README의 Worker 한 줄 (구현 PR).

바뀌지 않는 것: 게이트웨이 라우트와 CORS, 코어 `workers_dev: false`, 코어와 게이트웨이의 기존 시크릿 목록, VPS compose, `packages/contracts`, 공개 `idempotency_keys`, `job_postings` 컬럼.

위험:

- 도메인 추출이 `createPosting` SQL을 한 글자라도 바꾸면 공개 생성의 검색이나 `draft_source` 폴백이 달라진다. 기존 코어 테스트와 `sql-check`의 `PREPARE`가 그 가드다.
- `ADMIN_MCP_TOKEN` 검사를 배포 job에 넣으면, 해당 environment에 시크릿이 없을 때 VPS와 게이트웨이 배포가 함께 멈춘다. 멈추는 편이 토큰 없이 관리자 Worker를 올리는 것보다 낫다. staging 시크릿을 먼저 만든다.
- MCP 서버 패키지 번들이 3 MiB 압축을 넘으면 배포하지 않는다. 한도를 무시하고 `--no-bundle` 같은 우회를 쓰지 않는다.
- 관리자 상태 변경은 공개 API가 거절하는 `CLOSED` → `OPEN`을 허용한다. 도구가 관리자 Worker 안에만 있으므로 공개 `PATCH /api/v1/postings/:id`의 거절은 그대로다.
- 미검증 회사로 `OPEN` 공고를 만들 수 있다. 응답의 `companyVerified`가 그 사실을 보여 준다. 공개 목록은 `openClause`만 보므로, 회사가 미검증이어도 `OPEN`이면 목록에 나온다. 시드가 그 결과다.
- 첫 배포와 `secret bulk` 사이에 `/mcp`는 401이다. healthz는 200이다.

롤백:

- 토큰을 무효로 바꾸거나 `wrangler secret delete ADMIN_MCP_TOKEN`을 하면 코드가 남아 있어도 `/mcp`는 401이다. 가장 빠르다.
- 스크립트를 내리려면 `npx wrangler delete --name push-be-admin-mcp-staging` 또는 `push-be-admin-mcp`. 코드 revert는 이미 배포된 스크립트를 자동으로 지우지 않는다.
- `0053` 테이블은 남겨 둔다. Worker가 없어도 기존 쿼리와 무관하다. 드롭은 별도 마이그레이션으로 하고, 이 구현의 롤백에 넣지 않는다.
- 공개 코어 동작이 추출 때문에 깨지면 그 커밋을 revert 한다. 관리자 Worker만 revert 하면 공개 생성은 추출된 함수를 계속 호출한다. 둘을 한 PR에 두되, 추출 커밋과 Worker 커밋을 나눠 revert가 가능하게 한다.

## 9. 구현 순서

각 단계는 앞 단계의 테스트가 통과한 뒤에 간다. 프로덕션 `wrangler deploy`, 프로덕션 시크릿 입력, `migrate.yml`의 production, Neon main 연결, OpenRouter 호출은 어느 단계에도 없다. staging 마이그레이션 dispatch는 사람이 한다.

1. 워크스페이스와 빈 Worker. `services/admin-mcp`의 `package.json`, `tsconfig.json`, `wrangler.jsonc`, `src/index.ts`의 `GET /healthz`와 그 외 404. 루트 workspaces와 lockfile. 확인: `npm run typecheck -w push-be-admin-mcp`, `npm test -w push-be-admin-mcp`의 healthz 테스트, `npx wrangler deploy --dry-run`과 `--env staging` dry-run이 스크립트 이름 `push-be-admin-mcp`와 `push-be-admin-mcp-staging`을 인쇄한다.

2. 인증과 레이트 리밋. `src/auth.ts`의 `secretEquals` 복사, 32자 미만 거절, CORS 헤더 없음, isolate 메모리 30회, `allow(..., "admin-mcp", ...)`. 확인: §7 인증 케이스 중 401, 405, CORS 없음, 429, healthz. `tools/list`의 11개 이름 단언은 7단계까지 미룬다.

3. MCP 전송. `2.4.0`과 `zod` `4.6.7`을 설치하고 lockfile을 커밋한다. `POST /mcp`가 `initialize`와 빈 도구 목록에 가까운 응답을 JSON으로 반환한다. 배치는 400이다. 확인: 인증 테스트의 initialize가 `application/json`이다. gzip 크기를 기록한다. 3 MiB를 넘으면 여기서 멈춘다.

4. 도메인 추출. `posting-write.ts`로 `parsePostingWrite`와 `insertPosting`을 옮기고 `createPosting`이 이를 호출한 뒤 `enqueueIngest`를 유지한다. SQL 문자열은 이동 전과 같다. 확인: `npm test -w push-be-core`가 기존 테스트를 수정 없이 통과한다. 이 단계의 admin Worker는 아직 코어를 import 하지 않는다.

5. 마이그레이션 파일과 멱등·감사 헬퍼. Neon에는 적용하지 않는다. 목 트랜잭션으로 같은 키의 재시도가 두 번째 쓰기를 건너뛰는지, 다른 인자면 `IDEMPOTENCY_CONFLICT`인지, 롤백 시 키가 사라지는지 검증한다. 확인: `migration-0053` 테스트와 헬퍼 테스트. `rg DROP db/migrations/0053_admin_mcp.sql`은 일치가 없다.

6. 읽기 도구 아홉 개. 상수 SQL. `tools/list`에 읽기 이름 아홉 개가 있다. 확인: §7의 읽기 테스트. `test-db`와 같은 방식으로 로컬 Postgres가 있으면 `PREPARE`까지 한다. 없으면 CI의 `test-db`가 그 확인이다. 구현 에이전트는 Neon에 연결하지 않는다.

7. 쓰기 도구 둘. `insertPosting`과 `setPostingStatus`. ingest 없음. `CLOSED`로 생성되는 입력은 거절된다. 확인: §7의 쓰기 테스트. `tools/list`가 정확히 11개다. admin 번들 dry-run 산출물에 `enqueueIngest`와 `q:notify`가 없다. 있으면 `domain/fields.ts`로 나눈 뒤 코어 테스트와 번들 검사를 다시 한다.

8. CI. `admin` filter, `test-admin`, `bundle-admin`, `test-db` extract와 캡처, 배포 스텝, healthz curl, 무인증 `/mcp`가 401인지, `smoke.mjs`. 확인: `git diff --check`, `rg -n "admin=" .github/workflows/ci.yml`에 path filter와 배포 블록이 둘 다 있다. `git diff -- services/gateway services/core-api/wrangler.jsonc`는 비어 있다. 배포 job을 로컬에서 실행하지 않는다.

9. 사람 확인 (에이전트가 하지 않음). staging environment에 `ADMIN_MCP_TOKEN`을 넣는다. `develop`에 병합되면 CI가 스테이징 Worker를 배포하고 스모크가 도구 11개의 이름을 출력한다. 그 다음 `workflow_dispatch`로 environment `staging`에만 `0053`을 적용한다. 적용 뒤에 어시스턴트가 스테이징에서 `admin_platform_stats`와, 스테이징 회사에 대한 `admin_create_posting`을 호출해 `searchChoseong`이 비어 있지 않은지 본다. 운영 토큰, 운영 배포, Neon main 마이그레이션은 이 확인에 포함하지 않는다.

## 구현 시 금지

- `npx wrangler deploy`를 `--env staging` 없이 실행해 `push-be-admin-mcp`를 올리는 것. dry-run은 허용한다.
- 프로덕션 `DATABASE_URL` 또는 `ADMIN_MCP_TOKEN`을 파일, PR, 로그에 쓰는 것.
- `migrate.yml`을 `production`으로 돌리거나, Neon main 브랜치 호스트로 `psql`이나 스크립트를 실행하는 것.
- OpenRouter, 임베딩 API, `enqueueIngest`를 관리자 경로에서 호출하는 것.
- 게이트웨이 `withCors` 경로에 `/mcp`를 추가하는 것.
- 임의 SQL 도구를 “읽기 전용 프롬프트”만 믿고 추가하는 것.
