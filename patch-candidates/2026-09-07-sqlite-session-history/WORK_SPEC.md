# SQLite 세션 영구 보관 반영 명세

## 범위 / 상태
- 기존 SessionStore를 수정하고 내부 SQLite 저장 모듈 및 과거 메시지 페이지 API를 추가한다.
- 산출물: TypeScript Core 저장계층 / 기존 로컬 API 런타임. 외부 서비스·시크릿 불필요.
- 데이터 원천: 기존 세션 JSON과 현재 세션 메시지. 이미지 원본은 기존 파일 저장소 유지.
- 개발 소스에 적용. 메인앱 배포, 실제 사용자 데이터 이관, 실앱 브라우저/HTTP E2E는 수행하지 않았다.
- UI, 메모리 기능, 공급자 정책, 제품 배포 파일은 수정 범위가 아니다.

## 변경 파일 (CQR_PA 기준)
- `core/src/sessions/session-sqlite-store.ts`: 신규 SQLite 저장소.
- `core/src/sessions/session-store.ts`: 저장 연결, append/import 80개 절단 제거, recent/page 조회.
- `core/src/routes/dispatch.ts`: GET /sessions/:id/messages 추가.
- `tools/verify-session-sqlite.mjs`: 격리 회귀 검사.

## 저장 구조
- SessionStore에 전달된 세션 디렉터리의 `sessions.sqlite` 사용.
- `sessions`: ID 및 세션 메타데이터 JSON(정책·소속·모델·private continuation 포함).
- `messages`: session_id + seq 복합 기본키, 메시지별 JSON. 메시지의 첨부 참조, 이미지 URL, 공개 reasoning/도구 표시 필드를 그대로 유지.
- `legacy_imports`: 이관 완료 파일 기록 및 삭제 후 재이관 방지 기록.
- foreign_keys ON, WAL, synchronous FULL, busy_timeout 5000, user_version 1.
- 메시지 추가는 메타데이터 변경과 새 메시지 한 행 INSERT를 단일 트랜잭션으로 수행한다. 이전 메시지를 다시 쓰지 않는다.
- 일반 save는 동일 메시지 행을 다시 쓰지 않고 달라진 행만 저장한다. 명시적인 undo/요약 세션 교체는 기존 의미대로 행 삭제 가능.
- 목록 조회는 메시지 본문을 읽지 않고 메타데이터와 SQL COUNT를 조회한다.
- 작업별 DB 연결을 닫아 파일 핸들을 남기지 않는다. 읽기 중 metadata/messages 및 페이지 조회는 같은 스냅샷 사용.

## JSON 이관
- 초기화 시 기존 .json 세션 파일을 검사한다. 원본 파일은 바이트 그대로 남기며, 이후 운영 저장은 SQLite만 사용한다.
- 각 파일의 메시지·메타데이터와 이관 완료 기록을 한 트랜잭션으로 커밋한다.
- 재시작 시 완료 파일은 재이관하지 않는다. 삭제된 세션도 보존 JSON 때문에 부활하지 않는다.
- 손상 JSON/형식 불일치는 조용히 무시하지 않고 초기화를 실패시킨다. 참조가 누락된 채 파일 GC가 진행되는 것을 방지한다. 원본을 보존한 상태에서 원인 교정 후 재시도한다.
- 이미 성공한 파일의 이관은 유지되고, 실패 파일부터 재시도 가능하다.
- 미래 DB 스키마 버전은 덮어쓰지 않고 거절한다. DB 오류를 빈 세션이나 JSON fallback으로 숨기지 않는다.
- 기존 80개 절단으로 이미 없어진 원문과 삭제된 이미지 파일은 복구할 수 없다.

## 보존 / 조회 / 모델 입력 분리
- append 및 portable import의 80개 자동 절단 제거. 개수 초과에 따른 이미지 prune 호출 제거.
- 모델의 recentMessages는 SQL LIMIT으로 최근 필요한 구간만 읽는다. 저장 전체를 모델에 전달하도록 변경하지 않는다.
- GET /sessions/:id 전체 응답은 기존 클라이언트 호환 유지.
- GET /sessions/:id/messages?limit=50&before=<seq>
  - 기본 50, 범위 1~200. before는 양의 안전 정수이며 exclusive.
  - 응답: messages(오래된 순), has_more, next_before.
  - 첫 요청은 최근 구간, next_before를 다음 요청에 넘겨 과거로 탐색.
  - 잘못된 인수 400, 없는 세션 404. provider continuation은 응답에 포함하지 않는다.
  - append 사이에도 기존 구간 커서가 유지된다. undo/교체 이후에는 클라이언트가 페이지를 다시 로드해야 한다(seq는 영구 메시지 UUID가 아님).
