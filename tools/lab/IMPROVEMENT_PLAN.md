# MY Agent 개선 방안

근거: lab / Desktop `CQR_AllSkill_Demo` 에이전트-only / delivery 재검증 (2026-08-04)  
HEAD 기준 반영: `beb1ffa3` (Autopilot 종료), `707c1dc2` (probe·multi-path·localhost 등)

---

## 0. 완료된 것 (재작업 금지·회귀만)

| ID | 내용 | 커밋/위치 |
|----|------|-----------|
| R1 | OWUI probe `timeoutMs` plumb | `agent-llm-step.ts` → `resolveAgentStepTimeoutMs` |
| R2 | multi-path 조기 완료 차단 | `evaluateTaskChecklist` + outcome `task_checklist` |
| R3 | code-agent localhost 기본 on | `workspace-agent.ts` (`!== false`) |
| R4 | lab fixture `npm test` | `tools/lab/runners/tools-direct.mjs` |
| R5 | L2 skill 아티팩트 옵트인 | `MY_AGENT_LAB_L2_ARTIFACT=1` |
| R6 | Autopilot 잔루프 차단 | `isTaskChecklistComplete` + step-loop |
| R7 | code OWUI 기본 `text` (probe opt-in) | `harness-policy.ts` + verifiers |
| R8 | finish scrub TOOL_CALL / WIRING_SMOKE | `sanitizeFinalAgentContent` + finish |
| R9 | greenfield default file set | `buildTaskChecklist` + system note |
| R10 | Autopilot empty-after-mutate cap 3 | `autopilotEmptyAfterMutate` |
| R11 | evidence weak ≠ pass 템플릿 | `formatEvidenceBlock` |
| R12 | cold multi-create skips retrieval-first | `looksLikeColdMultiCreate` |
| R13 | finish scrub residual 「다음 조치」 after 완료 | `sanitizeFinalAgentContent` |
| R14 | maxstress workspace pollution guard + semantic markers + http DOM | `agent-only-maxstress.mjs` |
| R15 | full-surface lab: browser/OpenClaw/market/shell/embed | `tools/lab/full-surface-stress.mjs` |
| R16 | perf: first_tool_ms + autopilot_force_count | `agent-perf-metrics` + finish |
| R17 | pre-model first status (silent wait cut) | `agent-run-step-loop` |
| R18 | shell inAppBrowser case matrix + click-path honesty | `shell-ui-surface.mjs` |
| R19 | skill quality always-on surface | `skill-quality-surface.mjs` |
| R20 | pathless greenfield fixture (3 prompts, no LLM) | `greenfield-pathless.mjs` |
| R21 | OpenClaw runbook | `tools/lab/OPENCLAW_RUNBOOK.md` |
| R22 | market parse probe + never-auto full research row | `market-pipeline-surface.mjs` |
| R23 | stream preview UI 분리 (code final bubble vs token preview) | `ChatTurn.streamPreview` + ChatPane + store |
| — | predeploy stage deferred node/venv | `predeploy-check.mjs` |
| — | lab/납기 드라이버 | `lab:harsh`, `agent-only-desktop`, delivery-acceptance |

**재검증 수치 (Desktop):** steps 31 → **2**, Autopilot 강제 0, ~81s, mutate 10 paths, `npm test` pass.

---

## 1. 목표

코드 에이전트를 **“만들 수 있음” → “빠르고 조용히 끝남 + 유저 프롬프트가 허술해도 덜 깨짐”** 으로 한 단계 올린다.  
납기 기본 게이트는 유지하고, **유료 live / OpenClaw live** 는 여전히 옵트인.

---

## 2. 우선순위 로드맵

### P0 — 다음 스프린트 (1–2일)

#### P0.1 코드 에이전트 기본 프로토콜 정리 — **DONE (R7)**

**문제:** 기본 `MY_AGENT_CODE_OWUI_PROTOCOL=probe` 는 수리됐지만, multi-file 실전은 TEXT가 안정. 팀 기본값 혼선.

**방안:** ~~기본 text + probe opt-in~~ 적용됨. 배포 권장: `OPS_RESIDUAL_FIXES.md`.

**완료 증거:** `verify:coding-iq` / `verify:harness-policy` 골든 text.

---

#### P0.2 최종 답변 sanitize 강화 — **DONE (R8)**

**문제:** Desktop 런 리포트 `content` 에 WIRING_SMOKE 잔여 언급·`TOOL_CALL` 잔여 문구.

**방안:** `sanitizeFinalAgentContent` + `scrubAgentChannelLeak` 확장 + finish 통합.

**완료 증거:** coding-iq scrub 골든.

---

#### P0.3 모호 프롬프트 multi-file 가이드 — **DONE (R9)**

**문제:** 경로 목록이 있을 때 강함. 「뭐 하나 만들어줘」는 여전히 취약.

**방안:** soft default set (`index.html`/`app.js`/`styles.css`/`package.json`/`README.md`) + system note.

**완료 증거:** coding-iq greenfield-default-set.

---

### P1 — 체감·품질 (3–5일)

#### P1.1 첫 LLM 스텝 지연 (70s 스트리밍) — DONE product side (R17 + R23)

**방안 (제품 쪽만, 모델 성능 제외):**
1. greenfield multi-write: 메시지를 “한 번에 N개 write_file” + **max stream preview UI 분리**  
2. retrieval-first 자동 list_directory 유지, 단 cold greenfield에서 **embedding 생략** already soft — 중복 list 줄이기  
3. `MY_AGENT_CODE_AUTOPILOT=1` 시 “첫 응답 전 status” 만 남기고 probe skip 유지

