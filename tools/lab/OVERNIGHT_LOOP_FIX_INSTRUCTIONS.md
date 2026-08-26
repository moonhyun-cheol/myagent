# Overnight 지시서 — Loop → Fix → Loop (정직한 성숙도)

**대상:** Cursor Agent 채팅 1개 (이 문서 전체를 첫 메시지로 붙여넣기)  
**창:** 지금 ~ **다음날 08:30 KST** (또는 사용자가 준 until)  
**저장소:** `MY Agent`
**채점 정책:** `cold-v2-no-history-gaming` — history로 만점 금지·가짜 daily live 금지  
**목표 철학:** 지금 overnight-cold-loop처럼 “재측정만”이 **아니다**.  
**반드시 `측정 → 실패 1개 고침 → 재측정`을 반복한다.**

---

## 0. 한 줄 미션

> 루프가 끝나면 **왜 점수가 안 오르는지 1가지만** 고치고,  
> 다시 루프(검증)를 돌린다. 끝날 때까지 반복.  
> 점수 과장·history 패딩·“allPass=true지만 제품은 그대로” 금지.

---

## 1. 성공 정의 (우선순위)

| 순위 | 목표 | 판정 |
|:----:|------|------|
| **P0** | 정직한 점수 유지 | `maturity-scorecard` policy = cold-v2 · history gaming 없음 |
| **P1** | **min(dim) 올리기** | `daily_loop` → `l1_hardbars` → `cursor_feel` 순으로 BELOW 해소 |
| **P2** | mean 상승 | productMean **≥ 90** (가능하면), 최종 리포트에 기록 |
| **P3** | allPass (전 과목 ≥95) | **가능하면**, 무리한 치팅 없이. 못 닫으면 정직 보고 |
| **금지** | Cursor 토큰 탕진 | 의미 없는 full live 연속 재시도, 장문 탐험, 무관한 리팩터 |

**베이스라인 (시작 시 cold 예시, 갱신 가능):**

| dim | 예 | 주 병목 |
|-----|----|---------|
| three_plane | 100 | 유지·회귀만 |
| harness_l0 | 100 | 유지·회귀만 |
| l1_hardbars | 82 | 연속 full live green 부족·live 불안정 |
| cursor_feel | 88 | consecutiveFull&lt;2 상한 + path 품질 |
| daily_loop | 55 | `no_real_daily_live` |

---

## 2. 반드시 따를 작업 사이클 (핵심)

한 사이클 = **측정 → 분류 → 수정 1건 → 재검증**.  
“고치기 전에 루프 N회 돌리기만” 금지. **고친 뒤에만** 다음 루프.

```text
CYCLE:
  1. MEASURE   측정 (기본 L0; live는 규칙 안에서만)
  2. TRIAGE    실패/BELOW 1줄 원인 확정 (파일·케이스 id 명시)
  3. FIX       그 원인에 대한 최소 패치 1개 (관련 골든/게이트 포함 가능)
  4. PROVE     L0 재검증 → (해당 시) 좁은 live 재측정
  5. LOG       한 줄 기록 (무엇을 고쳤고 점수가 어떻게 변했는지)
  6. 시간 남으면 CYCLE 반복, 08:30 전이면 FINAL REPORT
```

### 2.1 MEASURE (기본 명령)

시작·매 사이클 초반:

```powershell
cd C:\Users\Temp\Desktop\업무\MY Agent
npm run build
node tools/lab/daily-smoke.mjs --offline-only
node tools/lab/maturity-scorecard.mjs --cold
```

점수는 **항상** `data/_skill_tool_lab/maturity-scorecard.md` (+ `.json`) 를 읽는다.  
기억·이전 100점 자랑 금지.

### 2.2 TRIAGE (한 번에 1개만)

`scores` 중 **target(95) 미달 중 가장 낮은 dim** 1개만 고른다.

| dim 병목 | 고칠 쪽 (우선 후보) |
|----------|---------------------|
| **daily_loop** | `daily-smoke` full live 1회 성공 경로 · report에 history 위조 금지 · API up · real live rows |
| **l1_hardbars** | live hard bar 실패 케이스 id · empty/abandon · 라우팅/timeout/content scrub · backtest scorer가 아닌 **제품 응답/툴 경로** |
| **cursor_feel** | clone/HITL/workspace mutate path · hardOk+contentPreview 품질 · consecutive full live ≥2 |
| **harness_l0 / three_plane** | offline fail → 해당 verify 골든·classifier; 회귀면 즉시 수리 |