- 이번에는 페이지 API까지만 제공. 화면 무한 스크롤/가상 목록 연동은 미적용이며 기존 전체 조회 방식이 유지된다.

## 첨부 / 삭제 / 백업 운영
- 메시지 첨부 메타데이터는 DB에, 실제 원본은 기존 첨부/출력 파일에 둔다. DB BLOB으로 이동하지 않는다.
- 원본 메시지가 유지되므로 기존 live-ref GC가 오래된 이미지 참조도 보호한다. 세션 명시 삭제 시 기존 공유 참조 보호 및 파일 정리는 유지.
- JSON은 이관 시점 백업이지 최신 운영 기록이 아니다. 세션 삭제 후에도 보존 JSON에는 예전 내용이 남는다. 완전 삭제/백업 폐기는 별도 확인 정책이 필요하다.
- 로컬 디스크/단일 Core 운영 전제. 여러 PC가 NAS SQLite를 동시에 열도록 설계하지 않았다.
- 안전한 운영 이관: 모든 Core 프로세스 종료 → 세션 폴더와 첨부/출력 폴더 일괄 백업 → 새 Core 시작 및 이관 → 세션 수/메시지 수/첨부 재조회 확인.
- 실행 중 DB 본체만 복사하지 않는다. 일관된 백업은 쓰기를 멈춘 상태에서 DB와 존재하는 WAL/SHM, 첨부를 함께 보존하거나 향후 전용 SQLite backup API로 제공해야 한다.
- 롤백 시 새 SQLite에서 생긴 기록을 버리고 예전 JSON만 여는 것은 안전한 롤백이 아니다. 새 데이터 보존·변환 후 구버전 적용 필요. 자동 양방향 동기화 없음.
- 자동 ZIP 백업/복원, 첨부 포함 portable export, 전문검색, 보관함, 보존 정책 UI는 이번 구현에 포함하지 않았다.

## 성능 경계
- append의 디스크 쓰기는 메시지 단위지만 SessionStore 기존 반환 계약 때문에 ensure/load에서 전체 대화를 메모리에 읽는 경로는 남아 있다.
- metadata 수정의 save 비교, loadAll 기반 GC 및 전체 세션 API 역시 긴 기록을 읽을 수 있다. 초대형 대화에서 읽기/렌더링 비용까지 해결한 것으로 주장하지 않는다.
- 다음 성능 작업은 metadata-only 변경/append 반환 계약 축소, GC 참조 인덱스, 클라이언트 페이지 조회 연동이다.

## 검증
명령(CQR_PA에서):
1. `node node_modules/typescript/bin/tsc -p tsconfig.json`
2. `node tools/verify-session-sqlite.mjs`

신규 회귀: JSON 바이트 보존, 120개 이관→282/283개 append 보존, 별도 프로세스 재시작, 3000개 import, 첨부/이미지 파일 GC 생존, 전체 페이지 순회·페이지 사이 append, SQLite insert 실패 주입과 metadata rollback, integrity_check/foreign_key_check, 삭제 후 부활 방지, 손상 원본 복구 후 재시도, 미래 스키마 거절, 실행 정책·private continuation lane 독립 보존, 실제 route 분기 격리 실행.

기존 추가 회귀 통과: chat-attachments, session-temp-gc, session-preferred-model, session-workspace-binding, tool-activity. 코어 컴파일 통과(기존 responses-vault 실행 중 workspace 컴파일도 통과).

전체 회귀가 모두 통과한 것은 아니다:
- verify-session-execution-policy는 저장계층 검사를 지난 뒤 오래된 클라이언트 파일 경로가 없어 중단.
- verify-responses-vault는 공급자 reasoning summary 기대값 불일치로 세션 관련 후반 검사 전에 중단.
- 이 두 테스트/공급자/UI를 이번 변경에서 수정하지 않았다. 저장계층 실행정책/continuation 검사는 신규 SQLite 회귀에 별도로 포함했다.
- 실제 전원 차단/디스크 부족, 실앱 HTTP/브라우저 E2E 및 운영 DB 이관은 미실시. 실패 INSERT 트랜잭션과 별도 프로세스 재시작까지만 검증.
