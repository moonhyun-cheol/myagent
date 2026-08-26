# Package B — browser URL network boundary

## Contract

- **Related**: RC-003
- **Observer**: browser_automation_caller

## Input

Fixture: `rulebook/fixtures/contract-inputs.json` → `browser_urls`

## Output (oracle)

`rulebook/oracles/contract-results.json` → `RC-003`

| URL class | Expected |
|-----------|----------|
| `https://example.com/` | allowed |
| `file:` | BLOCKED_PROTOCOL |
| localhost / RFC1918 | BLOCKED_HOST |
| 169.254.x.x (link-local) | BLOCKED_HOST |
| 0.0.0.0 | BLOCKED_HOST |
| `[::1]`, `[fe80::1]`, `[fc00::1]` | BLOCKED_HOST |
| `[::ffff:10.0.0.1]` | BLOCKED_HOST |
| malformed | INVALID_URL |

## Verification

```bash
npm run build
node rulebook/checks/verify-contracts.mjs
```

## Changed surface

- `core/src/browser/url-guard.ts`

## Not in this package

- DNS resolution of public hostname → private address (needs deterministic resolver fixture)
