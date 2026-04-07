---
name: ticket-implement
description: "Execute approved ticket implementation work in `intentlane-codex`. Use when Codex receives ticket context, approved plan output, acceptance criteria, verification history, and remediation feedback, and needs to perform the `implement` step by editing the target repository while staying inside the approved plan."
---

# Ticket Implement

Use this skill to execute an approved ticket plan with minimal, scoped code changes.

## Quick Start

1. Read the approved plan, acceptance criteria, and latest remediation notes before editing.
2. Start with files directly tied to the ticket or the failing verification or review evidence.
3. Stay inside the approved plan unless the provided failure evidence clearly justifies a small expansion.
4. Run only narrow local checks that help fix the current issue.
5. End with a short Korean change summary.

## Workflow

### 1. Rebuild the execution context

- Read the ticket description, linked request, analysis output, approved plan, and acceptance criteria.
- If remediation notes are present, treat them as the first debugging target.
- Reuse prior implementation context when the run explicitly resumes the same thread or same worktree.

### 2. Follow the approved plan

- Implement the listed file-level changes in the intended order.
- Avoid unrelated cleanup, broad refactors, or opportunistic naming churn.
- Do not edit paths outside the approved plan unless failing evidence points directly to them.

### 3. Debug from evidence first

- For verify failures, inspect the failing command, test case, endpoint, assertion, or suspected area before widening the search.
- For review failures, fix the blocking findings first and treat residual risks as secondary.
- Prefer the smallest change that resolves the concrete failure.

### 4. Preserve the orchestrator contract

- Do not replace the orchestrator's final verify gate.
- Run only focused checks that help confirm the local fix.
- Keep repository boundaries intact:
  - workflow logic stays on the server
  - routes stay thin
  - UI does not absorb server business rules

### 5. Report cleanly

- Keep the final response concise.
- Summarize what changed in Korean.
- Do not claim full validation unless you actually ran the relevant checks.

## Output Expectations

- Make the code changes directly.
- Keep the final message short and in Korean.
- Preserve existing unrelated worktree changes.
