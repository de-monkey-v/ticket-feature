#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="intentlane-codex.service"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
DEFAULT_PORT="4000"

usage() {
  cat <<'EOF'
Usage: control-prod.sh <command> [args]

Commands:
  up                Build, restart the production service, and health-check it
  start             Start the production service and health-check it
  down              Stop the production service
  restart           Restart the production service and health-check it
  status            Show service status
  logs [lines]      Show recent journal logs (default: 100)
  health            Call /api/health on the configured port
  port              Print the configured port
  set-port <port>   Update .env PORT, restart the service, and health-check it
EOF
}

read_port() {
  if [[ -f "$ENV_FILE" ]]; then
    local configured_port
    configured_port="$(sed -nE 's/^[[:space:]]*PORT=([0-9]+)[[:space:]]*$/\1/p' "$ENV_FILE" | tail -n 1)"
    if [[ -n "$configured_port" ]]; then
      printf '%s\n' "$configured_port"
      return
    fi
  fi

  printf '%s\n' "$DEFAULT_PORT"
}

validate_port() {
  local candidate="$1"
  if [[ ! "$candidate" =~ ^[0-9]+$ ]] || (( candidate < 1 || candidate > 65535 )); then
    echo "Invalid port: $candidate" >&2
    exit 1
  fi
}

write_port() {
  local new_port="$1"
  validate_port "$new_port"

  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing env file: $ENV_FILE" >&2
    exit 1
  fi

  if grep -qE '^[[:space:]]*PORT=' "$ENV_FILE"; then
    perl -0pi -e "s/^[[:space:]]*PORT=.*$/PORT=$new_port/m" "$ENV_FILE"
  else
    printf '\nPORT=%s\n' "$new_port" >> "$ENV_FILE"
  fi
}

health_url() {
  local port="${1:-$(read_port)}"
  printf 'http://127.0.0.1:%s/api/health\n' "$port"
}

wait_for_health() {
  local port="$1"
  local url
  url="$(health_url "$port")"

  for _ in $(seq 1 20); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      curl -fsS "$url"
      printf '\n'
      return 0
    fi
    sleep 1
  done

  echo "Health check failed: $url" >&2
  exit 1
}

service_status() {
  systemctl --user status "$SERVICE_NAME" --no-pager
}

case "${1:-}" in
  up)
    (
      cd "$ROOT_DIR"
      pnpm build
    )
    systemctl --user restart "$SERVICE_NAME"
    wait_for_health "$(read_port)"
    ;;
  start)
    systemctl --user start "$SERVICE_NAME"
    wait_for_health "$(read_port)"
    ;;
  down)
    systemctl --user stop "$SERVICE_NAME"
    ;;
  restart)
    systemctl --user restart "$SERVICE_NAME"
    wait_for_health "$(read_port)"
    ;;
  status)
    service_status
    ;;
  logs)
    journalctl --user -u "$SERVICE_NAME" -n "${2:-100}" --no-pager
    ;;
  health)
    curl -fsS "$(health_url)"
    printf '\n'
    ;;
  port)
    read_port
    ;;
  set-port)
    if [[ -z "${2:-}" ]]; then
      usage >&2
      exit 1
    fi

    write_port "$2"
    systemctl --user restart "$SERVICE_NAME"
    wait_for_health "$2"
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
