# Intentlane

[한국어](./README.md) | English

`Intentlane` is a local web workspace built on the Codex SDK. It reads a local git repository so you can understand code in `Explain`, shape a request in `Requests`, and then run it through `Ticket` with the full `analyze -> plan -> implement -> verify -> review -> ready` workflow.

It is not just a static documentation viewer. It is a local development tool that reads your repo directly and uses real verification commands and `git worktree` under the hood. It works on Linux, macOS, and Windows via WSL2, and while the entry point is a web UI, the real system is the local repo, server, worker, and verification pipeline.

Quick links:

- [Quick Start](#quick-start)
- [Troubleshooting](#troubleshooting)
- [`intentlane-setup` skill](./.codex/skills/intentlane-setup/SKILL.md)
- [`AGENTS.md`](./AGENTS.md)
- [`flows.config.json`](./flows.config.json)

## Preferred Setup

This repository already includes the [`intentlane-setup`](./.codex/skills/intentlane-setup/SKILL.md) skill, which is designed to take a fresh clone to a working first run. If you opened this repo in Codex, this is the safest setup path before manually editing `.env`.

```text
Use $intentlane-setup to get this fresh clone running with pnpm dev, bootstrap root auth, and a safe .env.
```

```text
$intentlane-setup으로 이 저장소 fresh clone 세팅을 끝내줘. .env 생성, pnpm install, pnpm dev, health check, 첫 로그인 확인까지 해줘.
```

At a high level, the skill confirms the run mode and auth path, generates a safe `.env`, and then sanity-checks `pnpm install`, `pnpm dev`, `/api/health`, and bootstrap-root login.

## Highlights

- A single `Explain -> Requests -> Ticket` flow from code understanding to tracked execution.
- Local-first repo access with real `git worktree` and verification commands.
- `Access Control` for accounts, sessions, API tokens, and project access scopes.
- `Incidents` for failed ticket runs and recovery-related visibility.
- File-system-backed runtime state for Explain, Requests, Tickets, and Incident history.

## How It Works (Short)

```text
Browser UI
  │
  ├─ Explain / Direct Dev / Requests / Ticket / Access Control
  │
  ▼
Hono API
  │
  ├─ auth + config + project selection
  ├─ explain/request/ticket routes
  ├─ SSE + runtime state persistence
  │
  ├──────────────┐
  ▼              ▼
Worker        Codex SDK
  │              │
  ├─ ticket runs │
  ├─ verification│
  └─ incidents   │
                 ▼
        local repo + git worktree + prompts/flows
                 ▼
     tickets/ requests/ incidents/ explain/ runtime.settings.json
```

## At A Glance

### Current UI

<p align="center">
  <img src="./docs/intentlane.png" alt="Intentlane current UI" width="100%" />
</p>
<p align="center">
  <sub>Current UI with workspace and thread navigation on the left, project and model controls on top, the main conversation area in the center, and completed replies on the right.</sub>
</p>

| What you want to do | Where to go | Expected outcome |
| --- | --- | --- |
| Understand the current project structure and execution flow | `Explain` | Architecture summary, important files, impact areas, change points |
| Implement or investigate outside the Request/Ticket flow | `Direct Dev` | A freer development-oriented chat session |
| Clarify a user-facing request before implementation | `Requests` | A draft centered on `Problem`, `Desired Outcome`, and `User Scenarios` |
| Run a tracked implementation workflow | `Ticket` | `analyze -> plan -> implement -> verify -> review -> ready` |
| Manage accounts, sessions, tokens, and access scopes | `Access Control` | Operational account and token management |

### Recommended Usage Flow

<p align="center">
  <img src="./docs/intentlane-usage-flow.svg" alt="Intentlane usage flow" width="100%" />
</p>

For a first-time user, this is the simplest path:

1. Register or select the local repository you want to work on.
2. Start in `Explain` to understand structure, execution flow, and impact.
3. Once the implementation intent is clear, write the problem and desired result in `Requests`.
4. Promote the request into a `Ticket` and let it move through the tracked workflow.
5. Use `Access Control` if you need user accounts, sessions, or API tokens.

Starter prompts:

```text
Explain this project's structure and execution flow first
Point me to the files and impact area for this change
Turn this into a Request draft
If I promote this Request to a Ticket, what stages will it go through?
```

### Screen Layout

<p align="center">
  <img src="./docs/intentlane-workspace-overview.svg" alt="Intentlane workspace overview" width="100%" />
</p>

- The left sidebar switches between `Explain`, `Direct Dev`, `Requests`, `Ticket`, and `Access Control`, and lets you reopen saved threads.
- The top controls set the current project, model, reasoning effort, and response mode.
- The center area shows Explain answers, Request drafts, Ticket details, and stage status.
- The right panel lets you reopen completed replies and scan recent history.

## Good Fit

| Good fit | Less ideal fit |
| --- | --- |
| You want to understand a local repo before changing it | You want a hosted SaaS tool that only uploads code |
| You want traceable `Request -> Ticket` workflow management | You only need one-off chat without saved state |
| You want a tool that uses real `git worktree`, local verification commands, and local filesystem state | You expect everything to happen only inside the browser |
| You want to operate one repo across multiple accounts, sessions, and access scopes | You expect unauthenticated open access by default |
| You want to keep work tied to the current machine and local repo context | You cannot prepare local dependencies like Codex/OpenAI auth, `git`, or `rg` |

## Quick Start

### Requirements

- OS: Linux, macOS, Windows + WSL2
- Node.js: recommended `20.19+` or `22.12+`
- `pnpm@10.28.1`
- `git`
- `rg` (`ripgrep`)
- Local Codex/OpenAI authentication

Native Windows is not a primary supported path for this repository.

Quick checks:

```bash
node -v
pnpm -v
git --version
rg --version
```

> Important
> This app provides server login UI, but it does not handle Codex/OpenAI login or API key issuance for you. App login and Codex/OpenAI authentication are separate layers.

### Install

```bash
git clone https://github.com/de-monkey-v/intentlane-codex.git
cd intentlane-codex
pnpm install
cp .env.example .env
```

For a first run from the public repository, at minimum replace `INTENTLANE_CODEX_BOOTSTRAP_ROOT_PASSWORD` with a real value.

### Minimal `.env`

The safest first-run path is bootstrap root admin auth.

```dotenv
HOST=0.0.0.0
PORT=4000

INTENTLANE_CODEX_BOOTSTRAP_ROOT_ENABLED=1
INTENTLANE_CODEX_BOOTSTRAP_ROOT_NAME=admin
INTENTLANE_CODEX_BOOTSTRAP_ROOT_PASSWORD=change-this-before-use
```

If you want runtime data separated from the repo root, also set:

```dotenv
INTENTLANE_CODEX_DATA_DIR=.local/dev-data
```

### Run Modes

| Mode | Command | Web UI | API | When to use it |
| --- | --- | --- | --- | --- |
| Development | `pnpm dev` | `http://localhost:5173/` | `http://localhost:4000/` | Run frontend, API, and worker together with reload |
| Local production-style run | `pnpm build && pnpm start` | `http://localhost:4000/` | `http://localhost:4000/` | Verify the built web app and API from the same origin |

`pnpm dev` launches all three:

- `pnpm dev:server`
- `pnpm dev:worker`
- `pnpm dev:web`

Important:

- Without the `worker`, ticket automation is incomplete.
- `web` is a Vite dev server and proxies `/api` to `http://localhost:4000`.
- `pnpm start` launches both the API process and the worker process.
- Running `pnpm start` before `pnpm build` will return `Web assets not found. Run pnpm build first.`

### First Browser Visit

1. Open `http://localhost:5173/`, or `http://localhost:4000/` for the built run.
2. Log in with `admin` and the password from `.env`.
3. If prompted, change the password first.
4. Optionally confirm API health at `http://localhost:4000/api/health`.

### First Sanity Check

Health:

```bash
curl http://localhost:4000/api/health
```

Expected response:

```json
{"status":"ok"}
```

Login:

```bash
curl -X POST http://localhost:4000/api/access/login \
  -H 'Content-Type: application/json' \
  -d '{"name":"admin","password":"change-this-before-use"}'
```

Expected shape:

```json
{
  "token": "<session-token>",
  "session": {
    "id": "ses_...",
    "accountName": "admin"
  }
}
```

Read config:

```bash
TOKEN="<session-token>"

curl http://localhost:4000/api/config \
  -H "Authorization: Bearer $TOKEN"
```

This includes the current session permissions, allowed projects, Explain model selection, and Ticket category information.

### First 10-Minute Workflow

A practical first-run flow:

1. Select the current repository or register a new local repository.
2. In `Explain`, start with:

```text
Explain this project's structure and execution flow first
Point out the key server files and frontend entry points
```

3. If you already know what you want to change, write the request in `Requests` like this:

```text
Problem
- What problem the user is experiencing

Desired Outcome
- What should be different after the change

User Scenarios
- 2-3 representative user flows
```

4. Promote the Request into a `Ticket` and choose a category.
5. Watch it move through `analyze -> plan -> implement -> verify -> review -> ready`.
6. If something fails, start with `Incidents` or the verification output.

## Auth And Security

> Important
> Server login and Codex/OpenAI authentication are separate layers. Even if you are logged into the app, `Explain`, `Direct Dev`, and `Ticket` can still fail if the current machine is not authenticated for Codex/OpenAI.

Core rules:

- If no authentication is configured at all, the server should not start by default.
- `INTENTLANE_CODEX_ALLOW_OPEN_ACCESS=1` exists only as a local-development escape hatch.
- Open access is not the right default for shared environments.

Recommended first-run order:

1. Put bootstrap root settings in `.env`.
2. Start the server with `pnpm dev` or `pnpm start`.
3. Log in as the root account in the browser.
4. Change the password if required.
5. Create normal user accounts or tokens in `Access Control`.

### Notes On `APP_SHARED_TOKEN`

`APP_SHARED_TOKEN` is supported, but the default browser login view does not expose bearer-token input UI.

- If you set only `APP_SHARED_TOKEN`, do not expect the normal browser login flow to work by itself.
- It is closer to API clients, automation, and advanced operational paths.
- For normal browser entry, bootstrap root account auth is the simplest path.

Public paths after auth is enabled:

- `/api/health`
- `/api/access/login`

Additional allowed paths during forced password change:

- `/api/config`
- `/api/access/logout`
- `/api/access/me/password`

## Product Mental Model

The most important distinction in this product is:

> `Request` defines what should happen. `Ticket` executes how it gets built.

### `Requests` vs `Ticket`

| Category | `Requests` | `Ticket` |
| --- | --- | --- |
| Purpose | Clarify user-facing intent | Turn it into an executable technical workflow |
| Core content | `Problem`, `Desired Outcome`, `User Scenarios` | analysis, plan, implementation, verification, review |
| Best timing | Before implementation details are locked | When work needs to be executed and tracked |
| Output | A promotable request draft | A staged ticket with run state and outputs |

### Mode Guide

| Mode | When to use it | Notes |
| --- | --- | --- |
| `Explain` | When you need structure, flow, and impact understanding first | Implementation-like prompts can be intercepted into a Request draft |
| `Direct Dev` | When you want a freer implementation or investigation session | Separate from the Request/Ticket pipeline |
| `Requests` | When you want to store and refine user-facing requests | Mature requests can be promoted into Tickets |
| `Ticket` | When you need a tracked technical workflow | Default stages are `analyze -> plan -> implement -> verify -> review -> ready`; `docs` skips `verify` |
| `Incidents` | When you need to inspect failed ticket runs and recovery state | Typically used by users with ticket-related access |
| `Access Control` | When you need to manage accounts, sessions, API tokens, and project scopes | Admin-facing operational screen |

### Ticket Category Guide

Current built-in categories:

| Category | When to use it | Stages |
| --- | --- | --- |
| `feature` | New feature work | `analyze -> plan -> implement -> verify -> review -> ready` |
| `bugfix` | Bug fixes and regression checks | `analyze -> plan -> implement -> verify -> review -> ready` |
| `change` | Behavior changes to existing features | `analyze -> plan -> implement -> verify -> review -> ready` |
| `docs` | Documentation work | `analyze -> plan -> implement -> review -> ready` |

Default verification commands come from `flows.config.json`: `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## Runtime Model

This project is not just a static site. It is a server that reads and operates on local repositories directly.

- The server reads local git repositories directly.
- Ticket implementation uses `git worktree`.
- Default verification commands run locally for real.
- Repository search requires `ripgrep (rg)`.
- Runtime state is persisted on the filesystem.

### Project Registration And Default Project

- The `defaultProjectId` in `flows.config.json` is `intentlane-codex`.
- On first run, this repository itself is the default project.
- Other local repositories can be added as runtime projects.
- In WSL or headless environments, native folder picking may fail, and manual path entry is the fallback.

### Runtime State Storage

| Path | Meaning |
| --- | --- |
| `tickets/` | Ticket state and staged outputs |
| `client-requests/` | Request drafts and user request data |
| `incidents/` | Failure and recovery-related incident records |
| `background-runs/` | Background run status |
| `explain/` | Explain session state |
| `direct-sessions/` | Direct Dev session state |
| `access-control.json` | Access-control state for accounts, sessions, and tokens |
| `runtime.settings.json` | Runtime project and model settings |

Important:

- These are runtime artifacts, not source files.
- It is safer to let the app create and manage them than to hand-edit them.
- Use `INTENTLANE_CODEX_DATA_DIR` if you want separate dev, test, or production runtime data.

### Layer Summary

| Layer | Path | Role |
| --- | --- | --- |
| Frontend | `src/web` | Vite + React UI, user interaction, API calls |
| API routes | `src/server/routes` | Thin HTTP and SSE entrypoints |
| Services | `src/server/services` | Business logic, orchestration, persistence |
| Server utilities | `src/server/lib` | Config, auth, project handling, paths, model capability |
| Worker | `src/server/worker.ts` | Background ticket stage execution |
| Product behavior config | `flows.config.json`, `prompts/` | Explain, Request, and Ticket behavior |

For debugging, it is often faster to think in the order `UI symptom -> relevant service -> flows/prompts/config` rather than only `routes -> services -> lib`.

## Troubleshooting

| Symptom | Check first | Typical cause |
| --- | --- | --- |
| Login works but `Explain` or `Ticket` fails | The current machine's Codex/OpenAI authentication | App login and model execution auth are different layers |
| The server does not start at all | Auth settings in `.env` | No bootstrap root, no `APP_SHARED_TOKEN`, and no local-only open access override |
| Ticket runs do not advance | Whether the worker is running | `pnpm dev:worker`, `pnpm dev`, or `pnpm start` is missing the worker path |
| Project folder selection fails | Manual path entry | Native folder picking can fail in WSL or headless environments |
| Repo reading or search fails | `rg --version` | `ripgrep (rg)` may not exist on the server host |
| `pnpm start` serves no web UI | Whether `pnpm build` ran first | Built web assets may be missing |
| Old runtime data mixes with current work | `INTENTLANE_CODEX_DATA_DIR` | Runtime state was not isolated |

Additional tips:

- The `docs` category intentionally skips `verify`, so missing verification there can be expected.
- Verification failures are often real repository test failures rather than orchestration bugs. Re-running `pnpm typecheck`, `pnpm test`, and `pnpm build` locally is usually the fastest path.
- It is safer to reproduce and fix the service or configuration behavior than to hand-edit runtime state files.

## Environment Variables

`.env.example` is the baseline template. `pnpm dev`, `pnpm dev:server`, `pnpm dev:worker`, and `pnpm start` all auto-load the root `.env`.

| Name | Default or example | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind host for the API and built web app |
| `PORT` | `4000` | Port for the API and built web app |
| `INTENTLANE_CODEX_BOOTSTRAP_ROOT_ENABLED` | `1` | Auto-create a root admin on first startup |
| `INTENTLANE_CODEX_BOOTSTRAP_ROOT_NAME` | `admin` | Bootstrap admin account name |
| `INTENTLANE_CODEX_BOOTSTRAP_ROOT_PASSWORD` | set explicitly | Bootstrap admin password |
| `INTENTLANE_CODEX_DATA_DIR` | path like `.local/dev-data` | Separate runtime state root |
| `APP_ALLOWED_ORIGINS` | empty | CORS allowlist for a separate web origin |
| `APP_SHARED_TOKEN` | empty | Shared admin bearer token |
| `INTENTLANE_CODEX_RUNTIME_SETTINGS_PATH` | empty | Override path for runtime settings |
| `INTENTLANE_CODEX_ALLOW_OPEN_ACCESS` | empty | Local-development-only open-access escape hatch |

## Commands

Run all commands from the repository root.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run API watcher, worker watcher, and Vite web dev server together |
| `pnpm dev:server` | Watch `src/server/api.ts` |
| `pnpm dev:worker` | Watch `src/server/worker.ts` |
| `pnpm dev:web` | Run the Vite frontend |
| `pnpm typecheck` | Strict TypeScript check with no emit |
| `pnpm test` | Run server tests via `scripts/run-server-tests.mjs` |
| `pnpm build` | `vite build && tsc -p tsconfig.server.json` |
| `pnpm start` | Run the built server entrypoint `dist/server/index.js` |

Single server test example:

```bash
tmpdir=$(mktemp -d) && INTENTLANE_CODEX_DATA_DIR="$tmpdir" INTENTLANE_CODEX_SKIP_ENV_FILE=1 node --import tsx --test src/server/tests/app.test.ts; status=$?; rm -rf "$tmpdir"; exit $status
```

## Verification Expectations

Default verification commands for the default project are:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

Minimum expectations by change type:

| Change type | Minimum recommended verification |
| --- | --- |
| Server route, service, lib, or MCP change | `pnpm typecheck`, `pnpm test` |
| Flow config or prompt change | `pnpm typecheck`, `pnpm test`, and orchestration assumption review |
| UI-only change | The closest relevant validation path, plus visual verification if possible |
| Build or runtime wiring change | Include `pnpm build` |

Do not only validate the happy path. Failure paths matter too.

## LLM Agent Repo Map

<details>
<summary>Expand</summary>

Paths worth reading first:

| Path | Why it matters |
| --- | --- |
| `AGENTS.md` | Working rules for this repository |
| `flows.config.json` | Project list, verification commands, and Explain/Request/Ticket flow config |
| `prompts/` | Prompt files for Explain, Request, and Ticket stages |
| `src/web` | Vite + React UI entry |
| `src/web/components` | Main screen components |
| `src/web/lib/api.ts` | Browser API client and public payload types |
| `src/server/routes` | Thin HTTP and SSE entrypoints |
| `src/server/services` | Business logic and orchestration |
| `src/server/lib` | Config, auth, project helpers, runtime paths, model capability |

In this repo, `flows.config.json` and `prompts/` are product behavior, not incidental config.

</details>

## Request Writing Guide

A good Request stays user-facing and clearly states:

| Include this | Meaning |
| --- | --- |
| `Problem` | Why the change is needed |
| `Desired Outcome` | What should be true from the user's point of view |
| `User Scenarios` | Representative user flows |
| `Constraints` | Important implementation constraints |
| `Non-goals` | What this work intentionally does not cover |
| `Open Questions` | What is still undecided |

Avoid putting these in the Request:

- Which files should be edited
- Which function or class names should be used
- Which verification commands should run

Those technical decisions belong in the Ticket stage.

## Maintenance Notes

<details>
<summary>Expand</summary>

Verification defaults are defined in `flows.config.json`:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

Explain model lists are managed statically on the server side. When updating models, check:

1. `~/.codex/models_cache.json`
2. `src/server/lib/model-capabilities.ts`
3. `flows.config.json`
4. Related test expectations

Helpful links:

- Models docs: <https://developers.openai.com/api/docs/models>
- Latest model guide: <https://platform.openai.com/docs/guides/latest-model>

</details>
