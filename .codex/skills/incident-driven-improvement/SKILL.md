---
name: incident-driven-improvement
description: Analyze accumulated incident files from ticket or workflow runs, identify recurring root causes, and turn them into the smallest system hardening change. Use when Codex needs to inspect `incidents/`, cluster repeat failures, decide whether the fix belongs in prompts, flow config, server services, or UI code, and implement/tests the fix instead of hand-editing incident data.
---

# Incident Driven Improvement

Use this skill to convert stored incident history into a concrete system fix. Start from persisted evidence, not guesses, and prefer the smallest change that prevents the same class of failure from recurring.

## Quick Start

1. Run `python3 .codex/skills/incident-driven-improvement/scripts/summarize_incidents.py` from the repository root before reading incidents one by one.
2. Read 2-5 representative incidents from the dominant cluster.
3. Decide which layer is actually broken.
4. Implement the smallest systemic fix.
5. Add or update regression coverage near the changed layer.
6. Run the repo's required validation commands.

## Workflow

### 1. Build the incident inventory

- Run `python3 .codex/skills/incident-driven-improvement/scripts/summarize_incidents.py --project-id <project-id>` first.
- Use `--incidents-dir <path>` when incidents are not under the default runtime data location.
- The script follows `INTENTLANE_CODEX_DATA_DIR` when it is set; otherwise it reads `./incidents`.
- Prefer clusters with repeated `trigger.kind`, repeated `analysis.likelyRootCause`, or repeated `analysis.impactedAreas`.
- If only one incident exists, treat the task as a deep-dive bugfix rather than a trend report.

### 2. Read representative incidents

- Open the newest and most representative incidents in the dominant cluster.
- Prefer incidents with `status: analyzed`, non-empty `analysis`, failed or pending `resolution`, and recent `updatedAt`.
- Confirm the failing step, review or verification evidence, and whether the problem is product logic, prompt quality, orchestration, or environment.
- Read the referenced source files only after the incident evidence points you there.

### 3. Choose the fix layer

- Prompt or planning drift:
  inspect `prompts/` and the matching orchestration code
- Verification or environment failures:
  inspect `flows.config.json`, verification helpers, repo wrappers, and the exact stored verification commands
- Incident capture, sanitization, or analysis quality:
  inspect `src/server/services/incidents.ts`, `src/server/services/incident-analysis.ts`, `src/server/services/incident-resolution.ts`, and `prompts/ticket-incident-analyze.txt`
- Runner or background execution failures:
  inspect runner, queue, background-run, and orchestration services
- UI-only regressions:
  fix the relevant web component or hook and keep workflow logic on the server

### 4. Make the smallest systemic fix

- Prefer reusable guardrails over one-off cleanup.
- Good fixes:
  - tighter prompt instructions
  - earlier validation of bad states
  - safer fallback behavior in the correct layer
  - better evidence capture or sanitization
  - regression tests for the failure path
- Avoid:
  - editing files under `incidents/`
  - unrelated refactors
  - patching product code just to hide an environment problem
  - moving business logic into routes or React components

### 5. Verify the change

- Follow the repository's required validation path.
- In `intentlane-codex`, default expectations are:
  - server route, service, lib, or MCP changes: `pnpm typecheck` and `pnpm test`
  - flow config or prompt changes: `pnpm typecheck`, `pnpm test`, and a review of matching orchestration assumptions
  - build or runtime wiring changes: include `pnpm build`
  - UI-only changes: run the closest relevant validation path and add manual verification notes
- Test failure paths, not only happy paths.

## Pattern Heuristics

- Repeated `review_failed` with scope drift or non-goal edits:
  tighten planning or review prompts, or add an earlier scope guard
- Repeated `verify_failed` caused by wrapper, cwd, or command layout problems:
  fix verification wiring instead of unrelated feature code
- Repeated `verification_environment_failed`:
  repair environment or bootstrap logic before retrying tickets
- Repeated `runner_exception`:
  harden queueing, cancellation, or background cleanup
- Repeated incidents with weak or noisy analysis:
  improve compact evidence building or the incident-analysis prompt before adding more automation

## Repo Notes

- When working in this repository, read `references/intentlane-codex-incident-map.md`.
- Treat `flows.config.json` and `prompts/` as product behavior, not incidental config.
- Keep routes thin and real behavior in `services/`.
- Do not hand-edit persisted incident data or other runtime state files.

## Output Expectations

Report all of the following:

- the dominant incident pattern
- the likely systemic cause
- the smallest change made
- the regression coverage added or updated
- the validation run and any remaining gaps
