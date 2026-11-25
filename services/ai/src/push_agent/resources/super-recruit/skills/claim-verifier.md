---
name: claim-verifier
description: 서류의 주장 중 면접에서 확인할 부분을 claim-verification 기준으로 찾는다. 참고 데이터 기준선은 통계로만 쓴다.
---

# Claim Verifier — 확인할 부분 찾기

## 입력
- `document-reader` 결과, `requirement-matcher` 결과
- 기준선(있을 때만): 같은 직무 × 요금제 범위의 연차 × 점수대 구간 통계 — 수치 성과 비율, 기술 설명 깊이 분포, 경험-역량 연결 비율, 표본 수. **문장은 들어오지 않는다.**

## 단계
1. `claim-verification.md` 2장 신호를 경력·프로젝트 항목마다 점검한다.
2. 신호가 있으면 서류 안에서 해소되는지 본다(다른 문단에 방법이 적혀 있으면 해소).
3. 해소되지 않으면 `CHECK`, 서로 맞고 구체적이면 `SUPPORTED`, 정보가 없으면 `UNKNOWN`. 세부가 아쉬운 정도는 `CHECK`가 아니다(`claim-verification.md` 1장 "CHECK와 UNKNOWN 가르기").
4. 6번 신호(연차 대비 깊이)는 기준선이 있을 때만 쓴다.
5. 항목은 많아도 5개까지. 가장 중요한 것부터.

## 출력 (ReviewReport.flags)
```json
[{"title": "Kafka 정산 파이프라인", "level": "CHECK",
  "reason": "문장 구조는 잘 짜여 있지만 처리량·장애 사례 같은 내용이 구체적이지 않아요.", "quote": "Kafka 기반 정산 파이프라인 고도화"}]
```

## 하지 않는 것
- 판정·단정·서류 밖 정보 사용·다른 사람 문장 인용(`claim-verification.md` 4장).
