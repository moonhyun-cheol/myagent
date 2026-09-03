# External agent knowledge (index)

MY Agent repo **안에는** 역공학 명세 본문을 두지 않습니다 (ADR-RE-008).

## 이 repo에서 붙일 것

| 우선 | 파일 |
|------|------|
| 1 | `AGENTS.md` |
| 2 | `core/config/defaults/ui-facts.json` |
| 3 | `core/config/defaults/product-facts.json` |
| 4 | `core/config/defaults/skills/my-agent-self-edit.md` |

## Cursor / Claude / 다른 프로그램 — 추린 export

로컬 RULEBOOK (GitHub 없음):

```
C:\MY_FULL_AI\RULEBOOK\MY_CUSTOM_CODEX\docs\knowledge-export\
```

| 파일 | 언제 |
|------|------|
| **`01-core.md`** | 기본 (대부분 self-edit) |
| `02-updates-release.md` | 업데이트·릴리즈·확인창 |
| `03-work-kit-launcher.md` | WorkKitLauncher·키트 |
| `README.md` | 붙이는 방법 |
| `manifest.json` | bundle 이름 (`default_self_edit`, …) |

**최소:** `01-core.md` 하나만 첨부해도 구조·P0·코드맵은 커버됩니다.

## 붙이지 말 것

- `RULEBOOK/.../docs/01_CURRENT_STATUS.md` (frozen)
- `RULEBOOK/.../docs/generated/RULEBOOK_*` (과도하게 김)
- 이 repo의 `rulebook/` (없어야 정상)
