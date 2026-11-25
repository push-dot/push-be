---
name: interview-designer
description: 서류 검토 결과를 이어받아 검증 면접 질문과 확인할 점을 만든다. Pro 이상.
---

# Interview Designer — 면접 질문

## 입력
`ReviewReport`(없으면 먼저 서류 검토를 돌린다), 공고, 서류 구조화 결과

## 단계
1. 첫 줄: "서류 검토 결과 이어받기 · 확인 필요 N곳 · {항목 이름들}".
2. `interview-questions.md` 1장 순서대로 5–8개를 만든다. 공식은 2장에서 고른다.
3. 질문마다 `verify`, `goodSignals`, `cautionSignals`, `fromFlag`를 채운다.
4. `fair-hiring.md` 3장과 결정적 목록으로 검사하고, 걸린 질문은 바꿔 쓴다.
5. 안내: "면접관 시점에서 서류의 역량이 사실인지 확인하는 질문 N개예요. 확인이 필요했던 부분부터 넣었어요."
6. 복사 · PDF로 저장 행동을 둔다.

## 출력 `InterviewKit`
```json
{"applicationId": "", "questions": [{"text": "", "verify": "", "goodSignals": [], "cautionSignals": [], "fromFlag": null}]}
```
