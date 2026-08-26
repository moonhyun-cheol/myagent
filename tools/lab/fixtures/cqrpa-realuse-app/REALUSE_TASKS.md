# Real-use task matrix (MY Agent)

| 자동 Deep | `npm run lab:realuse:deep` — UI e2e / agent gates / L2 / shell / live OWUI |

체크리스트 — 수동(WPF 클릭) 또는 에이전트. 자동:

```bash
npm run lab:realuse           # 픽스처 + 코드툴 전수 + skills L0/L1 + browser
npm run lab:realuse:deep      # + 범위밖 deep pack
npm run lab:realuse:deep-only
npm run lab:realuse:loop
```

보고서: `data/_skill_tool_lab/realuse-full-check-report.md`

## A. 워크스페이스 / 탐색
- [ ] Explorer 트리 로드, 파일 클릭 오픈
- [ ] Explorer 우클릭 → @ 컨텍스트 추가
- [ ] 채팅 `@` 버튼으로 피커 · shift+@현재 파일
- [ ] composer 끝에 `@` 입력 시 피커

## B. 코드 에이전트 (mutate)
- [ ] 「src/lib/math.js 에 avg 함수 추가하고 app에서 사용」
- [ ] mutate 후 검토 바: path 목록, diff, Accept
- [ ] 같은 시나리오로 Reject 선택 / 행 복원
- [ ] 신규 파일만 추가한 뒤 Reject → 파일 삭제되는지

## C. 터미널
- [ ] `npm test` 실행 성공
- [ ] `Start-Sleep -Seconds 20` 후 Stop
- [ ] 에이전트가 run_terminal 쓰는 중 Active jobs 에 agent 표시

## D. 플러그인 / MCP
- [ ] 사이드바 플러그인 템플릿 설치·toggle
- [ ] Manager User MCP 서버 추가·테스트(없거나 실패는 구성 이슈로 허용)

## E. 진단
- [ ] 에이전트 run_diagnostics / 로컬 `npm test`

## Exit Gate 예 (에이전트에 붙일 때)

```
작업 폴더는 이 앱 루트다.
P0: src/lib/math.js 에 sum(a,b) 유지, 테스트 smoke 통과.
완료 조건: npm test exit 0 + 디스크에 함수 존재. 도구로 검증.
```
