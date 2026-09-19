# 프론트엔드/백엔드 역량 판단 요소

## 프론트엔드
기본: React/Vue/Next.js 화면 개발, React Query/SWR 서버 상태 관리, lazy loading/code splitting, 시맨틱 태그.
고급: DevTools Performance 탭 렌더링 병목 분석, Core Web Vitals 개선, 번들 분석 후 dynamic import, 전역/서버/로컬 상태 분리, E2E 테스트 자동화.

## 백엔드
기본: EXPLAIN 실행 계획 확인, Redis 캐싱/Pub/Sub, connection pool 설정, k6 부하 테스트.
고급: EXPLAIN key=NULL/Using filesort 관찰 후 인덱스 개선, tcpdump 패킷 분석, JVM/GC 튜닝, 스레드 모델 선택 근거, MCP/AI 도구 개발 통합.

## 문장 단계
1. 기능 나열: "CRUD 개발"
2. 수치 포함: "응답 속도 350ms → 40ms"
3. 관찰 + 근거: "EXPLAIN key=NULL 관찰 후 인덱스 적용"
4. 의사결정 공개: "캐시 선택 기준과 트레이드오프"

고단계일수록 신뢰도가 높아지지만 근거가 부족하면 기본기 부족으로 읽힐 수 있다.
