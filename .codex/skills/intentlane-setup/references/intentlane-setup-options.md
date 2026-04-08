# Intentlane Setup Options

## Recommended defaults

- Run mode: `pnpm dev`
- Auth: bootstrap root admin
- Root account name: `admin`
- Runtime data isolation: `INTENTLANE_CODEX_DATA_DIR=.local/dev-data`
- Host and port: `HOST=0.0.0.0`, `PORT=4000`
- CORS: leave `APP_ALLOWED_ORIGINS` empty unless the web UI is hosted on a different origin

## Question order

1. Do you want watch mode with Vite (`pnpm dev`) or a built app (`pnpm build && pnpm start`)?
2. Will this run only on your local machine, or will other people access it?
3. Do you need normal browser login on first run, token-only API access, or a disposable no-auth local demo?
4. Do you want runtime data kept under the repo root, or isolated under something like `.local/dev-data`?
5. Should I only prepare the config, or also run install/start/sanity-check commands?

## Auth matrix

| Scenario | Settings | Notes |
| --- | --- | --- |
| First browser-based setup | `INTENTLANE_CODEX_BOOTSTRAP_ROOT_ENABLED=1`, root name, root password | Best default. Browser login works. First login must change password. |
| API or automation first | `APP_SHARED_TOKEN=<token>` | Supported, but the default browser login form does not accept the bearer token directly. |
| Disposable local-only demo | `INTENTLANE_CODEX_ALLOW_OPEN_ACCESS=1` | Local development only. Do not use on shared environments. |
| Cross-origin web UI | `APP_ALLOWED_ORIGINS=https://...` | Use explicit origins only. Never use `*`. |

## Run commands

### Development

```bash
pnpm install
pnpm dev
```

- Web UI: `http://localhost:5173/`
- API: `http://localhost:4000/`
- Health: `http://localhost:4000/api/health`

`pnpm dev` runs:

- `pnpm dev:server`
- `pnpm dev:worker`
- `pnpm dev:web`

### Built app

```bash
pnpm install
pnpm build
pnpm start
```

- App + API: `http://localhost:4000/`
- Do not run `pnpm start` before `pnpm build`

## Sanity checks

### Health

```bash
curl http://localhost:4000/api/health
```

Expected response:

```json
{"status":"ok"}
```

### Bootstrap root login

```bash
curl -X POST http://localhost:4000/api/access/login \
  -H 'Content-Type: application/json' \
  -d '{"name":"admin","password":"<password>"}'
```

Expected response shape:

```json
{
  "token": "<session-token>",
  "session": {
    "id": "ses_...",
    "accountName": "admin"
  }
}
```

## Notes

- Runtime state belongs in generated data paths, not in manual edits.
- `APP_SHARED_TOKEN` can coexist with bootstrap root auth, but it is not the preferred first-run browser path.
- The built app serves the UI and API from the same origin, so `APP_ALLOWED_ORIGINS` is usually unnecessary there.
- The API already allows `http://localhost:5173` and `http://127.0.0.1:5173` in development.
