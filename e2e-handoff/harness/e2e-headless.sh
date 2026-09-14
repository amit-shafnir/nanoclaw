#!/bin/bash
# Headless replay of `ollama launch nanoclaw`: the Go launcher's exact sequence
# (depth-1 clone from the fixture registry, runtime alias with the model's max
# context, the NanoClaw launch script with the same flags) with the daemon in
# debug mode so every model request is logged with token counts and durations.
set -euo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # harness dir; bin/ holds a no-op open so a headless run opens no browser
E="${FIXTURE_DIR:?set FIXTURE_DIR to the fixture checkout}"
STATE="$(git -C "$E" rev-parse --git-dir)/e2e-state"
REG="$STATE/registry.git"; OLLAMA_BIN="$STATE/bin/ollama"
TEST_HOME="/private/tmp/ncl-e2e-$(basename "$E")"
OWNER="$TEST_HOME/.nanoclaw-e2e-owner"
PORT="${NANOCLAW_E2E_OLLAMA_PORT:-11435}"; URL="http://127.0.0.1:$PORT"
MODEL="${MODEL:-gemma4:12b-mlx}"
INSTALL="$TEST_HOME/.ollama/launch/nanoclaw"
PIDF="$STATE/ollama-server.pid"; LOGF="$STATE/ollama-server.log"
MODE="${1:-launch}"   # launch | relaunch (relaunch skips clone/alias, reuses install)

owned_server_running() {
  [[ -f "$PIDF" ]] || return 1
  local pid; pid="$(<"$PIDF")"; [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ "$(ps -p "$pid" -o command= 2>/dev/null)" == *"$OLLAMA_BIN serve"* ]]
}

if [[ "$MODE" == "launch" ]]; then
  test ! -e "$TEST_HOME" || { echo "E2E home exists; run $E/reset.sh first" >&2; exit 1; }
  mkdir -p "$TEST_HOME/.ollama" "$TEST_HOME/.docker/cli-plugins"
  printf '%s\n' "$STATE" > "$OWNER"
  [[ -f "$HOME/.ollama/config.json" ]] && { cp "$HOME/.ollama/config.json" "$TEST_HOME/.ollama/config.json"; chmod 600 "$TEST_HOME/.ollama/config.json"; }
  for p in docker-buildx docker-compose; do
    [[ -x "/Applications/Docker.app/Contents/Resources/cli-plugins/$p" ]] && ln -sfn "/Applications/Docker.app/Contents/Resources/cli-plugins/$p" "$TEST_HOME/.docker/cli-plugins/$p"
  done
  git config --file "$TEST_HOME/.gitconfig" "url.file://$REG/.insteadOf" https://github.com/nanocoai/nanoclaw
fi

# Daemon: the fixture's fork binary, models from the operator's real store, debug on.
if curl -fsS "$URL/api/version" >/dev/null 2>&1; then
  owned_server_running || { echo "Port $PORT is served by a process this fixture does not own" >&2; exit 1; }
  echo "[e2e] daemon already up (owned)"
else
  ln -sfn /Applications/Ollama.app/Contents/Resources/llama-server "$STATE/bin/llama-server"
  mkdir -p "$STATE/bin/lib/ollama"; ln -sfn /Applications/Ollama.app/Contents/Resources/mlx_metal_v4 "$STATE/bin/lib/ollama/mlx_metal_v4"
  echo "[e2e] === daemon start $(date -Iseconds) (OLLAMA_DEBUG=1) ===" >> "$LOGF"
  nohup env HOME="$HOME" OLLAMA_HOST="127.0.0.1:$PORT" OLLAMA_DEBUG=1 "$OLLAMA_BIN" serve >> "$LOGF" 2>&1 &
  echo $! > "$PIDF"
  for _ in $(seq 1 50); do curl -fsS "$URL/api/version" >/dev/null 2>&1 && break; sleep 0.2; done
  curl -fsS "$URL/api/version" >/dev/null || { echo "daemon did not start; see $LOGF" >&2; exit 1; }
  echo "[e2e] daemon started pid $(<"$PIDF")"
fi

export HOME="$TEST_HOME"
export PATH="$S/e2e/bin:$STATE/bin:$PATH"     # no-op `open` first: no browser tab during a headless run
export OLLAMA_HOST="127.0.0.1:$PORT"
export NANOCLAW_LOCAL_WEB_PORT="${NANOCLAW_LOCAL_WEB_PORT:-3210}"

if [[ "$MODE" == "launch" ]]; then
  echo "[e2e] clone (depth 1) from the fixture registry"
  mkdir -p "$(dirname "$INSTALL")"
  git clone -q --depth 1 https://github.com/nanocoai/nanoclaw "$INSTALL"
  echo "[e2e] clone at $(git -C "$INSTALL" rev-parse --short HEAD)"
fi

CTX=$(curl -fsS "$URL/api/show" -d "{\"model\":\"$MODEL\"}" | python3 -c 'import sys,json; mi=json.load(sys.stdin)["model_info"]; print([v for k,v in mi.items() if k.endswith("context_length")][0])')
ALIAS="nanoclaw/$(printf '%s' "$MODEL" | shasum -a 256 | cut -c1-12):latest"
echo "[e2e] model $MODEL ctx $CTX alias $ALIAS"
curl -fsS "$URL/api/create" -d "{\"model\":\"$ALIAS\",\"from\":\"$MODEL\",\"parameters\":{\"num_ctx\":$CTX}}" >/dev/null

ARGS=(--model "$MODEL" --runtime-model "$ALIAS" --base-url "${LAUNCH_BASE_URL:-$URL}" --web-browsing enabled --context-length "$CTX")
[[ -f "$INSTALL/data/upgrade-state.json" ]] || ARGS+=(--display-name "$(id -un)" --agent-name Ollama)
echo "[e2e] launch.sh ${ARGS[*]}"
cd "$INSTALL"
START=$(date +%s)
bash .claude/skills/setup-ollama-launch/scripts/launch.sh "${ARGS[@]}"
echo "[e2e] launch script finished in $(( $(date +%s) - START ))s"
