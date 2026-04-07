---
name: ticket-merge-decision
description: "Choose automated recovery actions for blocked ticket merges in `intentlane-codex`. Use when Codex receives merge failure evidence, the current reviewed ticket state, and a list of allowed automated actions, and needs to return the safest merge recovery recommendation plus a filtered options list."
---

# Ticket Merge Decision

Use this skill to pick the safest automated action when a reviewed ticket can no longer merge cleanly.

## Quick Start

1. Start from the supplied merge evidence and allowed actions only.
2. Prefer preserving already-reviewed work when the risk is still controlled.
3. Prefer re-planning when branch drift or conflict complexity makes direct preservation unsafe.
4. Keep the filtered `options` list realistic.
5. Ensure `recommendedAction` always appears in `options`.

## Decision Rules

### Preserve current work when safe

- Use `revalidate_current_worktree` when the current worktree is still aligned and only needs verification or review to be rerun.
- Use `rebase_and_revalidate` when a direct rebase is plausible and the reviewed work can be preserved with acceptable risk.

### Reapply on a fresh base when drift is local

- Prefer `reapply_on_latest_base` when the reviewed intent is still good but the current base moved enough that rebase is noisy.
- Favor this especially for a small number of text or document conflicts.

### Rewind harder when the reviewed result is no longer trustworthy

- Use `restart_from_plan` when merge evidence suggests deeper drift, design mismatch, or unsafe reapplication risk.
- Use `discard_worktree` only when the work should not continue at all.

## Output Expectations

- Keep all strings in Korean.
- Explain the merge block briefly and concretely.
- Offer only realistic options from the provided action list.
