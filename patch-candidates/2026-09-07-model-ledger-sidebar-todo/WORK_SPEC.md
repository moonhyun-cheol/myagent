# WORK_SPEC — 우측 TODO 모델 원장 연결

## 범위
기존 우측 작업 뷰 수정 + 읽기 전용 코어 API 추가. 데이터 기준은 세션의 모델 작성 todo_update 원장이다. 신규 서비스나 비밀키는 필요하지 않다. 메모리 기능은 MEMORY_PLAN.md 기획만 제공하며 저장/제안 런타임 및 기존 데이터는 변경하지 않는다. 메인앱 배포/실행파일 교체는 하지 않는다.

## 변경 계약
- GET /sessions/:id/todos: 세션 존재 확인 후 저장 원장의 todos 및 updatedAt을 반환. 없는 세션 404, 원장 없는 세션 빈 배열. Cache-Control no-store. 내부 workingNotes/retainEvidence는 노출하지 않는다.
- API 클라이언트 fetchSessionTodos: 명시적 sessionId 사용, 응답 세션 확인, AbortSignal 지원. 조회 오류를 빈 정상 데이터로 위장하지 않는다.
- useSessionTodos: 현재 세션 최초/전환/실행 상태 변경 시 즉시 조회, 실행 중 1초·그 외 5초 간격의 완료 후 재예약. 중복 요청 방지, 세션 전환 시 이전 요청 abort, 늦은 응답 무시, 이전 세션 데이터 즉시 차단. 오류 상태와 재시도를 제공한다.
- 우측 뷰는 모델 id/text/status만 표시한다. doing → active는 기존 표시 타입 어댑터일 뿐 진행 판단이 아니다. busy는 조회 주기에만 사용한다.
- 답변 체크박스·번호 제목·일반 번호·굵은 목록 파싱과 busy 기반 첫 항목 진행 추정을 삭제했다. 번호는 표시 순번으로만 남는다.
- 원장 없을 때 ‘모델이 등록한 작업이 없습니다.’ 표시. 조회 실패와 빈 원장을 구분한다.

## 메인앱 반영 단위
코어 routes/dispatch의 TODO 조회 분기, 클라이언트 fetchSessionTodos 및 SessionTodoItem 타입, 신규 useSessionTodos 훅, 기존 우측 뷰 데이터 공급부 교체와 TODO 빈 상태·오류 메시지를 함께 반영한다. 회귀 스크립트는 tools/verify-sidebar-todos.mjs. API만 또는 뷰만 부분 배포하지 않는다.

## 검증 결과
2026-09-07 명시 실행, exit 0:
- 코어 TypeScript 컴파일.
- UI TypeScript 프로젝트 컴파일.
- tools/verify-sidebar-todos.mjs: 실제 조회 분기를 저장 원장 및 테스트 응답 객체로 실행. 세션 격리/원장 없음/404/내부 노트 미노출 확인. 실제 훅을 결정적 effect/timer harness로 실행하여 상태 변환, busy와 상태 독립성, 폴링 주기, 세션 전환, 늦은 응답, 실패 메시지, 정리 확인. 답변 파서 제거 검사.
- tools/verify-todo-ledger.mjs: 기존 원장 병합·저장 회귀 통과.

초기 컴파일에서 SessionStore.get 사용 오류를 발견했고 기존 load API로 교정한 뒤 전체 검증을 다시 통과했다.

## 한계 및 운영 참고
실제 브라우저 화면 클릭 E2E, HTTP 서버 end-to-end 및 배포 실행파일 확인은 이번 검증에 포함하지 않는다. 테스트는 경로 분기와 실제 훅을 격리 실행한 것이다. 조회는 SSE가 아닌 폴링이며 실행 상태에 따라 최대 약 1~5초 후 갱신된다(통신 시간 제외). 기존 원장의 누락 항목 보존 정책은 그대로이므로 과거 TODO가 남는 문제는 별도 원장 수명주기 정책으로 다뤄야 한다. 모델이 todo_update를 호출하지 않으면 UI는 작업을 만들어내지 않는다.

메모리 제안·승인·사용·삭제·마이그레이션 정책과 수용 기준은 MEMORY_PLAN.md 참조.
