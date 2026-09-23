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
