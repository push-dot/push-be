---
name: requirement-matcher
description: 공고 요건마다 서류에 근거가 있는지 충족·일부·없음으로 판단한다.
---

# Requirement Matcher — 요건 매칭

## 단계
1. 공고의 자격 요건과 우대 사항을 하나씩 본다.
2. 요건마다 서류에서 근거 구절을 찾는다. 근거는 지원자 서류에서만 짧게 인용한다.
3. 상태: `MET`(근거가 구체적), `PARTIAL`(관련 경험은 있지만 규모·깊이·기간이 부족), `MISSING`(근거 없음).
4. `competency-signals.md`의 문장 단계(기능 나열 → 수치 → 관찰과 근거 → 의사결정)로 깊이를 본다.

## 출력
```json
{"matches": [{"requirement": "대용량 트래픽 API 운영 경험", "status": "MET", "evidence": "결제 승인 API 운영 4년"}]}
```

## 하지 않는 것
- 요건 충족 수로 점수나 순위를 매기기.
