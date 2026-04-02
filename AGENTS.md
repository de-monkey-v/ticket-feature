# Repository Guidelines

## Purpose
Use this file as the working contract for agentic coding tools in this repository.
Prefer small, correct changes that match existing patterns.
Keep behavior in the correct layer, verify what you change, and avoid speculative edits.

## Agent Rule Sources
- Primary repo instruction file: `AGENTS.md` (this file)
- No Cursor rules found in `.cursor/rules/`
- No `.cursorrules` file found
- No Copilot instruction file found at `.github/copilot-instructions.md`

## Product Model
This project is a local web app for understanding code, drafting requests, and turning them into tracked tickets.
Important flows:
- `Explain`: read code and help the user understand behavior
- `Request -> Ticket`: capture user-facing requests, then move through analyze/plan/implement/verify/review/ready stages

Treat `flows.config.json` and `prompts/` as product behavior, not incidental config.

## Architecture and Ownership
`src/web` is the Vite + React frontend.
- `src/web/components`: UI components
- `src/web/hooks`: client hooks such as SSE or ticket state
- `src/web/lib`: browser helpers, API clients, auth helpers, explain-state helpers
- `src/web/styles`: shared CSS and Tailwind entrypoint

`src/server` is the Hono API, background worker, workflow engine, and persistence layer.
- `src/server/routes`: thin HTTP/SSE entrypoints only
- `src/server/services`: business logic, orchestration, persistence, Codex integration, worktree/git operations
- `src/server/lib`: lower-level utilities, config loading, auth, serialization, project helpers
- `src/server/mcp`: thin MCP adapters over service logic
- `src/server/tests`: Node test runner regression tests

Keep these boundaries:
- Keep business rules on the server; do not move workflow logic into the UI
- Reuse services/helpers before adding a new module
- Put real behavior in `services/`, not directly in routes or MCP entrypoints
- Do not instantiate Codex SDK clients in routes; use `src/server/services/codex-sdk.ts`
- Keep ticket orchestration in `src/server/services/ticket-orchestrator.ts`

## Files and Data Not to Hand-Edit
- `dist/` build output
- persisted data in `tickets/`, `client-requests/`, `incidents/`, `background-runs/`
- runtime state in `explain/`, `direct-sessions/`, `access-control.json`, `runtime.settings.json` unless the task is explicitly about migration or repair logic

When behavior changes, edit the source that generates those artifacts.

## Package Manager and Runtime
- Package manager: `pnpm@10.28.1`
- Language: strict TypeScript
- Module system: ESM
- Frontend: Vite + React + Tailwind v4
- Server: Hono
- Tests: Node built-in test runner with `tsx`

## Commands
Run all commands from the repository root.

### Development
- `pnpm dev` — run API watcher, worker watcher, and Vite web dev server together
- `pnpm dev:server` — watch `src/server/api.ts`
- `pnpm dev:worker` — watch `src/server/worker.ts`
- `pnpm dev:web` — start the Vite frontend

### Validation and production-style runs
- `pnpm typecheck` — strict TypeScript check without emit
- `pnpm test` — run all server tests through `scripts/run-server-tests.mjs`
- `pnpm build` — `vite build && tsc -p tsconfig.server.json`
- `pnpm start` — run the built server from `dist/server/index.js`

### Single-test command
There is no dedicated `pnpm test -- <file>` wrapper. `pnpm test` expands all `src/server/tests/*.test.ts` files via `scripts/run-server-tests.mjs`.
Run one server test file with the same temp-data pattern using:

```bash
tmpdir=$(mktemp -d) && INTENTLANE_CODEX_DATA_DIR="$tmpdir" INTENTLANE_CODEX_SKIP_ENV_FILE=1 node --import tsx --test src/server/tests/app.test.ts; status=$?; rm -rf "$tmpdir"; exit $status
```

Replace `src/server/tests/app.test.ts` with the target file.

## Verification Expectations
Default verification commands from `flows.config.json`:
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

Minimum expectations by change type:
- Server route/service/lib/MCP change: run `pnpm typecheck` and `pnpm test`
- Flow config or prompt change: run `pnpm typecheck`, `pnpm test`, and review orchestration assumptions
- UI-only change: run the closest relevant validation path; include screenshots when reporting visual changes
- Build or runtime wiring change: include `pnpm build`

