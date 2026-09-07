#!/bin/bash
set -euo pipefail

worktree_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
state_root="$(git -C "$worktree_root" rev-parse --git-dir)/e2e-state"
test_home="/private/tmp/ncl-e2e-$(basename "$worktree_root")"
owner_marker="$test_home/.nanoclaw-e2e-owner"
operator_home="$HOME"
ollama_bin="$state_root/bin/ollama"
registry="$state_root/registry.git"
server_host="127.0.0.1"
server_port="${NANOCLAW_E2E_OLLAMA_PORT:-11436}"
server_url="http://$server_host:$server_port"
server_pid_file="$state_root/ollama-server.pid"
server_log="$state_root/ollama-server.log"

if [[ ! "$server_port" =~ ^[0-9]+$ ]] || (( server_port < 1 || server_port > 65535 )); then
  echo "Invalid NANOCLAW_E2E_OLLAMA_PORT: $server_port" >&2
  exit 1
fi
if [[ ! -x "$ollama_bin" ]]; then
  echo "E2E Ollama binary is missing: $ollama_bin" >&2
  exit 1
fi
if [[ ! -d "$registry" ]]; then
  echo "E2E NanoClaw registry is missing: $registry" >&2
  exit 1
fi

if [[ -e "$test_home" && ! -f "$owner_marker" ]]; then
  echo "Refusing to use an unowned E2E home: $test_home" >&2
  exit 1
fi
if [[ -f "$owner_marker" && "$(<"$owner_marker")" != "$state_root" ]]; then
  echo "Refusing to use E2E state owned by another worktree: $test_home" >&2
  exit 1
fi

mkdir -p "$test_home/.ollama" "$test_home/.docker/cli-plugins" "$state_root/bin/lib/ollama"
printf '%s\n' "$state_root" > "$owner_marker"

# macOS Unix sockets have a short path limit. Keeping HOME under /private/tmp
# prevents cli.sock and ncl.sock from exceeding it in deeply nested worktrees.
socket_path="$test_home/.ollama/launch/nanoclaw/data/ncl.sock"
if (( ${#socket_path} >= 104 )); then
  echo "E2E home is too long for a macOS Unix socket: $socket_path" >&2
  exit 1
fi

# Reuse the operator's Ollama sign-in without exposing or modifying it. The
# copy lives only in this isolated E2E home.
if [[ -f "$operator_home/.ollama/config.json" && ! -f "$test_home/.ollama/config.json" ]]; then
  cp "$operator_home/.ollama/config.json" "$test_home/.ollama/config.json"
  chmod 600 "$test_home/.ollama/config.json"
fi

# Docker Desktop discovers CLI plugins below HOME. The isolated home would
# otherwise hide buildx and compose from an otherwise healthy installation.
if [[ -x /Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx ]]; then
  ln -sfn /Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx \
    "$test_home/.docker/cli-plugins/docker-buildx"
fi
if [[ -x /Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose ]]; then
  ln -sfn /Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose \
    "$test_home/.docker/cli-plugins/docker-compose"
fi
if ! HOME="$test_home" docker info >/dev/null 2>&1; then
  echo "Docker Desktop is installed but its engine is not ready. Wait until Docker reports Running, then retry." >&2
  exit 2
fi

# The E2E server uses the reviewed local Ollama binary while reusing the
# installed Ollama app's runner and MLX libraries. Nothing is copied into the
# app bundle and the normal 11434 daemon is untouched.
if [[ "$(uname -s)" == "Darwin" ]]; then
  runner=/Applications/Ollama.app/Contents/Resources/llama-server
  mlx=/Applications/Ollama.app/Contents/Resources/mlx_metal_v4
  if [[ ! -x "$runner" || ! -d "$mlx" ]]; then
    echo "Ollama.app runtime files are missing; reinstall/update Ollama and retry." >&2
    exit 1
  fi
  ln -sfn "$runner" "$state_root/bin/llama-server"
  ln -sfn "$mlx" "$state_root/bin/lib/ollama/mlx_metal_v4"
fi

owned_server_running() {
  [[ -f "$server_pid_file" ]] || return 1
  local pid command
  pid="$(<"$server_pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command" == *"$ollama_bin serve"* ]]
}

if curl -fsS "$server_url/api/version" >/dev/null 2>&1; then
  if ! owned_server_running; then
    echo "Port $server_port is already used by a server this worktree does not own." >&2
    exit 1
  fi
else
  if [[ -f "$server_pid_file" ]] && ! owned_server_running; then
    rm -f "$server_pid_file"
  fi
  : > "$server_log"
  nohup env HOME="$operator_home" OLLAMA_HOST="$server_host:$server_port" \
    "$ollama_bin" serve >> "$server_log" 2>&1 &
  server_pid=$!
  printf '%s\n' "$server_pid" > "$server_pid_file"
  for _ in {1..50}; do
    if curl -fsS "$server_url/api/version" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
  if ! curl -fsS "$server_url/api/version" >/dev/null 2>&1; then
    kill "$server_pid" 2>/dev/null || true
    rm -f "$server_pid_file"
    echo "The isolated Ollama server did not start. See $server_log" >&2
    exit 1
  fi
fi

git config --file "$test_home/.gitconfig" \
  "url.file://$registry/.insteadOf" \
  https://github.com/nanocoai/nanoclaw

export HOME="$test_home"
export PATH="$state_root/bin:$PATH"
export OLLAMA_HOST="$server_host:$server_port"
export NANOCLAW_LOCAL_WEB_PORT="${NANOCLAW_LOCAL_WEB_PORT:-3211}"

# No model is selected here. Running without --model exercises the real user
# picker; explicit arguments are forwarded only when the tester supplies them.
exec "$ollama_bin" launch nanoclaw "$@"
