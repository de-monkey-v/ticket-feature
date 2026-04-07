---
name: ticket-plan
description: "Create concrete implementation plans for ticket workflow runs in `intentlane-codex`. Use when Codex receives a ticket description, linked request, prior analysis output, and scheduled verification commands, and needs to produce the `plan` step output: file-level changes, execution order, acceptance criteria, scoped verification when appropriate, and a verification plan aligned with the actual automatic commands."
---

# Ticket Plan

Use this skill to convert analyzed ticket context into an implementation plan that the later `implement` step can follow directly.

## Quick Start

1. Read the ticket description, linked request, and analysis output before proposing changes.
2. Ground every verification idea in the scheduled automatic verification commands.
3. Describe concrete file-level edits, not abstract intentions.
4. Keep acceptance criteria observable and implementation-facing.
5. Add scoped verification only when it uses the same project toolchain and shortens feedback safely.

## Workflow

### 1. Lock the scope

- Treat the ticket description and linked request as the source of truth.
- Reuse the provided analysis output instead of re-analyzing the repository from scratch.
- Call out only the files and modules that are necessary to satisfy the ticket.
- Avoid speculative cleanup, refactors, or adjacent improvements unless the ticket explicitly requires them.

### 2. Build a concrete change list

- List each affected path with the change to make and why it is needed.
- Prefer file-level specificity such as `src/server/services/ticket-orchestrator.ts` over vague area names.
- Keep the plan implementable in order; another run should be able to execute it without guessing.

### 3. Define execution order

- Order the work so the implementation step can proceed deterministically.
- Put prerequisite wiring before dependent behavior, and behavior before tests or follow-up validation.
- Keep the sequence short and pragmatic.

### 4. Define acceptance criteria

- Write criteria as observable outcomes, not implementation trivia.
- Make each criterion checkable from code, tests, or review evidence.
- Avoid criteria that require manual UI inspection unless the ticket explicitly needs it.

### 5. Align verification

- Keep the verification plan aligned with the actual automatic verification commands already scheduled for the project.
- Do not invent automatic checks that the orchestrator cannot run.
- If scoped verification is useful, keep it narrow, safe, and in the same toolchain family as the scheduled commands.
- Exclude shell chaining and fragile command composition from scoped verification suggestions.

## Output Expectations

- Produce a plan that is specific enough for direct execution.
- Keep the response concise and operational.
- Favor the smallest responsible implementation path.
