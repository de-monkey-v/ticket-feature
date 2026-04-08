#!/usr/bin/env python3
"""
Render a safe Intentlane .env file from explicit setup choices.

Examples:
  python3 .codex/skills/intentlane-setup/scripts/render_env.py \
    --bootstrap-root-password 'change-this-before-use'

  python3 .codex/skills/intentlane-setup/scripts/render_env.py \
    --bootstrap-root-password 'change-this-before-use' \
    --data-dir .local/dev-data \
    --output .env

  python3 .codex/skills/intentlane-setup/scripts/render_env.py \
    --shared-token 'secret-token' \
    --allowed-origin https://ticket.internal.example
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=4000)
    parser.add_argument('--bootstrap-root-name', default='admin')
    parser.add_argument('--bootstrap-root-password')
    parser.add_argument('--shared-token')
    parser.add_argument('--allow-open-access', action='store_true')
    parser.add_argument('--allowed-origin', action='append', default=[])
    parser.add_argument('--runtime-settings-path')
    parser.add_argument('--data-dir', default='.local/dev-data')
    parser.add_argument('--output')
    return parser.parse_args()


def normalize_origins(entries: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()

    for entry in entries:
        for origin in entry.split(','):
            trimmed = origin.strip()
            if not trimmed:
                continue
            if trimmed == '*':
                raise ValueError('APP_ALLOWED_ORIGINS cannot include "*"')
            parsed = urlparse(trimmed)
            if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
                raise ValueError(
                    f'APP_ALLOWED_ORIGINS must use explicit http/https origins: {trimmed}'
                )
            origin = f'{parsed.scheme}://{parsed.netloc}'
            if origin not in seen:
                normalized.append(origin)
                seen.add(origin)

    return normalized


def format_env_value(value: str) -> str:
    if value == '':
        return ''
    if re.fullmatch(r'[A-Za-z0-9._/:,@+-]+', value):
        return value
    return json.dumps(value)


def validate_args(args: argparse.Namespace) -> None:
    if not (1 <= args.port <= 65535):
        raise ValueError('PORT must be between 1 and 65535')

    if args.bootstrap_root_name != 'admin' and not args.bootstrap_root_password:
        raise ValueError(
            '--bootstrap-root-name requires --bootstrap-root-password so the account can be enabled'
        )

    if not args.bootstrap_root_password and not args.shared_token and not args.allow_open_access:
        raise ValueError(
            'Choose at least one auth path: --bootstrap-root-password, --shared-token, or --allow-open-access'
        )


def build_env_text(args: argparse.Namespace) -> str:
    bootstrap_enabled = bool(args.bootstrap_root_password)
    allowed_origins = normalize_origins(args.allowed_origin)

    lines = [
        '# Network binding for the API and built web app.',
        f'HOST={format_env_value(args.host)}',
        f'PORT={args.port}',
        '',
        '# Preferred production auth: bootstrap one root admin on first start,',
        '# sign in with that account, then create per-user accounts in the UI.',
        f'INTENTLANE_CODEX_BOOTSTRAP_ROOT_ENABLED={"1" if bootstrap_enabled else ""}',
        (
            'INTENTLANE_CODEX_BOOTSTRAP_ROOT_NAME='
            f'{format_env_value(args.bootstrap_root_name) if bootstrap_enabled else ""}'
        ),
        (
            'INTENTLANE_CODEX_BOOTSTRAP_ROOT_PASSWORD='
            f'{format_env_value(args.bootstrap_root_password or "")}'
        ),
        '',
        '# Optional shared admin bearer token.',
        '# Prefer leaving this empty when multiple users will access the app.',
        f'APP_SHARED_TOKEN={format_env_value(args.shared_token or "")}',
        '',
        '# Optional CORS allowlist for cross-origin web UIs.',
        '# Built app served from the same origin does not need this.',
        f'APP_ALLOWED_ORIGINS={format_env_value(",".join(allowed_origins))}',
        '',
        '# Optional path override for runtime project/model settings.',
        (
            'INTENTLANE_CODEX_RUNTIME_SETTINGS_PATH='
            f'{format_env_value(args.runtime_settings_path or "")}'
        ),
        '',
        '# Optional base directory for mutable runtime state such as tickets,',
        '# client requests, incidents, access-control, and runtime settings.',
        '# Recommended for local/dev isolation, e.g. .local/dev-data',
        f'INTENTLANE_CODEX_DATA_DIR={format_env_value(args.data_dir or "")}',
        '',
        '# Local-development-only escape hatch. Keep disabled for shared use.',
        f'INTENTLANE_CODEX_ALLOW_OPEN_ACCESS={"1" if args.allow_open_access else ""}',
        '',
    ]

    return '\n'.join(lines)


def main() -> int:
    args = parse_args()

    try:
        validate_args(args)
        env_text = build_env_text(args)
    except ValueError as error:
        print(f'[ERROR] {error}', file=sys.stderr)
        return 1

    if args.output:
        output_path = Path(args.output)
        output_path.write_text(env_text)
    else:
        sys.stdout.write(env_text)

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
