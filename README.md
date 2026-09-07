# Push API

Go · Echo · PostgreSQL 기반 커리어 작업공간 API. 계약 원본은 상위 workspace의 `docs/api.md`다. API는 `/api/v1`, 포트는 8080이다. 실제 PostgreSQL만 사용하며 개발용 인메모리 저장소/가짜 로그인/샘플 레코드는 없다.

## 실행

Go 1.26+, PostgreSQL 16+, PDF 텍스트 추출용 Poppler(`pdftotext`)가 필요하다. macOS는 `brew install poppler`, Ubuntu는 `apt-get install poppler-utils`로 설치한다. Docker 이미지는 추출기를 포함한다. DB를 만든 뒤 `.env.example`을 `.env`로 복사하고 환경변수를 설정한다. `.env` 파일은 자동 로드하지 않는다. 셸에서 `set -a; source .env; set +a`를 실행하거나 비밀 관리 도구로 전달한다.

```sh
openssl rand -base64 32
openssl rand -hex 32
```

첫 출력은 `AES_KEY`, 두 번째는 개발 전용 `DEV_AUTH_TOKEN`으로 각각 사용한다. 운영에는 `APP_ENV=production`, `DEV_AUTH_TOKEN` 미설정, HTTPS PostgreSQL 설정과 별도의 AES secret이 필요하다. 키를 저장소에 커밋하지 않는다.

```sh
go run .
go build -trimpath -o /tmp/push-api .
```

마이그레이션은 바이너리에 포함되어 시작 시 적용된다. 실행 위치와 무관하다. `/healthz`는 프로세스, `/readyz`는 DB 상태를 확인한다. Docker 이미지는 비root 사용자로 실행하며 같은 환경변수를 받는다. 루트 workspace의 Compose/Caddy 설정에서 연결한다.

## 로컬 검증

```sh
TEST_DATABASE_URL='postgres://USER:PASSWORD@localhost:5432/push_test?sslmode=disable' go test -race -count=1 ./...
go vet ./...
```

각 테스트는 독립 PostgreSQL schema를 만들고 정리한다. 테스트 계정에 CREATE SCHEMA 권한이 필요하다. `TEST_DATABASE_URL`이 없으면 DB 테스트는 명시적으로 skip되므로 CI에서는 반드시 지정한다. `.github/workflows/test.yml`은 PostgreSQL 16 서비스에서 실행한다.

검증 범위: 근거 원문/지원별 승인, Unicode 인용과 TipTap 본문 일치, 문서 버전 충돌 및 확정 차단, 불변 제출 초안, 멱등 요청, 오프라인 mutation 제한/중복, 일정·면접·오퍼·루틴, OAuth PKCE 및 토큰 회전, Stripe 서명/중복, 암호문 변조, 실제 HTTP 경계의 AI 사용량, Google 다중 페이지 rollback, CLI 재실행 차단과 GitHub CI artifact 검증.

## AI 설정과 작업

`AI_MODELS`는 실제 허용 모델의 JSON 배열이다. 예시 스키마(모델 이름은 운영자가 실제 사용 가능한 값으로 설정):

```json
[{"provider":"OPENAI","model":"<enabled-model>","managed":false,"inputMicroCreditsPerToken":0,"outputMicroCreditsPerToken":0}]
```

`provider`는 OPENAI/CLAUDE/GEMINI/GROK이다. BYOK 키는 API에서 등록하며 사용자/제공자/키 버전 AAD와 무작위 nonce로 AES-256-GCM 암호화한다. 관리형은 OPENAI만 가능하고 `managed:true`, 양수 입력/출력 단가, `OPENAI_API_KEY`, 활성 구독과 잔액이 모두 필요하다. 과금 단위는 microCredit(USD 0.000001)이며 Stripe USD 결제의 실제 납부액을 같은 단위로 지급한다. 임의 모델 자동 fallback은 없다.

AI 요청은 `work_queue`와 Operation에 영속화한 뒤 백그라운드에서 실제 공급자를 호출한다. 모델 사용량이 확인되면 예약을 1회 정산한다. 실패/타임아웃으로 사용량이 불명확하면 RESERVED 이력을 유지하여 운영자가 공급자 사용량과 대조해야 한다. RUNNING 작업을 무작정 다시 전송하지 않는다. 작업 결과가 문서 revision과 충돌하면 비용은 실제 사용량으로 정산하고 변경을 적용하지 않는다.

`ai:null`인 공고 분석·문서 발췌·프로젝트 블루프린트·면접 준비는 로컬 규칙 기반 기능이다. 설정된 AI 경로는 실제 제공자 응답을 검증한다. 문서 생성은 제안이며, 정확한 원문 인용으로 확인되지 않는 문장은 확정할 수 없다. 문장 수정도 같은 규칙을 따른다. AI 면접 답변의 경험은 제공한 원문의 발췌만 허용한다.

