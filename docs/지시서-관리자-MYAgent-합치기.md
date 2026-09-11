# 지시서 — MY Agent 관리자 → MY Agent 합치기

> **구현하지 말고, 이 지시서만 따른다.**  
> 대상: `WorkKitLauncher.exe`(공개명 **MY Agent 관리자**)의 기능을 `MYAgent.exe` 안으로 통합.  
> **범위 밖:** CQR-ORG / `myagent-org` / `MY_CUSTOM_CODEX-COMPANY` 저장소·피드·서명 파이프라인. 건드리지 않는다.

---

## 0. 목표 (한 줄)

사용자는 **MY Agent 하나**에서 작업 키트를 받고·적용하고·해제한다. 별도 `WorkKitLauncher.exe` / `/launcher/` / 「MY Agent 관리자」바로가기는 없앤다.

CQR-ORG는 계속 **별도 콘텐츠 소스**다. 합치는 것은 **관리자 UI ↔ MY Agent UI**뿐이다.

---

## 1. 하지 말 것

1. CQR-ORG 레포를 코어에 합치지 말 것.
2. 조직 모듈 ZIP과 작업 키트 카탈로그 피드를 하나로 합치지 말 것 (업데이트 갈래 유지).
3. 채팅(`ChatPane`)에 키트 목록 UI를 넣지 말 것. **설정(또는 설정과 동급의 전용 설정 화면)**에 둔다.
4. apply에 런타임 pin / `ui.pinned_skill_ids` 강제 재도입하지 말 것 (현행: pull + `plugins.enable` + optional `features.enable`).
5. 「프로필」「작업 환경」 사용자 표기 복구 금지. 사용자 문구는 **작업 키트**.
6. RULEBOOK을 제품 repo에 `rulebook/`로 복사하지 말 것.

---

## 2. 유지할 것 (합쳐도 그대로)

| 항목 | 비고 |
|------|------|
| `/profiles*` API | 키트 목록·refresh·install·apply·unapply·restore |
| `/organization-module*` | 설정 → 스킬과 공유. 키트 적용 전 sync 가능 |
| 작업 키트 카탈로그 피드 | `work-kits.json` (CQR-ORG 게시) |
| 조직 모듈 피드 | `channels/beta.json` 등 (CQR-ORG 게시) |
| 코어 업데이트 갈래 | `stable.json` + idle gate + `MYAgent.Updater` |
| 조직 스킬 선택 | composer `+` → `/skills/selectable` → `org:{id}` |

---

## 3. 옮길 기능 (관리자 → MY Agent)

`ui/work-kit-launcher`의 `ProfileLibrary`가 하는 일을 MY Agent `ui/workspace`로 이전한다.

필수 UX:

1. 작업 키트 카탈로그 목록 표시 (그룹/shelf)
2. 목록 새로고침 (`check` → `refresh`)
3. shelf 단위 받기 / 설치 파일 제거
4. 적용 / 적용 해제
5. 직전 상태 복원 (있으면 유지)
6. 적용된 키트·Organization Feature 상태 표시
7. 키트가 `needs_organization_module`이면 적용 전 org 모듈 sync (현 `syncOrganizationModuleIfNeeded`와 동등)

진입점 (권장):

- **설정 → 스킬** 아래에 「작업 키트」섹션을 두거나
- **설정**에 「작업 키트」전용 페이지를 추가

현 카피 가이드를 뒤집는다:

- 기존: 「작업 키트는 MY Agent 관리자에서…」
- 변경: 같은 설정 화면에서 키트를 관리한다. 관리자 안내는 삭제.

「MY Agent 실행」버튼(`launcher.launchMyAgent`)은 **불필요** (이미 MY Agent 안이므로 제거).

---

## 4. 제거할 것 (완료 조건에 포함)

| 제거 대상 | 경로/식별 |
|-----------|-----------|
| 런처 WPF 셸 | `shell/WorkKitLauncher/` |
| 런처 SPA (이전 후) | `ui/work-kit-launcher/` (코드 이전 완료 후 삭제) |
| `/launcher/` 서빙 | `api-server` / `dispatch`의 launcher UI 루트 |
| 런처 업데이트 갈래 | `channels/launcher-stable.json`, `launcher-manifest.json`, `publish:launcher-*`, `--apply-update` |
| 설치 번들의 런처 | `MYAgent-*-install.zip`에서 `WorkKitLauncher.exe`·런처 web 제외 |
| 런처 단독 install | `WorkKitLauncher-*-install.zip`, `install-launcher.*` |
| 바로가기 | `MY Agent 관리자.lnk` |
| Companion 프롬프트가 런처를 띄우는 경로 | R-618: `WorkKitLauncher --companion-update` → **MY Agent 안에서 catalog refresh만** 하도록 재정의하거나 폐기 |

