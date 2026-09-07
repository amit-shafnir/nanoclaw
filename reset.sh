#!/bin/bash
set -euo pipefail

worktree_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
state_root="$(git -C "$worktree_root" rev-parse --git-dir)/e2e-state"
test_home="/private/tmp/ncl-e2e-$(basename "$worktree_root")"
owner_marker="$test_home/.nanoclaw-e2e-owner"
install_root="$test_home/.ollama/launch/nanoclaw"
server_pid_file="$state_root/ollama-server.pid"
ollama_bin="$state_root/bin/ollama"

if [[ "$test_home" != /private/tmp/ncl-e2e-* ]]; then
  echo "Refusing to reset an unexpected path: $test_home" >&2
  exit 1
fi
if [[ -e "$test_home" && ( ! -f "$owner_marker" || "$(<"$owner_marker")" != "$state_root" ) ]]; then
  echo "Refusing to reset E2E state not owned by this worktree: $test_home" >&2
  exit 1
fi

if [[ -x "$install_root/nanoclaw.sh" && -d "$install_root/node_modules" ]]; then
  HOME="$test_home" PATH="$test_home/.local/bin:$PATH" \
    bash "$install_root/nanoclaw.sh" --uninstall --yes
elif [[ -x "$install_root/nanoclaw.sh" ]]; then
  service_artifact=""
  if [[ -d "$test_home/Library/LaunchAgents" ]]; then
    service_artifact="$(find "$test_home/Library/LaunchAgents" -maxdepth 1 -name 'com.nanoclaw-v2-*.plist' -print -quit)"
  fi
  if [[ -n "$service_artifact" ]]; then
    echo "Refusing to remove a partial E2E home with a service artifact: $service_artifact" >&2
    exit 1
  fi
  echo "Removing pre-service partial install (bootstrap did not finish)."
fi

if [[ -f "$server_pid_file" ]]; then
  server_pid="$(<"$server_pid_file")"
  if [[ "$server_pid" =~ ^[0-9]+$ ]] && kill -0 "$server_pid" 2>/dev/null; then
    command="$(ps -p "$server_pid" -o command= 2>/dev/null || true)"
    if [[ "$command" != *"$ollama_bin serve"* ]]; then
      echo "Refusing to stop reused PID $server_pid; it is not the E2E Ollama server." >&2
      exit 1
    fi
    kill "$server_pid"
    for _ in {1..50}; do
      kill -0 "$server_pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$server_pid" 2>/dev/null; then
      kill -KILL "$server_pid"
    fi
  fi
  rm -f "$server_pid_file"
fi

/bin/rm -rf -- "$test_home"
echo "E2E state reset. Run ./run.sh to start again from installation consent."
