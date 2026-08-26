# MY Agent Full-Product Verifier (`cqrpa-fpv`)

In-repo orchestrator over existing `verify:*` and `tools/lab/*`. Does **not** replace the product.

## Commands

| Script | Purpose |
|--------|---------|
| `npm run fpv:l0` | Offline goldens (blocks L2+ on fail) |
| `npm run fpv:l1` | HTTP root matrix |
| `npm run fpv:journeys` | L4 journeys (market P0 + local_docs + mutate + deploy) |
| `npm run fpv:journey:market` | P0 market→process live/offline |
| `npm run fpv:full -- --base=http://127.0.0.1:10200` | L0→L4 + honest report |
| `npm run fpv:full -- --offline` | No live API |
| `npm run fpv:full -- --l2-live` | Also burn pattern-chain live |
| `npm run fpv:soak -- --times=2` | full × N + gap regression diff |
| `npm run fpv:seed-png` | vision fixture |

## Layout

```text
tools/fpv/
  manifest.json           # capability graph
  fixtures/path-map.json  # absolute paths → repo fixtures (env≠product)
  fixtures/market|docs|bowling  (+ toy via tools/lab/fixtures/toy-workbench)
  journeys/*.json
  runners/                # L0..L4
  oracle/aggregate.mjs
  report/write-report.mjs
```

## Oracle rules

- Headline score = **honest-v1** only (`score-honest.json`).
- Missing fixture path → **env-red**, not product-red.
- Skip / soft-pass ≠ pass.
- Market green requires `J_market_process` evidence (S1→S3 process), not mode keyword alone.

## Reports

`data/_fpv/report-<ts>/` — `graph.svg`, `journeys.json`, `gaps.md`, `score-honest.json`.