`maturity-scorecard`의 `details` / live json fail id를 **근거**로 쓴다. 추측만으로 패치 금지.

### 2.3 FIX (규칙)

1. **한 사이클 = 1 theme** (한 실패군). “전반 개선” 금지.  
2. 제품 코드 + (필요 시) **골든/lab 스크립트** 동시 수정 가능.  
3. **점수기만 완화해서 만점** 만드는 것 **금지**  
   - history inject, offline-only를 live로 위장, empty를 pass로 치는 것, target 하향  
   - cold-v2 정책을 약화하는 변경 금지 (버그 수정 제외)  
4. 스코프: `core/src/agent/*`, `tools/lab/*` 위주. 무관 UI 리디자인 금지.  
5. 고친 뒤 **필수 L0**:

```powershell
node tools/verify-capability-policy.mjs
node tools/verify-turn-decision.mjs
node tools/verify-work-mode-loop.mjs
node tools/lab/pattern-chain-backtest.mjs
# 영향을 준 영역이면 추가:
# node tools/lab/cursor-query-backtest.mjs
npm run build
node tools/lab/maturity-scorecard.mjs --cold
```

L0 깨지면 **다음 live 가기 전에** 고친다.

### 2.4 LIVE (비싸고 불안정 — 예산)

**Cursor/LLM live는 전체 야간 창에서 하드 캡.**

| 항목 | 한도 |
|------|------|
| full maturity live suite | **최대 4회** / 전체 밤 (실패 재시도 포함) |
| full daily-smoke (live 포함) | **최대 2회** |
| 같은 실패 케이스 live 재시도 | **연속 2회 실패 시 중단** → FIX 후 다음에 다시 |
| live 사이 최소 간격 | FIX 완료 + L0 green 후에만 |

권장 순서 (daily_loop가 55이면 우선):

```powershell
# API up
# 필요 시: npm run start:api  (또는 기존 :10200)
$env:MY_AGENT_API_BASE='http://127.0.0.1:10200'
node tools/lab/daily-smoke.mjs          # offline+live 한 번 — daily_loop 증거
node tools/lab/maturity-scorecard.mjs --live --repeats=1
node tools/lab/maturity-scorecard.mjs --cold
```

live 실패 시:

1. fail **id / empty / abandon / contentPreview** 기록  
2. **제품/라우팅/게이트 1건 FIX**  
3. L0 PROVE  
4. (예산 남으면) 좁은 재시도 — 가능하면 full suite 대신 실패 id 재현에 가까운 경로

**금지:** fail한 live를 코드 수정 없이 3번 연속 돌리기.

### 2.5 “루프”의 의미 (재정의)

| 잘못된 루프 (하지 말 것) | 올바른 루프 (할 것) |
|--------------------------|---------------------|
| sleep 15분 × N, 측정만 | 측정 → **fix** → 측정 |
| overnight-cold-loop 단독 방치 | overnight-cold-loop는 **선택 감시**일 뿐, **본 작업은 fix 사이클** |
| 점수 올리려고 채점기 완화 | 실패 원인 제거 후 재채점 |

기존 `node tools/lab/overnight-cold-loop.mjs` 가 돌고 있으면:

- **충돌 방지:** 그 프로세스는 **중지하라** (측정-only 백그라운드가 fix와 레이스하면 안 됨).  
- 대신 이 지시서의 CYCLE을 메인으로 돌린다.  
- 원할 때만 장시간 자리 비울 때 cold-loop를 **감시용**으로 다시 켤 수 있으나, 그 창 동안은 FIX 안 함 — 사용자가 원한 패턴과 맞지 않음. **기본은 cold-loop OFF + 너가 직접 CYCLE.**

---

## 3. 토큰 / Cursor 절약

1. 파일 대량 탐색·병렬 agent 남발 금지. 실패 id → 관련 2–4 파일 위주.  
2. **offline L0 먼저**, live는 예산 안에서.  
3. 같은 explain/채팅 장문 반복 금지. 상태 로그는 bullet 5줄 이내.  
4. MAR/대량 Autopilot/desktop maxstress **야간 금지** (범위 밖).  
5. subagent는 꼭 필요할 때만 1개 (탐색 전용).  
6. 의미 없는 `npm run lab:realuse:deep` 전수 루프 금지 — 목표 dim과 무관하면 skip.

