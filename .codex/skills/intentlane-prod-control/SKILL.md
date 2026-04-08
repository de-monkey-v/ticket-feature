---
name: intentlane-prod-control
description: Control the production `systemd --user` service for this repository, including deploy-style restarts, start/stop actions, health checks, journal inspection, and production port changes. Use when Codex needs to keep `intentlane-codex` running in production mode, bring it up or down, verify whether the built app is healthy, inspect service logs, or change the port in `.env` and restart safely.
---

# Intentlane Prod Control

Use this skill when the user wants the built app managed through the repository's production service instead of `pnpm dev`.

## Quick Start

- Use `scripts/control-prod.sh up` to build the app, restart the production service, and verify `/api/health`.
- Use `scripts/control-prod.sh down` to stop the production service cleanly.
- Use `scripts/control-prod.sh restart` to recycle the running service after config-only changes.
- Use `scripts/control-prod.sh status` or `scripts/control-prod.sh logs` to inspect the current state.
- Use `scripts/control-prod.sh set-port 4000` to update `.env`, restart the service, and verify the new port.

## Workflow

### 1. Confirm production mode

- Treat production mode as the user-level `systemd` unit `intentlane-codex.service`.
- Prefer this skill when the user asks to keep the app running, start or stop the deployed app, inspect production logs, or change the production port.
- Do not use `pnpm dev` for these requests.

### 2. Inspect before changing

- Read the current status first with `scripts/control-prod.sh status`.
- Read the active port with `scripts/control-prod.sh port` before reporting URLs or health-check commands.
- Assume the repository default production port is `4000` unless `.env` says otherwise.

### 3. Start, stop, or redeploy

- For "운영으로 띄워", "배포형으로 다시 띄워", or "지금 코드 반영해서 운영 재기동", run `scripts/control-prod.sh up`.
- For "운영 내려", "서비스 멈춰", or similar stop requests, run `scripts/control-prod.sh down`.
- For plain restart requests that do not need a rebuild, run `scripts/control-prod.sh restart`.

### 4. Change the production port

- Use `scripts/control-prod.sh set-port <port>` instead of editing `.env` by hand during execution.
- After changing the port, report the new app URL and health URL with the exact port.
- Verify the new port with `scripts/control-prod.sh health`.

### 5. Debug failures

- Use `scripts/control-prod.sh logs` for the recent journal output.
- If the service does not come up, check `scripts/control-prod.sh status` and `logs` before proposing broader changes.
- If the service fails after code changes, rebuild with `scripts/control-prod.sh up` rather than restarting stale output.

## Boundaries

- Do not edit runtime state under `tickets/`, `client-requests/`, `incidents/`, `background-runs/`, `explain/`, or `direct-sessions/`.
- Do not expose secret values from `.env` in user-facing responses.
- Do not change `~/.config/systemd/user/intentlane-codex.service` unless the task is explicitly about service wiring.
- On WSL, remember that `systemd --user` keeps the service running inside the distro, while Windows-side startup only needs to wake the distro.

## Resources

- `scripts/control-prod.sh`
  Use this wrapper for production lifecycle actions instead of retyping raw `systemctl`, `journalctl`, and port-update commands.