공급자 참조: [OpenAI Chat API](https://platform.openai.com/docs/api-reference/chat/create), [Claude Messages](https://platform.claude.com/docs/en/api/http/messages/create), [Gemini generateContent](https://ai.google.dev/api/generate-content), [xAI API](https://api.x.ai/docs/).

## OAuth · Google · Stripe

Google/GitHub OAuth redirect는 `PUBLIC_API_URL/api/v1/auth/{provider}/callback`이다. 로그인과 Google 메일/일정 연결은 별개다. Google 연동 redirect는 `PUBLIC_API_URL/api/v1/integrations/google/callback`이며 인증된 기존 사용자와 일회용 code/PKCE에 연결한다. `GOOGLE_GMAIL_BETA_ENABLED=false`가 기본이며 Gmail 제한 범위 승인 전에는 켜지 않는다. Calendar도 실제 readonly scope 동의가 필요하다.

동기화는 모든 페이지 저장 후 Gmail historyId/Calendar syncToken을 갱신한다. 중간 실패는 트랜잭션을 rollback한다. Calendar 410, Gmail 404 커서는 재동기화한다. Gmail 최초 수집은 최근 90일의 지원/면접 관련 검색 결과와 메타데이터로 제한한다. 증분 수집도 지원 관련 제목 또는 이미 수집한 thread만 보관한다. 메일을 회사명만으로 지원에 자동 연결하지 않는다. 100페이지 한도를 넘으면 체크포인트를 보존하고 오류를 반환한다.

Stripe는 `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, 허용된 Checkout 성공/취소 URL을 요구한다. Checkout `planId`는 `managed`이다. raw-body 서명과 timestamp를 검증하며 이벤트 ID로 중복을 차단하고 구독 이벤트 시각으로 역순 적용을 막는다. 결제 수신 계정은 서버가 저장한 Stripe customer ID로 찾는다. 실제 자격증명이 없으면 명시적인 설정 오류를 반환한다.

## 프로젝트 독립 검증

CLI 실행은 서버에서 명령을 실행하지 않는다. 명령/인자/폴더/프롬프트 hash에 승인과 기기를 고정하고, native 앱의 CLAIMED→STARTED→FINISHED 보고를 검증한다. UNKNOWN은 사용자 확인 없이 재실행하지 않는다.

사용자 입력 exitCode/testOutput만으로 VERIFIED가 되지 않는다. `GITHUB_VERIFICATION_TOKEN`과 정수 `GITHUB_VERIFICATION_WORKFLOW_ID`를 설정하면 원격 커밋, 성공 check, 해당 workflow의 성공 실행 및 `push-verification` artifact를 조회한다. artifact ZIP에는 다음 `verification.json`이 있어야 하며, 실제 CI 테스트/측정 단계에서 생성해야 한다.

```json
{"commitSha":"<40 hex>","testCommand":"go test ./...","testOutput":"<actual output>","exitCode":0,"summary":"<evidence summary>","skills":["<verified project skills>"],"metrics":[{"name":"p95","value":20,"unit":"ms"}]}
```

제출한 SHA·실행 결과·지표·요약은 artifact와 일치해야 한다. workflow와 artifact 생성의 신뢰성을 운영자가 관리해야 한다. 검증 성공 후 Career Vault 근거를 만들며 해당 지원의 EVIDENCE_USE 승인은 여전히 필요하다. 접근 권한/검증 설정이 없으면 기존 PENDING을 유지하고 설정/제공자 오류를 반환한다.

## 책임 범위와 미검증 환경

PDF/DOCX 실제 출력, SQLite 네이티브 저장, CLI 탐지/Terminal 실행, 서명·공증·자동 업데이트는 Tauri 앱 책임이다. 서버 export 결과는 클라이언트의 관측 기록이며 서버 렌더 검증으로 표시하지 않는다. 원본 파일 import에서 읽을 수 있는 텍스트가 없으면 NEEDS_INPUT을 반환한다. 요청 원문/토큰/키/메일 본문을 access log에 기록하지 않는다.

실제 OAuth 계정·결제·메일·유료 AI·GitHub workflow는 자격증명 미제공 상태이므로 실제 공급자 계정 검증은 아직 수행하지 않았다. 테스트는 로컬 HTTP 서버에서 제공자 응답/실패와 실제 PostgreSQL 상태를 검증하며 공급자 연결 성공을 가장하지 않는다. 20명 베타와 배포 인증서는 별도 준비가 필요하다.

## 가져오기와 작업 복구

DOCX는 ZIP 안의 본문 XML과 링크를 읽고 PDF는 격리된 프로세스의 Poppler 텍스트 추출기를 실행한다. 추출 시간과 출력 크기를 제한한다. 스캔 PDF처럼 텍스트가 없으면 NEEDS_INPUT으로 사용자의 전사 입력을 받는다. GitHub 프로필/저장소 URL은 GitHub API로 프로필·저장소 정보·README를 조회하며 연결된 계정 토큰은 암호화 저장한다. 외부 제공자 조회 실패를 생성된 경력으로 대체하지 않는다. 추출 원문은 한 번 보관한 후 변경하지 않고 각 근거의 CODE_POINT 위치를 저장한다.

SSE 이벤트는 PostgreSQL에 순서대로 보관하며 Last-Event-ID 이후를 재생한다. 현재 자동 삭제하지 않아 24시간 이상 유지한다. delta는 공급자의 전체 응답을 확인한 뒤 기록하며 토큰별 실시간 스트림은 제공하지 않는다. 작업 lease가 만료되면 공급자 호출 전 작업만 다시 대기열에 넣고, 호출 시작 이후 작업은 PROVIDER_RESULT_UNKNOWN으로 종료하여 자동 유료 재시도를 막는다. 예약 크레딧은 확인 전까지 유지한다. 예약·정산·취소는 원장에 기록하며 구독 종료 시각은 Stripe webhook에서 저장한다.
