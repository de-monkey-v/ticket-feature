---
name: ticket-coordinator
description: "Coordinate recovery decisions for failed ticket workflow runs in `intentlane-codex`. Use when Codex receives current ticket state, worktree or thread reuse signals, and failure evidence for `plan_review_failed`, `verify_failed`, or `review_failed`, and needs to choose the safest next recovery route plus concise remediation notes."
---

# Ticket Coordinator

Use this skill to choose the smallest safe recovery path after a ticket workflow failure.

## Quick Start

1. Start from the supplied failure summary and evidence, not guesses about hidden context.
2. Preserve the approved plan when the problem is local to the latest implementation attempt.
3. Rewind to planning when the failure shows scope, requirement, acceptance-criteria, or design misalignment.
4. Escalate to a person only when automation cannot safely choose.
5. Keep `remediationNotes` directly actionable for the next worker or reviewer.

## Recovery Rules

### `retry_plan`

- Use only for `plan_review_failed`.
- Choose it when the planning thread is still useful and the plan can be corrected without redefining the request.

### `restart_implement`

- Choose it when the approved plan is still valid and the failure is implementation-local.
- For `verify_failed`, prefer this over plan rewind when the evidence points to missing or incorrect code.
- For `review_failed`, choose this when the review finding is concrete and patchable without changing the plan.

### `restart_plan`

- Choose it when the failure shows plan drift, missing files, mismatched acceptance criteria, wrong interfaces, or incorrect verification assumptions.
- Prefer this when implementation cannot safely continue without re-scoping the work.

### `needs_decision`

- Choose it when there is a real product, policy, or trade-off decision that automation cannot settle safely.
- Use it when two recovery paths are both plausible and the evidence does not clearly favor one.

### `needs_request_clarification`

- Choose it when the requirements are ambiguous, contradictory, or missing user-facing behavior.
- Prefer it over `needs_decision` when the missing information is fundamentally a request gap.

## Output Expectations

- Pick one recovery route only.
- Keep all strings in Korean.
- Favor conservative recovery over optimistic guesses.
