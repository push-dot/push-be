# 코드 그래프에서 드러난 큰 모듈 나누기

날짜: 2026-10-28. 기준: develop `9f681c6`. 근거: push-be graphify 그래프(노드 8,273개, 엣지 24,038개, 커뮤니티 285개). 그래프에서 나온 신호는 모두 실제 코드로 다시 확인했어요.

아래 세 작업은 모두 코드를 옮기기만 해요. 동작, 경로, 외부에서 쓰는 import는 그대로예요. 작업마다 develop으로 PR을 따로 올려요.

## 1. `services/core-api/src/routes/recruiting.ts` 나누기 (우선순위 1)

이 파일은 2,391줄이고 함수가 83개예요. 다른 route 파일은 470~590줄이에요. 2311번째 줄의 `dispatchRecruiting` 하나가 서로 관계없는 기능 6가지를 처리해요.

| 새 파일 | 담당 경로 |
|---|---|
| `routes/postings.ts` | `postings`, `postings/facets`, `postings/locations`, `postings/{id}`(`bookmark`, `apply`, `close`, `applicants`, `applicant-counts`, 지원자 파일 포함), `companies/me/postings` |
| `routes/search.ts` | `search`, `search/counts`, `search/trending` |
| `routes/profiles.ts` | `profiles`, `profiles/{id}`(`offer` 포함), `users/{id}/follow`, `me/profile`, `me/follows`, `me/followers` |
| `routes/offers.ts` | `me/offers`, `me/offers/{id}`(`messages`, `accept`, `decline` 포함) |
| `routes/posts.ts` | `posts`와 댓글, `me/posts`, `me/commented-posts` |
| `routes/me.ts` | `me/links`, `me/devices`, `me/notifications`(`unread`, `read` 포함), `me/settings`, `me/bookmarks` |

- 여러 파일에서 쓰는 헬퍼는 route 폴더 안의 공통 모듈 하나로 옮겨요. 대상은 `imageUrl`, `person`, `profileDto`, `postingDto`, `offerDto`와 행(row)을 읽는 함수들이에요.
- 새 파일마다 `dispatchX(ctx, path)`를 내보내요. `src/handler.ts` 190번째 줄에서 `dispatchRecruiting` 대신 이 함수들을 차례로 불러요. 다른 route 모듈도 모두 이렇게 연결돼 있어요.
- 경로를 확인하는 순서를 지켜요. 예를 들어 `postings/facets`는 반드시 `postings/{id}`보다 먼저 확인해야 해요.

확인 방법:
- core 테스트 364개가 모두 통과해야 해요.
- `test/openapi-routes.test.ts`(#118)가 통과해야 해요. 이 테스트는 모든 경로를 스펙과 맞춰 보기 때문에, 빠진 경로가 있으면 실패해요.
- `git diff --stat`에 코드 이동과 `handler.ts` 연결 변경만 보여야 해요.

예상 시간: 2~3시간

## 2. `services/core-api/test/core-b-audit.test.ts`를 기능별 테스트로 나누기 (우선순위 2)

이 파일 이름은 #121에서 지운 감사 노트에서 왔어요. 421줄에 회귀 테스트 21개가 있고, 다루는 기능은 12가지예요. 커서와 페이지, 공고, 지원자 파일, 요청 수 제한, 기기, Google 동기화, 프로젝트 블루프린트, 면접, 문서와 내보내기, 소스, 실험, 지원, 오퍼예요. 그래프에서 응집도가 가장 낮은 커뮤니티("Core Audit Tests And Mailer", 0.016)가 이 파일 때문에 생겼어요.

- 각 테스트를 해당 기능의 테스트 파일로 옮겨요. 맞는 파일이 없으면 그 옆에 새로 만들어요. 다 옮긴 뒤 이 파일을 지워요.

확인 방법: 테스트 개수가 그대로이고 모두 통과해야 해요.

예상 시간: 약 1시간

## 3. `services/ai/src/app/domain/entities.py` 나누기 (우선순위 3)

이 파일은 1,020줄이고 클래스가 69개예요. 646곳에서 참조해요. 인증, 경력 근거, 지원, 문서, 프로젝트, 면접, 대화와 작업, AI 사용량, Google 연동, 결제, 실험 엔티티가 한 파일에 모여 있어요.

- `domain/entities/` 패키지로 바꾸고, 영역마다 모듈을 하나씩 만들어요.
- `domain/entities/__init__.py`에서 모든 클래스를 다시 내보내요. 그러면 `from app.domain.entities import X`를 그대로 쓸 수 있어요.
- 영역끼리 서로 참조하는 pydantic 앞쪽 참조(forward reference)와 순환 import를 조심해요.

확인 방법: Python 3.12와 3.15에서 AI 테스트가 모두 통과하고, `ruff`와 `mypy`에서 오류가 없어야 해요.

예상 시간: 1~2시간

## 바꾸지 않을 것

| 그래프 신호 | 바꾸지 않는 이유 |
|---|---|
| `NotFoundError`에 추정(INFERRED) 엣지가 78개 있음 | graphify가 추정한 연결이에요. 코드 문제가 아니에요. |
| 동떨어진 노드 21개 | 대부분 주석에 적힌 `RFC-6266`, `RFC-3339` 같은 표준 이름이에요. |
| `core-api/src/http.ts`를 754곳에서 참조함 | 169줄짜리 공통 HTTP 헬퍼라서 많이 쓰이는 게 정상이에요. |
| `ai/src/app/pgproto.py`가 941줄임 | Postgres 통신 프로토콜 클라이언트 하나라 응집도가 높아요. |
| gateway, core, ai 사이에 코드 연결이 없음 | 세 서비스는 HTTP로만 통신하도록 설계했어요. |
| claim 루프 백오프가 dispatcher 알림과 비슷하다고 나옴 | 문서를 보고 추정한 연결이에요. 둘이 하는 일이 달라 보이지만, 코드로 확인하지는 않았어요. |
| 끝점이 없는 엣지 약 1,280개 | graphify 추출 과정에서 생긴 것이에요. 코드 문제가 아니에요. |

## 작업이 끝난 뒤

`graphify --update`로 그래프를 다시 만들어요. 결과는 workspace의 `graphify-out/push-be`에 저장돼요. recruiting 커뮤니티와 감사 테스트 커뮤니티가 나뉘었는지, 응집도가 올라갔는지 확인해요.
