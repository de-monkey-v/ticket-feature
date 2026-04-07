---
name: ticket-verify
description: "Analyze ticket verification command results in `intentlane-codex`. Use when Codex receives the automatic verification output for a ticket run and needs to summarize the failure, highlight the most relevant evidence, and recommend one of the orchestrator recovery paths: `new_run_implement`, `new_run_plan`, or `needs_decision`."
---

# Ticket Verify

Use this skill to interpret verification results after the orchestrator has already executed the real commands.

## Quick Start

1. Treat the provided verification command output as the primary evidence.
2. Ground the diagnosis in the approved plan, acceptance criteria, and scheduled verification commands.
3. Separate implementation regressions from plan misalignment and human-decision cases.
4. Keep findings short, concrete, and directly useful for the next recovery step.

## Workflow

### 1. Read the run outcome

- Start from the provided verification summary and failing command excerpts.
- Use the approved plan and acceptance criteria only to explain why the failure matters.
- Prefer concrete failing evidence over abstract speculation.

### 2. Classify the next recovery path

- Choose `new_run_implement` when the approved plan still looks valid and the failure points to missing or incorrect implementation work.
- Choose `new_run_plan` when the failure indicates scope drift, acceptance-criteria mismatch, or plan-level misalignment.
- Choose `needs_decision` when policy, product direction, or conflicting requirements require a person to choose the path.

### 3. Produce concise findings

- Mention the most important failing commands, tests, or suspected areas.
- Keep the summary implementation-facing.
- Avoid repeating the full log; extract only the highest-signal evidence.

## Output Expectations

- Return a short Korean summary.
- Keep findings concrete and brief.
- Recommend only one orchestrator recovery path.
