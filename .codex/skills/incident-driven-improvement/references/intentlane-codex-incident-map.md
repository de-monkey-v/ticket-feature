# Intentlane Incident Map

Use this reference when the target repository is `intentlane-codex`.

## Evidence Sources

- `incidents/<project>/<incident-id>.json`
  persisted incident history; treat as read-only evidence
- `src/server/services/incidents.ts`
  incident persistence, bundle shape, sanitization, and browser-safe serialization
- `src/server/services/incident-analysis.ts`
  compact evidence building, truncation limits, schema, and analysis prompt execution
- `src/server/services/incident-resolution.ts`
  post-analysis follow-up decisions and auto-resolution status
- `src/server/routes/incidents.ts`
  list, detail, analyze, and delete API routes
- `prompts/ticket-incident-analyze.txt`
  instructions that shape analysis output
- `src/server/tests/incidents.test.ts`
  route, serialization, and incident workflow coverage
- `src/server/tests/incident-analysis.test.ts`
  evidence truncation coverage

## Where to Patch by Symptom

- Scope drift, non-goal edits, or review repeatedly blocking the same behavior:
  inspect `prompts/ticket-plan.txt`, `prompts/ticket-review.txt`, `src/server/services/ticket-orchestrator.ts`, and `src/server/services/ticket-runner.ts`
- Verification failures caused by wrong working tree, missing wrapper, wrong command, or bad cwd:
  inspect `flows.config.json`, `src/server/lib/project-verification.ts`, repo wrapper scripts, and the stored `verificationRuns[].commands[].command`
- Incident analysis missing the real cause because evidence is too noisy or too truncated:
  inspect `src/server/services/incident-analysis.ts` and excerpt logic in `src/server/services/incidents.ts`
- Resolution status staying misleading or not reflecting what a human should do next:
  inspect `src/server/services/incident-resolution.ts`
- Permission or browser payload issues when viewing incidents:
  inspect `src/server/routes/incidents.ts` and the public serializers in `src/server/services/incidents.ts`
- UI-only regressions surfaced by incidents:
  patch the relevant file under `src/web/` and keep workflow rules on the server

## Change Discipline

- Never patch `incidents/*.json` to "fix" history.
- Fix the source of recurrence, not just the latest artifact.
- If you change prompt files or `flows.config.json`, review matching orchestration code and tests together.
- Add regression tests near the changed service or route.
- Keep behavior in the correct layer:
  - routes stay thin
  - services own business logic
  - prompts and flow config remain aligned with orchestrator expectations
