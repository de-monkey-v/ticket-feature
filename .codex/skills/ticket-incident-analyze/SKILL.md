---
name: ticket-incident-analyze
description: "Analyze stored ticket workflow incidents in `intentlane-codex`. Use when Codex receives a persisted incident bundle from a failed run and needs to determine the likely root cause, concrete evidence, missing signals, the best restart point (`analyze`, `plan`, or `implement`), and the correct follow-up resolution type."
---

# Ticket Incident Analyze

Use this skill to diagnose a stored incident from the captured bundle first, then recommend the smallest safe recovery.

## Quick Start

1. Start from the incident bundle before reading live repository files.
2. Use concrete evidence from the failed step, verification runs, reviews, timeline, and worktree snapshot.
3. Prefer the earliest restart point that materially changes the failure outcome.
4. Distinguish retryable ticket issues from environment or runner problems.
5. Keep the analysis concise and implementation-facing.

## Workflow

### 1. Confirm the dominant failure shape

- Identify whether the incident is mainly a request gap, planning error, implementation bug, verification environment issue, merge issue, or runner failure.
- Prefer the newest failing evidence over older noise in the bundle.

### 2. Recommend the restart point

- Use `analyze` when the request itself was misunderstood or the affected area was misread.
- Use `plan` when the intended scope, acceptance criteria, interfaces, or verification alignment were wrong.
- Use `implement` when the plan is still valid and the failure points to incomplete or incorrect code.
- Use `manual_intervention` when retrying the ticket would likely repeat the same mistake.

### 3. Choose the follow-up resolution

- Use `retry_ticket` only when another ticket run is likely to converge safely from the chosen step.
- Use `needs_decision` when a person must choose between plausible recovery routes.
- Use `needs_request_clarification` when user-facing requirements are missing or contradictory.
- Use `manual_intervention` for environment repair, runner failures, or deeper debugging outside normal ticket flow.

### 4. Report missing signals

- List only the evidence gaps that materially block confidence.
- Do not pad `missingSignals` with generic diagnostics that would not change the next action.

## Output Expectations

- Keep all strings in Korean.
- Stay focused on the stored incident and the next safest move.
- Do not propose broad refactors when a smaller recovery or debugging step is enough.
