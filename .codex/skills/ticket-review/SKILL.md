---
name: ticket-review
description: "Review completed ticket work in `intentlane-codex` against the linked request, ticket description, approved plan, acceptance criteria, verification results, and repository diff. Use when Codex needs to perform the final `review` step and decide whether the ticket is ready to advance or must fail with blocking findings."
---

# Ticket Review

Use this skill to perform the final ticket review after implementation and verification have finished.

## Quick Start

1. Compare the diff and verification results against the approved plan and acceptance criteria.
2. Treat request or ticket misalignment as blocking.
3. Keep findings short, concrete, and evidence-backed.
4. Use residual risks only for non-blocking concerns.

## Workflow

### 1. Read the intended outcome

- Read the ticket description, linked request, approved plan, and extracted acceptance criteria.
- Treat those items as the baseline for goal coverage.

### 2. Review the produced change

- Use the repository diff summary and verification results as primary evidence.
- Check whether the implementation stayed inside the approved plan.
- Look for correctness issues, regressions, and obvious scope drift.

### 3. Evaluate goal coverage

- Assess linked request alignment when a request exists.
- Assess ticket alignment for the ticket description itself.
- Assess each acceptance criterion independently.
- Treat `partial`, `misaligned`, or `unmet` outcomes as blocking.

### 4. Write the verdict

- Use `pass` only when there are no blocking issues.
- Use `fail` when there is any correctness, regression, or goal-alignment blocker.
- Keep release notes limited to the meaningful changed areas.

## Output Expectations

- Return valid structured review output.
- Keep all string content in Korean.
- Prefer short blocking findings over long prose.