코어 셸의 `WorkEnvironmentUpdatePollingService`가 `WorkKitLauncher.exe`를 spawn 하면, **같은 머신에서 별 exe 없이** 카탈로그 pending만 처리하도록 바꾼다 (또는 pending UI를 설정/토스트로 대체).

---

## 5. 계약·문서 갱신 (코드와 같이)

제품/에이전트 기억에서 다음을 **반대로** 고친다.

| 출처 | 변경 |
|------|------|
| `AGENTS.md` | Work kits UI = MY Agent 설정. 「No work-kit UI in Settings」삭제. Single product UI에 키트 포함. |
| `core/config/defaults/ui-facts.json` | launcher shell/ui/`/launcher/` 항목 제거 또는 workspace 경로로 교체. `node tools/sync-product-facts.mjs` 재실행. |
| `product-facts.json` | `work_kit_launcher_*` layout 정리 (생성기 기준). |
| RULEBOOK (외부) | R-616: 「별도 WinExe」→ 「MY Agent 설정 내 작업 키트 UI」. R-617 런처 갈래 폐기 또는 deprecated. R-618 companion을 코어 전용으로 재작성. |
| knowledge-export | `01-core.md`, `03-work-kit-launcher.md` — 합친 뒤 export 갱신 또는 `03`을 「legacy/제거됨」으로 표시. |

제품 repo에 RULEBOOK 본문을 복사하지 말고, **외부 RULEBOOK만** 갱신한다.

---

## 6. 구현 순서 (권장)

1. **UI 이전:** `ProfileLibrary` (+ 필요 API 클라이언트)를 `ui/workspace` 설정에 이식. 동작 확인.
2. **카피/진입점:** SettingsSkillsPage 등 관리자 안내 문구 제거. 일반→설치 폴더의 관리자 관련 문구 정리.
3. **Companion/pending:** 셸이 런처 exe를 부르지 않게 변경. 카탈로그 갱신은 코어 API만.
4. **서빙·빌드:** `/launcher/`·런처 publish 스크립트·설치 스테이지에서 런처 제외.
5. **삭제:** `shell/WorkKitLauncher`, `ui/work-kit-launcher`, launcher 채널/매니페스트, 관련 verify의 “런처 필수” 항목을 “없어야 함”으로 뒤집기.
6. **문서·facts·AGENTS** 동기화.
7. **검증** (아래).

한 PR/한 패치에 UI 이전 + 런처 삭제를 같이 해도 되나, 리스크를 나누려면  
**(A) UI를 Settings에 추가하되 런처는 임시 병행 → (B) 런처 제거** 2단계도 허용.

---

## 7. 검증 (Done = 증거)

최소:

1. MY Agent만 실행 → 설정에서 키트 목록·받기·적용·해제 가능.
2. 적용 후 채팅/에이전트에 키트 효과 반영 (예: ops → Automaton Feature / slash).
3. `WorkKitLauncher.exe` 없이도 설치·업데이트·기동.
4. 조직 모듈은 설정 → 스킬에서 기존처럼 받기/업데이트 가능 (CQR-ORG 피드 유지).
5. `verify-publish-bundle` 등: 런처 exe **미포함**이 통과 조건.
6. 업데이트 갈래: 코어 / 조직 모듈 / 키트 카탈로그는 유지. **런처 갈래는 없음**.

UI는 `tsc`만으로 Done 처리하지 말 것. 설정 화면 경로 한 줄 + 적용 동작을 남길 것.

---

## 8. 공개 메시지 (사용자향)

- 이전: 「작업 키트는 MY Agent 관리자에서 설정」
- 이후: 「설정에서 작업 키트를 받고 적용합니다. MY Agent 관리자 프로그램은 더 이상 사용하지 않습니다.」

마이그레이션: 이미 설치된 `WorkKitLauncher.exe`는 무시하거나 다음 코어 업데이트에서 삭제. 강제 마이그레이션 스크립트는 필수가 아님 (명시하면 가산).

---

## 9. 완료 정의

다음이 모두 참일 때만 완료.

- [ ] 작업 키트 UI가 MY Agent 설정에 있다.
- [ ] `WorkKitLauncher.exe` / `/launcher/` / 런처 업데이트 피드가 제품 경로에서 제거되었다.
- [ ] CQR-ORG 저장소·조직 모듈·키트 카탈로그 피드는 그대로 분리되어 있다.
- [ ] AGENTS.md · ui-facts · (외부) R-616 계열이 새 구조와 일치한다.
- [ ] 위 검증 항목에 실행 증거가 있다.

---

## 10. 한 줄 요약 (에이전트용)

**CQR-ORG는 건드리지 말고, 관리자(`WorkKitLauncher`)의 작업 키트 UI만 MY Agent 설정으로 옮긴 뒤 런처 exe·`/launcher/`·런처 업데이트 갈래를 제거하라. R-616을 그에 맞게 갱신하라.**
