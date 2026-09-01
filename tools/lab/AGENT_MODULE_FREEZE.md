/**
 * Agent module freeze (P1 improvement) — coding agents.
 *
 * Prefer these barrels for new imports:
 * - `agent-loop.ts`  — code agent entry
 * - `tools.ts`       — tool defs + execute (existing façade)
 *
 * Do **not** add a new top-level `core/src/agent/agent-*.ts` file unless:
 * 1. An existing module cannot absorb the change without cyclic imports, AND
 * 2. The reason is recorded in rulebook ADR or this note with date.
 *
 * Prefer extending: agent-run-helpers, agent-run-step-loop, tools.
 * Do not reintroduce prose classifiers, persistent completion gates, or mandatory
 * planner/Critic roles; task intent and tool selection belong to the model.
 */
