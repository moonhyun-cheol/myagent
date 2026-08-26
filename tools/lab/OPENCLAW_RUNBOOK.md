# OpenClaw adapter runbook (non-destructive)

Lab **never** auto-fires Discord/slash side effects. Use this on an adapter PC only.

## 1) Config

Prefer vault (stable; **gitignored** — do not paste tokens into this markdown):

`data/vault/openclaw-adapter.json`

```json
{
  "base_url": "http://127.0.0.1:8790",
  "token": "YOUR_TOKEN_HERE",
  "source": "manual"
}
```

Or env (session-only, not committed):

```powershell
$env:OPENCLAW_ADAPTER_BASE_URL = 'http://127.0.0.1:8790'
$env:OPENCLAW_ADAPTER_TOKEN = 'YOUR_TOKEN_HERE'
```

## 2) Health only (safe)

```powershell
cd C:\Users\Temp\Desktop\업무\MY Agent
node tools/verify-openclaw-adapter-client.mjs
```

Expect console: `OK health http://127.0.0.1:8790` (or your URL).

Lab surface:

```powershell
$env:MY_AGENT_LAB_OPENCLAW_LIVE = '1'
$env:MY_AGENT_LAB_SKIP_AGENT = '1'
npm run lab:full-surface
```

| State | Lab result |
|-------|------------|
| No config | `skip` config + health |
| Config + health OK | `pass` |
| Config + health fail | `fail` when `MY_AGENT_LAB_OPENCLAW_LIVE=1` |

## 3) Live slash (manual only)

1. Shell chat → automaton / OpenClaw path with a **known-good dry intent** first.
2. When ready for side effect, send **one** slash command the ops team owns.
3. Prove result in Discord/target system — **not** from CI assertion.

Do **not** wire CI to send live jobs.

## 4) Honesty

- Health pass ≠ job delivered.
- Skill inject presence ≠ OpenClaw remote executed.
- **Never put real tokens in this file** — use `data/vault/` only.

## 5) Denied: `INGRESS_LANE_NOT_ALLOWED`

Symptom in CQR chat:

```
OpenClaw Adapter 실행 실패
- tool: us_sample_stock_lookup (or other remote)
- status: denied
- reason: INGRESS_LANE_NOT_ALLOWED
```

Meaning (verified 2026-08-05 against local adapter `:8790`):

| Layer | Result |
|-------|--------|
| Vault token + `/health` | OK |
| CQR intent match (`미국샘플재고` → `us_sample_stock_lookup`) | OK |
| `POST /cqr/adapter/request` reaches Main API | OK |
| Main API execute | **denied** — ingress lane not allowed for this platform/profile |

Denial payload includes `platform: my_agent`, `task_profile_id: safe_code_execution` (sample stock uses this).
**Not** fixed by SKU typo alone; not a CQR chat “text:” parse bug.

Ops fix (on OpenClaw Main / Zeroclaw side, not MY Agent product tree):

1. Allow ingress lane for **MY Agent** (`platform=my_agent`) or map CQR requests onto an allowed lane.
2. Ensure `safe_code_execution` + command `us_sample_stock_lookup` is enabled for that lane.
3. If Discord-only lane: run the same job via Discord slash `/미국샘플재고 …` for comparison.
4. Re-test: same message in CQR should complete (or return stock result, not generic denied).
