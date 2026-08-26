# FPV fixtures

Deterministic seeds for Full-Product Verifier. **All host absolute paths used in live prompts must be declared in `path-map.json`.**

| Alias | Purpose |
|-------|---------|
| `fs.bowling` | Mirrored bowling sample (replaces host Desktop path) |
| `docs.strategy_docx` / `docs.strategy_txt` | Strategy doc fixture (+ readable txt twin) |
| `toy.*` | Mutate sandbox (`tools/lab/fixtures/toy-workbench`) |
| `market.*` | Seed queries + brand pipeline probe |

Missing required fixture → **env-red** (not product-red).

Regenerate docx: `npm run fpv:seed-docx`
