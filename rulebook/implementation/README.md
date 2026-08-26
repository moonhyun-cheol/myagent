# Rulebook implementation (별도 패키지)

룰북 `final-change-proposal-draft.md`의 **Package A–C**를 기존 제품과 분리해 추적합니다.
구현은 `core/`, `shell/`, `ui/workspace/`에 반영되고, **검증만 이 폴더에서 한 번에** 돌립니다.

## 최종 검증 (당신이 할 일)

```bash
npm run build
npm run verify:rulebook-implementation
```

성공하면 Package A–C 자동 증거 + RC-001~012(RC-006 제외) 계약이 통과한 상태입니다.

증거 기록까지 남기려면:

```bash
node rulebook/checks/verify-implementation.mjs --record
```

## 패키지 매핑

| 패키지 | 관련 RC | 자동 검증 | 수동 |
|--------|---------|-----------|------|
| [A — telemetry 제거](package-a-no-telemetry/ACCEPTANCE.md) | RC-012 확장 | `tools/verify-no-debug-telemetry.mjs` | — |
| [B — URL 경계](package-b-url-boundary/ACCEPTANCE.md) | RC-003 | `rulebook/checks/verify-contracts.mjs` | — |
| [C — 인앱 브라우저](package-c-in-app-browser/ACCEPTANCE.md) | RC-006 | `tools/verify-in-app-browser-path.mjs` | [MANUAL.md](package-c-in-app-browser/MANUAL.md) |

## v1 docs와의 관계

- **규범**: `rulebook/contracts/scenarios/RC-*.yml`
- **기억**: `rulebook/docs/` (완료 표시 ≠ 검증 PASS)
- **이 폴더**: proposal A–C 구현·검증 전용. v1 Rule Index를 대체하지 않음.

## 아직 계약 밖

- R-004 bundled-skill immutability
- R-020~041 session/project/skill CRUD
- R-055 license (격리 vault 필요)
- R-067 attachments/keyframes

이후 항목은 RC 신규 + fixture/oracle 추가 후 같은 `verify:rulebook-implementation`에 편입합니다.
