# Release checklist (P2 deploy observability)

Run before shipping install zips:

1. `node tools/build.mjs`
2. `npm run lab:skills-tools` — skill/tool lab L1 (0 fail)
3. `npm run lab:skills-tools:strict` — unexpected skips fail (soft/opt-in allowlisted)
4. Optional browser: `MY_AGENT_LAB_BROWSER=1 npm run lab:skills-tools` after `tools/bootstrap-playwright.ps1`
5. `npm run verify:harness-goldens` + `npm run verify:embedding-cold`
6. `npm run predeploy` (includes lab strict + goldens + build)
7. Slim install smoke: `node tools/sandbox-slim-install-test.mjs` (or documented sandbox path)
8. Confirm Manager shows 시장조사 파이프라인 line (ready vs unavailable)
9. Full: `npm run predeploy:full`

Do not treat lab **skip** as pass unless allowlisted (Playwright opt, OpenClaw opt, diag/tests noop).
