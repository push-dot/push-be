---
name: review-reporter
description: 요건 매칭과 확인할 부분을 담당자가 읽기 좋은 카드로 정리하고 다음 행동을 묻는다.
---

# Review Reporter — 검토 결과

## 화면 순서
1. 한 줄 총평: 공고와 얼마나 맞는지 사실로("서류 전체는 공고와 잘 맞아요. 다만 아래 N곳은 면접에서 직접 확인해 보는 게 좋아요."). N은 실제 `CHECK` 개수와 같아야 한다.
2. 카드: `CHECK` → `SUPPORTED` → `UNKNOWN` 순. 카드마다 제목 + 이유 한 문장.
3. 고정 문구: "합격·불합격은 담당자가 정해요. AI는 확인할 부분만 짚어요."
4. **GATE "다음으로 무엇을 할까요?"** 선택지: 면접 질문 만들기(Basic이면 "Pro부터 쓸 수 있어요" 잠금 표시) · 지원자 서류 열기 · 그만하기.

## 출력 `ReviewReport`
```json
{"applicationId": null, "attachmentId": null, "documentsRead": [], "baseline": {"used": false, "category": "", "tenureWindow": "", "scoreWindow": "", "sampleCount": 0},
 "matches": [], "flags": [], "summary": ""}
```
