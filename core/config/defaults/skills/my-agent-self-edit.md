# MY Agent — self-edit workflow

Use when dev workspace is **MY_CUSTOM_CODEX** (editing the product itself).

## Before multi-file edits

1. `read_file` this file (done if you see it).
2. `read_file` `AGENTS.md` + `core/config/defaults/product-facts.json` + `ui-facts.json`.
3. Resolve RULEBOOK via `.rulebook-link.yml` (local only). Read **one** context pack — or for **external agents** use `docs/knowledge-export/01-core.md` (+ domain file from `manifest.json`):
   - General: `{rulebook}/docs/knowledge-export/01-core.md` (preferred portable) or `docs/context-packs/reverse-engineering.md`
   - Shell / updates: add `{rulebook}/docs/decisions/ADR-RE-007-four-update-streams.md`
   - WorkKitLauncher: `{rulebook}/docs/context-packs/work-kit-launcher.md`
4. Read `{rulebook}/docs/02_ALWAYS_ON_RULES.md` only when touching architecture, updates, shell, or API contracts.

Paths under `{rulebook}` are **outside** the product repo. Use absolute paths from `.rulebook-link.yml` → `rulebook_dir` (e.g. `C:/MY_FULL_AI/RULEBOOK/MY_CUSTOM_CODEX/docs/...`).

## Live memory (prefer over RULEBOOK prose)

| Need | Read |
|------|------|
| UI targets (title bar vs ChatPane) | `core/config/defaults/ui-facts.json` |
| API routes / layout | `core/config/defaults/product-facts.json` |
| Day-to-day agent rules | `AGENTS.md` |

RULEBOOK `01_CURRENT_STATUS.md` is **frozen** (historical). Do not append S-XX rows on every update — use git history + ADRs for structural changes.

## Do not

- Create or restore `rulebook/` under the product repo (ADR-RE-008).
- Ship rulebook in delta/install zip or `build-rulebook` into product tree.
- Merge the four update streams (core / launcher / org module / work-kit catalog).
- Default every UI ask to `ChatPane.tsx` — classify with `ui-facts.json` first.

## Structural changes only

Write a short **ADR** under RULEBOOK `docs/decisions/` when the change is irreversible (new process, new update stream, forbidden path). Skip ADR for bugfixes and single-file UI fixes.
