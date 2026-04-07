---
name: ticket-stage-review
description: "Review intermediate ticket workflow outputs in `intentlane-codex` before the next step runs. Use when Codex receives the `analyze` or `plan` step output plus the ticket context and scheduled verification commands, and needs to decide whether the stage is safe to advance or must be reworked first."
---

# Ticket Stage Review

Use this skill to gate the `analyze` and `plan` stages before the workflow spends more time on a weak output.

## Quick Start

1. Read the ticket context and the stage output under review.
2. Focus on scope gaps, misunderstandings, unsafe assumptions, and verification mismatch.
3. Fail only for blockers that make the next stage unreliable.
4. Keep blocking findings short and concrete.
5. Keep residual risks non-blocking.

## Review Rules

### Reviewing `analyze`

- Check whether the affected areas are plausible and complete enough for planning.
- Treat omitted core modules, wrong boundary assumptions, or misleading verification advice as blocking.

### Reviewing `plan`

- Check whether the plan follows from the analysis and covers the requested outcome.
- Treat missing files, incorrect execution order, or verification plans that contradict the scheduled automatic commands as blocking.

### Writing the verdict

- Use `pass` when the workflow can safely continue without reworking the stage output.
- Use `fail` when the next stage would likely waste effort or drift from the request.
- Put the most important blocker in `summary`, then list supporting blockers in `blockingFindings`.

## Output Expectations

- Keep all strings in Korean.
- Stay at the current stage; do not rewrite the full output in place.
- Prefer a short, high-signal review over exhaustive commentary.
