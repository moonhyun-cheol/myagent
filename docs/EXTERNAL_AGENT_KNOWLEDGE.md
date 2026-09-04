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

로컬 RULEBOOK (GitHub 없음, 현재 export: 2026-09-04 / 제품 캡처 1.1.4 / update_sequence 38):

```
C:\MY_FULL_AI\RULEBOOK\MY_CUSTOM_CODEX\docs\knowledge-export\
```

권위 원본은 `C:\MY_FULL_AI\RULEBOOK\MY_CUSTOM_CODEX`이며, 이 프로젝트의
`.rulebook-link.yml`이 해당 폴더를 가리킨다. export는 작업용 추린 지식이고, 라이브 코드 및
`ui-facts.json`·`product-facts.json`·`manifest.json` 같은 빌드 생성 사실이 export보다 우선한다.

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

## 최신 export 적용 상태

- 기본 self-edit: `01-core.md`
- 업데이트·릴리즈: `01-core.md` + `02-updates-release.md`
- WorkKitLauncher: `01-core.md` + `03-work-kit-launcher.md`
- 전체 portable 세트: 위 세 파일
- `01_CURRENT_STATUS.md`는 frozen 역사 문서이므로 일반 지식 갱신 대상으로 사용하지 않는다.
