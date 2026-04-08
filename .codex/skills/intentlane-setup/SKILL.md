---
name: intentlane-setup
description: Guide interactive setup of the `intentlane-codex` repository from fresh clone to first successful run, and generate a safe first-run `.env`. Use when Codex needs to help a user after `git clone`, install dependencies, choose between `pnpm dev` and `pnpm build && pnpm start`, decide on bootstrap-root, shared-token, or local-only open access authentication, isolate runtime data with `INTENTLANE_CODEX_DATA_DIR`, or sanity-check health and login on a fresh clone of this repo.
---

# Intentlane Setup

Use this skill to onboard a fresh clone of this repository or repair a broken local setup. Ask focused setup questions, choose the safest matching configuration, and turn the answers into exact commands or `.env` content.

## Quick Start

1. Confirm whether the repository is a fresh clone, whether `.env` already exists, and whether dependencies are already installed.
2. Confirm whether the user wants `pnpm dev` or `pnpm build && pnpm start`.
3. Default a fresh clone to bootstrap root auth, `INTENTLANE_CODEX_DATA_DIR=.local/dev-data`, `HOST=0.0.0.0`, and `PORT=4000` unless the user explicitly wants something else.
4. Ask one short question at a time until you know exposure, auth path, data directory, and whether to execute commands or only prepare files.
5. Read `references/intentlane-setup-options.md` before choosing values.
6. Generate the `.env` content with `scripts/render_env.py` instead of composing it from memory.
7. Run install, launch, and sanity-check commands only after the configuration is clear.

## Fresh Clone Path

When the user just cloned the repo and wants it running quickly, prefer this path:

1. Verify prerequisites and current repo state.
2. Run `pnpm install` if `node_modules` is missing or stale.
3. Generate `.env` with bootstrap root auth and `.local/dev-data` unless the user chose another auth path.
4. Start `pnpm dev` by default.
5. Verify `curl http://localhost:4000/api/health`.
6. Verify login with the bootstrap root account.
7. Tell the user which browser URL to open and whether they must change the initial password.

Use this fast path for prompts like:

- `git clone 했는데 바로 띄우고 싶어`
- `fresh clone setup 해줘`
- `이 저장소 실행되게 .env부터 dev 서버까지 잡아줘`
- `Use $intentlane-setup to get this repo running after clone`

## Workflow

### 1. Qualify the setup

- Ask one question at a time. Do not dump the full questionnaire in one message.
- Ask for the next blocking choice first:
  - run mode: `pnpm dev` or `pnpm build && pnpm start`
  - exposure: local-only or shared environment
  - auth path: browser login, API token only, or disposable no-auth local demo
  - runtime data isolation: keep state under repo root or use `INTENTLANE_CODEX_DATA_DIR`
  - execution scope: provide instructions only, or execute commands in the workspace
- Default to these assumptions when the user is vague:
  - `pnpm dev`
  - local-only setup
  - bootstrap root auth
  - `INTENTLANE_CODEX_DATA_DIR=.local/dev-data`
  - `HOST=0.0.0.0`
  - `PORT=4000`

### 2. Check prerequisites

- Confirm or verify these prerequisites before blaming the app:
  - Node.js `20.19+` or `22.12+`
  - `pnpm@10.28.1`
  - `git`
  - `rg`
  - local Codex/OpenAI authentication already available on the machine
- If a prerequisite is missing, stop and tell the user exactly what to install or configure.

### 3. Choose the auth path

- Prefer bootstrap root auth for almost every first browser-based setup.
- Use `APP_SHARED_TOKEN` only when the user explicitly wants API or automation access and understands that the default browser login does not accept a bearer token directly.
- Allow `INTENTLANE_CODEX_ALLOW_OPEN_ACCESS=1` only when the user explicitly wants a disposable local-only demo. Call out that this should not be used on shared machines or networks.
- Treat `APP_ALLOWED_ORIGINS` as opt-in. Leave it empty unless the UI will be served from a different origin. Never use `*`.

### 4. Generate or update `.env`

- Read `README.md` and `.env.example` only when you need to confirm wording or an environment variable.
- If `.env` does not exist, create it from the generated output.
- If `.env` already exists, read it first and preserve unrelated user values. Only change the keys required by the chosen setup.
- Use the generator script with explicit flags. Example:

```bash
python3 .codex/skills/intentlane-setup/scripts/render_env.py \
  --bootstrap-root-password 'change-this-before-use' \
  --data-dir .local/dev-data \
  --output .env
```

- Use `--shared-token <token>` when the user explicitly wants token auth.
- Use `--allow-open-access` only for disposable local development.
- Use repeated `--allowed-origin <origin>` flags for cross-origin UI setups.

### 5. Run the correct commands

- Fresh clone path:
  - `pnpm install`
- Development mode:
  - `pnpm dev`
  - web UI: `http://localhost:5173/`
  - API: `http://localhost:4000/`
- Built app mode:
  - `pnpm build`
  - `pnpm start`
  - app and API: `http://localhost:4000/`
- Explain that `pnpm dev` needs the server, worker, and web processes together, and that `worker` is required for ticket automation.

### 6. Sanity-check the setup

- Run `curl http://localhost:4000/api/health` after the server is up.
- If bootstrap root auth is enabled, verify login with:

```bash
curl -X POST http://localhost:4000/api/access/login \
  -H 'Content-Type: application/json' \
  -d '{"name":"admin","password":"<password>"}'
```

- Explain that the bootstrap root account starts in `mustChangePassword` state.
- If the user chose open access, skip the login example and remind them that the mode is intentionally insecure.

## Boundaries

- Do not hand-edit runtime state under `tickets/`, `client-requests/`, `incidents/`, `background-runs/`, `explain/`, `direct-sessions/`, `access-control.json`, or `runtime.settings.json`.
- Do not recommend `APP_SHARED_TOKEN` as the default browser onboarding path.
- Do not expose secrets in the final response. If you generated a real password or token, mention where it was written instead of echoing it again.

## Resources

- `references/intentlane-setup-options.md`
  Use for the setup decision matrix, recommended defaults, and sanity-check checklist.
- `scripts/render_env.py`
  Use to render a deterministic `.env` file or snippet from the chosen answers.
