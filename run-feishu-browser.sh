#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${1:-$ROOT/.env.feishu-browser}"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi
set -a
source "$ENV_FILE"
set +a
cd "$ROOT"
exec node src/index.js