Test failure paths, not only happy paths.

## Style and Formatting
There is no repo-local ESLint or Prettier config checked in. Match the existing code directly.
Observed conventions:
- 2-space indentation
- no semicolons
- single quotes
- trailing commas on multiline objects/arrays/imports when already used nearby
- concise helper functions over unnecessary abstraction layers

## Imports
Server files typically use:
1. `node:` built-ins
2. external packages
3. local relative imports with `.js` extension

Web files typically use:
1. React imports
2. local component/lib/hook imports
3. type-only imports via `import type` or inline `type` specifiers

Important ESM nuance:
- server-side relative imports use `.js` in TypeScript source
- frontend relative imports usually omit the extension

## Naming and Types
- React components and exported types/interfaces: `PascalCase`
- hooks: `useX`
- server route/service/helper filenames: concise lowercase names such as `auth.ts` or `tickets.ts`
- constants: `UPPER_SNAKE_CASE` when they are true constants
- helper functions: short descriptive camelCase names
TypeScript guidance:
- define explicit interfaces/types for API payloads and UI state
- narrow `unknown` errors before reading `.message`
- return structured unions when a function can predictably succeed or fail
- keep browser-safe public shapes separate from internal server objects

Avoid new unsafe shortcuts. The codebase contains a few legacy `any` usages in route handlers; do not expand that pattern unless absolutely necessary.
Do not suppress type errors with `as any`, `@ts-ignore`, or `@ts-expect-error`.

## Error Handling and Recovery
- In `lib/` and `services/`, throw descriptive `Error` objects with stable messages
- In `routes/`, translate failures into safe `c.json(...)` or SSE responses with appropriate status and stable error codes
- In `mcp/`, return structured success/error payloads instead of leaking raw runtime failures
- Treat abort/cancel paths separately from normal failures
- Never use empty catch blocks

Observed repo patterns worth preserving:
- use `error instanceof Error ? error.message : '<fallback>'` when narrowing unknown errors
- log operational failures with `console.error(...)` when cleanup or background activity fails
- do not leak stack traces, filesystem paths, verification commands, SDK internals, or raw provider errors to browser-facing responses

## Frontend Guidance
- Keep the frontend focused on presentation, user interaction, and calling server APIs
- Do not reimplement server business rules in React components
- Reuse existing API helpers in `src/web/lib/api.ts` and auth helpers in `src/web/lib/auth.ts`
- Prefer local component state and focused helpers over adding global state unnecessarily
- Tailwind utilities and small shared CSS are both in use; follow the local file pattern

## Server Guidance
- Keep route files thin
- Keep workflow and orchestration logic in services
- Keep config interpretation aligned with `flows.config.json`
- If you change `promptFile`, sandbox settings, approval policy, network access, step ordering, or verification behavior, review matching orchestration code and tests together
- Browser-facing config must stay sanitized; do not expose server-only metadata
Prefer first-party or Node-based implementations where possible.
Host binaries such as `rg` should be optional accelerators, not hard requirements in core logic.

## Testing Conventions
Server tests live in `src/server/tests/*.test.ts` and commonly use:
- `node:test`
- `node:assert/strict`
- temporary fixtures and cleanup helpers such as `mkdtempSync` and `rmSync(..., { recursive: true, force: true })`
When adding tests, stay close to the file-specific style already present and assert serialized payloads, recovery behavior, and failure cases directly.

## Security and Communication
- Keep secrets such as `APP_SHARED_TOKEN` and Codex/OpenAI credentials in environment variables
- Review sandbox, approval, and network settings carefully before loosening them in `flows.config.json`
- Respect auth boundaries; `/api/health` and login paths are intentionally special-cased
- Default to answering users in Korean unless they ask for another language
- Keep code, command lines, paths, environment variables, and identifiers in their original form

## Change Strategy
- Prefer the smallest responsible change
- Extend existing modules before creating new abstraction layers
- Do not refactor unrelated code while fixing a bug
- Preserve current architecture boundaries unless the task explicitly requires a redesign
If the repository seems inconsistent, follow the nearest stable pattern in the touched area instead of trying to normalize the whole codebase.