**적용:**
- pre-model `에이전트 시작 · …` status (R17); greenfield batch write note; default protocol text (R7)
- **R23:** code/web_dev 턴 메인 bubble = `작업 중…` / final only; partial tokens → `streamPreview` 접이식 (“스트림 미리보기 · 공식 답 아님”); done 시 클리어

**남은 것 (ops):** Desktop first-parse 중앙값 <45s 기록 — `data/logs/agent-perf.jsonl` 의 `first_tool_ms` 3런 중앙값 (환경 의존).

**완료 증거 (제품):** 코딩 턴 중 메인 ≠ 토큰 스팸; preview 배지 + 종료 후 preview 없음.

---

#### P1.2 verify weak 종료 UX — **DONE (R11)**

**문제:** `run_diagnostics` weak / tests pass 혼재 시 유저가 “실패”로 오해.

**방안:** evidence `mutate: N | tests: … | diag: …` + weak never 검증 통과.

---

#### P1.3 Playwright 온보딩 — partial (bootstrap already in ERROR strings)

**방안:**
1. 첫 `playwright unavailable` → status에 bootstrap 스크립트 1줄 — **product ERROR already includes bootstrap path**  
2. install optional component 체크리스트에 Playwright  
3. product-browser 스모크를 `lab:product-browser` 로 delivery residual optional 플래그

---

#### P1.4 스킬 “결과물” 레이어 (inject ≠ 납품) — partial DONE (R19)

**방안:**
1. `MY_AGENT_LAB_L2_ARTIFACT=1` 유지; 유료: `MY_AGENT_LAB_L2_LLM=1` **소형 생성 1파일** (skill당 1샷, cap 토큰)
2. UI: skill 칩 “미리보기 템플릿” = bundle head 600c (이미 아티팩트 경로)  
3. 시장 파이프: brand_manager 미설치 시 **never ready** (이미 not ready 경로 점검)

**적용:** always-on `skill-quality-surface` (route+inject + honesty rows).  
**남은 것:** 실제 paid 1-shot LLM 스킬 스모크(비용 옵트인).

**완료 증거:** 스킬 5개 라우트 + 아티팩트 md 5; LLM 옵트인 시 1 skill smoke.

---

### P2 — 운영·관측

| ID | 방안 | 상태 |
|----|------|------|
| P2.1 | agent-perf: first_tool_ms / autopilot_force_count | **DONE (R16)** |
| P2.2 | OpenClaw: health only CI; slash runbook 1p | **DONE (R21)** |
| P2.3 | delivery-acceptance residual 문구 R1–R15 닫힘 | **DONE** |
| P2.4 | facts.json 빌드 산출 commit 정책 | **ops**: 타임스탬프만 변경 시 commit 금지 (기존 관례) |

---

## 3. 구현 순서 (권장)

```
Week 1
  day 1–2  P0.1 프로토콜 기본값 + 문서
  day 2    P0.2 finish sanitize + 골든
  day 3    P0.3 greenfield soft checklist
  day 4    Desktop agent-only 회귀 + lab:strict
  day 5    P1.2 verify 요약 템플릿

Week 2 (옵션)
  P1.1 지연 완화 / P1.3 Playwright 온보딩 / P1.4 skill LLM 옵트인
```

---

## 4. 검증 매트릭스 (매 패치 후)

| 명령 | 기대 |
|------|------|
| `npm run verify:coding-iq` | ok |
| `npm run verify:harness-policy` | ok |
| `npm run lab:skills-tools:strict` | fail 0 |
| `npm run lab:agent-only-desktop` | ok, **steps ≤ 6**, Autopilot 강제 0 |
| `cd Desktop\CQR_AllSkill_Demo && npm test` | pass |
| (옵션) `lab:delivery-acceptance --full-agent` | PASS |

**회귀 금지:** steps가 다시 30+ 로 늘면 Autopilot/checklist 회귀로 취급.

---

## 5. 하지 말 것

- Ollama를 coding 기본 경로로 복귀  
- OpenClaw live 를 기본 CI fail 조건으로  
- OWUI 네이티브 tools “항상 성공” 가정  
- lab PASS = 모든 skill 업무 품질 보증 (과대 주장 금지)

---

## 6. 성공 정의 (다음 마일스톤)

1. Desktop 동일 시나리오 3연타: **steps ≤ 6, missing=[], Autopilot force=0**  
2. 최종 유저 답변에 **TOOL_CALL / 내부 smoke 마커 0**  
3. 경로 없는 greenfield 프롬프트 1종 fixture agent-only **부분 성공(PARTIAL 허용 시 명시)**  
4. 문서: 코딩 권장 env 1페이지 = install README / OPS 일치  

---

## 7. 즉시 착수 시 첫 PR 스코프 (복붙용)

```
fix(agent): tighten finish prose + optional CODE_OWUI default text

- scrub residual TOOL_CALL / internal smoke markers from final answer
- document coding protocol recommendation (text vs probe)
- golden in verify-coding-iq or new verify-finish-scrub
- no behavior change to mutate path when checklist incomplete
```

---

## 8. 참고 경로

| 영역 | 경로 |
|------|------|
| Autopilot pause | `core/src/agent/tool-content-guards.ts` |
| Checklist | `core/src/agent/agent-task-checklist.ts` |
| Step loop | `core/src/agent/agent-run-step-loop.ts` |
| Probe timeout | `core/src/agent/agent-llm-step.ts` |
| Desktop 드라이버 | `tools/lab/agent-only-desktop.mjs` |
| Residual ops | `tools/lab/OPS_RESIDUAL_FIXES.md` |
