# Personal pack — 뼈대 vs data

제품 **delta/git 업데이트는 뼈대만** 덮고, 개인 스킬·플러그인·MCP·비밀은 `data/`(또는 외부 pack 백업)에 둔다.  
스펙: `rulebook/docs/specs/technical/agent-plugins.md` — *Delta does not overwrite data/*.

## 포함 트리 (pack = 개인 / 업데이트 생존)

| 슬롯 | 경로 (CQR root 기준) | notes |
|------|----------------------|--------|
| 플러그인 | `data/agent-plugins/` | 로컬 execution tools |
| 사용자 스킬 | `data/skills/` | R-030 `UserSkillStore` (`user:{id}`) |
| MCP | `data/config/user-mcp-servers.json` | stdio only |
| Overrides (비민감) | `data/config/user-overrides.json` | allowlist keys only on export |
| Vault | `data/vault/` | **export 기본 제외** — `--with-vault` only |

Default pack 디렉터리: `%USERPROFILE%\Documents\MY_AGENT_personal_pack`  
오버라이드 (호스트 무관, **파일시스템 경로만**):

- env `CQR_PERSONAL_PACK` 또는 `MY_AGENT_WORK_KIT_LOCKER`
- `data/config/user-overrides.json` → `work_kit_locker_root`
- `deploy-defaults.json` → `work_kit_locker_root`

`http(s)://` / git remote URL은 보관함 루트로 쓰지 않는다 (서버 이전 시에도 동일).

## 제품 git에 유지 (이사 금지)

| 영역 | 위치 |
|------|------|
| 코어 tools / mutate / checkpoint / UI 계약 | `core/`, `ui/workspace`, `shell/` |
| 플러그인 **샘플** | `tools/plugin-templates/*` |
| 번들 스킬 | `core/config/defaults/skills/*` |
| 조직 전용 모듈 | 별도 저장소·서명 업데이트로 관리하며 core pack에서 제외 |
| Domain / automaton | `core/config/defaults/domain-connectors.json`, automaton manifest |

## 업데이트 SOP (3줄 + 확인)

1. `npm run pack:personal:export` (또는 pack git에서 pull)  
2. 제품 delta / `git pull` / 덮어쓰기 (**data/** 건드리지 않음 — delta 기본 동작)  
3. pack을 따로 백업했을 때만 `npm run pack:personal:import`  

확인 (전수 lab 재실행 불필요):

```bash
git status                    # product tree
# + pack 쪽: %USERPROFILE%\Documents\MY_AGENT_personal_pack 또는 CQR_PERSONAL_PACK
npm run pack:personal:export -- --dry-run
npm run lab:realuse:light     # optional smoke
```

## 분류 규칙

**pack으로**

- UI/에이전트로 설치한 로컬 플러그인 인스턴스  
- 사용자 스킬 CRUD  
- MCP 서버 정의  
- vault keys (별도 백업; 기본 export 제외)  
- repo 밖 회사·업무 전용 스크립트 포크  

**product에 유지**

- 모두가 쓰는 핵심 동작 + template 샘플 + brand/domain 제품 계약  

애매하면: pack으로 두고 product PR로 제거. **verify/lab에 묶인 경로 삭제 금지.**

## 감사 경고 (export dry-run 시 출력만)

- `tools/` 아래 개인 실험 폴더처럼 보이는 미문서 경로  
- `core/config/defaults/` 에 번들 manifest 밖 md 추가분  
- 대용량 scratch는 이미 gitignore (`data/_skill_tool_lab` 등)

자동 삭제 없음.

## 명령

```bash
npm run pack:personal:export              # → CQR_PERSONAL_PACK
npm run pack:personal:export -- --dry-run
npm run pack:personal:export -- --with-vault
npm run pack:personal:import
npm run pack:personal:import -- --dry-run
```

심링크는 Windows 권한 이슈로 **1차 기본은 복사** export/import.  
심링크를 쓰려면 pack 트리를 수동으로 `data/` 하위에 mklink /J (문서 optional).

## 관련

- [agent-plugins.md](../../rulebook/docs/specs/technical/agent-plugins.md)  
- [README.md](README.md) lab 스크립트  
- `tools/personal-pack-export.mjs`
