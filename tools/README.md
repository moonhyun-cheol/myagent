# MY Agent tools

Build, deploy, verify, and lab harness scripts. Product code is **not** here — see [STRUCTURE.md](../rulebook/docs/ops/STRUCTURE.md).

## Layout

```text
tools/
├── build.mjs              # core + ui/workspace build
├── publish.mjs            # full install zip
├── publish-delta.mjs      # delta zip
├── cqr-admin.mjs          # license / bundle admin CLI
├── commands/              # 관리자·배포·복구 BAT 모음
├── admin/                 # diagnostics.ps1
├── bootstrap-*.ps1        # runtime deps (node, ffmpeg, playwright, oss-sidecars)
├── install/               # install.ps1 + install-ui.ps1 (install.bat)
├── update/                # apply-delta.ps1 (UPDATE.bat)
├── e2e/                   # Playwright config + ui-smoke.spec.ts
├── lab/                   # agent stress, maturity scorecard, fixtures
├── fpv/                   # full-product verifier (L0–L4 journeys)
├── plugin-templates/      # local agent plugin scaffolds
├── verify-*.mjs           # policy / harness goldens (npm run verify:*)
└── test-*.mjs             # unit-style tool tests
```

## Common commands

| Goal | Command |
|------|---------|
| Build | `npm run build` |
| Full verify | `npm run verify` |
| Agent verify | `npm run verify:agent` |
| E2E smoke | `npm run test:e2e` |
| Publish full install zip | `npm run publish` or `tools\commands\publish-full.bat` |
| Publish signed core update | `npm run publish:update` |
| Publish core update to GitHub | `npm run publish:update:github -- --confirm` |
| Lab full surface | `npm run lab:full-surface` |
| FPV offline | `npm run fpv:full -- --offline` |

루트 BAT는 최초 설치 `install.bat`과 델타 적용 `UPDATE.bat`만 유지합니다.
