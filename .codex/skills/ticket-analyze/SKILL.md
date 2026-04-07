---
name: ticket-analyze
description: "Analyze ticket change requests in `intentlane-codex` before planning or implementation. Use when Codex receives a ticket description, linked request, and scheduled verification commands, and needs to produce the `analyze` step output: a Korean summary, affected areas with reasons, real risks, and practical verification checks grounded in the actual automatic commands."
---

# Ticket Analyze

Use this skill to turn a ticket into implementation-ready analysis without drifting into planning or coding.

## Quick Start

1. Read the ticket description, linked request, and scheduled automatic verification commands first.
2. Identify only the code areas that matter for the requested change.
3. Call out concrete risks or side effects tied to those areas.
4. Suggest practical checks that match the real automatic verification path.
5. Keep the output concise and in Korean.

## Workflow

### 1. Lock the request scope

- Treat the ticket description and linked request as the source of truth.
- Do not invent product requirements, refactors, or cleanup work.
- If the request is underspecified, record the ambiguity as a risk instead of guessing.

### 2. Map the affected areas

- Prefer concrete paths or modules over vague area names.
- Give a short reason each area matters.
- Keep the list focused on implementation-relevant surfaces only.

### 3. Surface real risks

- Include risks only when they follow from the request or the touched layer.
- Good risks include contract drift, regression exposure, auth or permission impact, workflow coupling, and verification blind spots.
- Avoid generic filler such as "bugs may occur."

### 4. Ground verification in the actual workflow

- Base proposed checks on the scheduled automatic commands already provided.
- Prefer checks that help the later `plan` and `implement` steps converge under the real workflow.
- Do not recommend nonexistent automation as if the orchestrator will run it automatically.

## Output Expectations

- Produce structured analysis only.
- Keep all strings in Korean.
- Stop before writing the implementation plan.
