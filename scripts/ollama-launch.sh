#!/bin/bash
#
# ollama-launch.sh — headless entrypoint for `ollama launch nanoclaw`.
#
# Ollama's launcher clones this checkout (after consent), then execs this script
# with stdio inherited. We bootstrap the toolchain if it isn't ready, then hand
# off to the TypeScript orchestrator, which points this install at a local Ollama
# endpoint. Exit codes propagate verbatim (0 ok · 2 prereq · 3 manual · 1).
#
# Usage:
#   bash scripts/ollama-launch.sh --model <id> --base-url <url> \
#       [--display-name <name>] [--group <agent-group-id>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Bootstrap only when the toolchain isn't usable. setup.sh installs Node/pnpm and
# runs `pnpm install --frozen-lockfile` (a no-op once deps exist); skipping it
# when pnpm + the native sqlite module already load avoids its analytics/log churn.
if ! command -v pnpm >/dev/null 2>&1 || ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
  bash "$PROJECT_ROOT/setup.sh"
fi

exec pnpm exec tsx scripts/ollama-launch.ts "$@"