---

## 4. 커밋 / git

- **사용자가 커밋을 명시하기 전엔 commit 하지 않는다.**  
- 작업 트리에 결과·리포트는 남겨도 됨:  
  - `data/_skill_tool_lab/overnight-fix-cycle-log.md` (네가 append)  
  - maturity / daily-smoke 산출물

---

## 5. 매 사이클 로그 포맷 (필수)

파일: `data/_skill_tool_lab/overnight-fix-cycle-log.md`  
매 사이클 끝에 append:

```markdown
## Cycle N — ISO time
- measure: mean=M min=m scores={...}
- below: [dims]
- triage: <one failure>
- fix: <files + 1 sentence>
- prove: L0 ok/fail | live used? yes/no result
- next: <one line>
```

---

## 6. 08:30 FINAL REPORT (사용자용)

시간 되면 (또는 allPass) 채팅에 짧게:

1. **시작 vs 최종** scores / mean / min / allPass  
2. **사이클 수** · live 사용 횟수  
3. **적용한 FIX 목록** (경로 한 줄씩)  
4. **아직 BELOW인 이유** (정직하게 1–3개)  
5. **아침에 할 다음 1개** Exit Gate  
6. 정책 준수 확인: history gaming / score 완화 없음

리포트 아티팩트:

- `data/_skill_tool_lab/maturity-scorecard.md`  
- `data/_skill_tool_lab/overnight-fix-cycle-log.md`  
- (있으면) `overnight-cold-loop-report.md` 는 쓰지 말 것 / 부록 취급

---

## 7. 즉시 시작 체크리스트 (첫 30분)

1. [ ] 기존 `overnight-cold-loop` running이면 **kill**  
2. [ ] `npm run build` + offline daily-smoke + cold maturity  
3. [ ] log 파일 생성, baseline 기록  
4. [ ] **가장 낮은 dim** triage (대개 `daily_loop` 55)  
5. [ ] 그 dim FIX 또는 real daily live 1회 (예산 1)  
6. [ ] cold 재채점 → Cycle 2로  

---

## 8. 붙여넣기용 초압축 프롬프트

아래 블록만 다른 Agent 채팅에 붙여도 된다.

```
[MY Agent Overnight Loop→Fix 지시]

목표: cold-v2 정직한 채점 유지. 측정만 하지 말고
MEASURE → TRIAGE(1아래 dim) → FIX(1 theme) → PROVE(L0) → (예산 내 LIVE) → LOG
를 내일 08:30 KST까지 반복.

금지: history로 점수 채우기, 채점기 완화로 만점, live 실패 3연속 재시도, 무관 리팩터, 커밋(요청 전).

Live 예산: maturity --live ≤4, daily-smoke full ≤2. offline L0 우선.

기존 overnight-cold-loop 프로세스 있으면 중지. 메인은 네가 fix 사이클.

베이스: data/_skill_tool_lab/maturity-scorecard.md 읽고 시작.
로그: data/_skill_tool_lab/overnight-fix-cycle-log.md append.
최종: 시작/끝 점수, FIX 목록, 남은 BELOW 정직 보고.

상세: tools/lab/OVERNIGHT_LOOP_FIX_INSTRUCTIONS.md 전문 준수.
지금 Cycle 1 MEASURE부터 실행.
```

---

## 9. 관련 경로

| 용도 | 경로 |
|------|------|
| 채점 | `tools/lab/maturity-scorecard.mjs` |
| daily | `tools/lab/daily-smoke.mjs` |
| live cursor bars | `tools/lab/cursor-query-live-backtest.mjs` |
| live chains | `tools/lab/pattern-chain-backtest.mjs --live` |
| 표시 평면 | `core/src/agent/agent-surface-plane.ts` (권한 결정 금지) |
| capability/HITL | `core/src/agent/agent-capability-policy.ts` |
| 측정-only (이 지시서에서는 비권장) | `tools/lab/overnight-cold-loop.mjs` |

---

*작성 의도: 사용자가 원한 패턴 = 루프 끝 → 고침 → 루프 끝 → 고침.  
단순 overnight 측정 루프는 그 패턴이 아님.*
