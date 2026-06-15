#!/usr/bin/env bash
#
# Install the OpenCode agent provider non-interactively: copy the payload from
# the `providers` branch, wire the three provider barrels, install the pinned
# SDK into the agent-runner tree, and add the OpenCode CLI to the container
# manifest (container/cli-tools.json). The image rebuild is the caller's job
# (the setup container step / `./container/build.sh`).
#
# Emits exactly one status block on stdout (ADD_OPENCODE); all chatty progress
# goes to stderr. Keep in sync with .claude/skills/add-opencode/SKILL.md.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Keep in sync with add-opencode SKILL.md. One pin drives BOTH the CLI
# (container/cli-tools.json) and the importable SDK (agent-runner dep) — they
# must match: the 1.14.x line is a breaking session-API change.
OPENCODE_VERSION="1.4.17"

# Resolve the source ref for the payload. Default: the nanoclaw remote's
# providers branch (handles forks where it isn't `origin`). Override with
# NANOCLAW_PROVIDERS_REF=<ref> to copy from a LOCAL branch instead — used to
# test this installer against an un-pushed providers branch before splitting
# the PRs. A local ref skips the fetch (mirrors NANOCLAW_CHANNELS_REMOTE).
# shellcheck source=setup/lib/channels-remote.sh
source "$PROJECT_ROOT/setup/lib/channels-remote.sh"
if [ -n "${NANOCLAW_PROVIDERS_REF:-}" ]; then
  BRANCH="$NANOCLAW_PROVIDERS_REF"
  REMOTE=""
else
  REMOTE=$(resolve_channels_remote)
  BRANCH="${REMOTE}/providers"
fi

# The opencode payload — host provider, container runtime, setup module, tests.
# Barrels are appended to, not copied.
PAYLOAD_FILES=(
  src/providers/opencode.ts
  src/providers/opencode-registration.test.ts
  container/agent-runner/src/providers/opencode.ts
  container/agent-runner/src/providers/mcp-to-opencode.ts
  container/agent-runner/src/providers/mcp-to-opencode.test.ts
  container/agent-runner/src/providers/opencode.factory.test.ts
  container/agent-runner/src/providers/opencode-registration.test.ts
  container/agent-runner/src/providers/opencode-cli-tools.test.ts
  setup/providers/opencode.ts
  setup/providers/opencode.test.ts
  setup/providers/opencode-registration.test.ts
)
BARRELS=(
  src/providers/index.ts
  container/agent-runner/src/providers/index.ts
  setup/providers/index.ts
)

ALREADY_INSTALLED=true
emit_status() {
  local status=$1 error=${2:-}
  echo "=== NANOCLAW SETUP: ADD_OPENCODE ==="
  echo "STATUS: ${status}"
  echo "OPENCODE_VERSION: ${OPENCODE_VERSION}"
  echo "ALREADY_INSTALLED: ${ALREADY_INSTALLED}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}
log() { echo "[add-opencode] $*" >&2; }

# Idempotent: a complete install has the host provider file, the host barrel
# import, and the OpenCode CLI in the container manifest. Any missing → (re)install.
need_install() {
  [ ! -f src/providers/opencode.ts ] && return 0
  ! grep -q "^import './opencode.js';" src/providers/index.ts 2>/dev/null && return 0
  ! grep -q '"opencode-ai"' container/cli-tools.json 2>/dev/null && return 0
  return 1
}

if need_install; then
  ALREADY_INSTALLED=false

  if [ -n "$REMOTE" ]; then
    log "Fetching providers branch from ${REMOTE}…"
    git fetch "$REMOTE" providers >&2 2>/dev/null || {
      emit_status failed "git fetch ${REMOTE} providers failed"
      exit 1
    }
  else
    log "Using local providers ref ${BRANCH} (NANOCLAW_PROVIDERS_REF)…"
  fi

  log "Copying OpenCode payload from ${BRANCH}…"
  for f in "${PAYLOAD_FILES[@]}"; do
    mkdir -p "$(dirname "$f")"
    git show "${BRANCH}:$f" > "$f" 2>/dev/null || {
      emit_status failed "providers ref is missing ${f}"
      exit 1
    }
  done

  log "Wiring provider barrels…"
  for b in "${BARRELS[@]}"; do
    grep -q "^import './opencode.js';" "$b" || printf "import './opencode.js';\n" >> "$b"
  done

  log "Installing the pinned OpenCode SDK into the agent-runner tree…"
  ( cd container/agent-runner && bun add "@opencode-ai/sdk@${OPENCODE_VERSION}" ) >&2 || {
    emit_status failed "bun add @opencode-ai/sdk@${OPENCODE_VERSION} failed"
    exit 1
  }

  log "Adding the OpenCode CLI to the container manifest (cli-tools.json)…"
  # A json-merge: append { name, version } if absent. The Dockerfile installs
  # every manifest entry via pinned `pnpm install -g` — no Dockerfile edit, no
  # awk surgery. opencode-ai has no native postinstall, so no "onlyBuilt".
  MANIFEST=container/cli-tools.json
  node -e '
    const fs = require("fs");
    const [file, name, version] = process.argv.slice(1);
    const tools = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!tools.some((t) => t.name === name)) {
      tools.push({ name, version });
      const fmt = (t) =>
        "  { " +
        Object.entries(t).map(([k, v]) => JSON.stringify(k) + ": " + JSON.stringify(v)).join(", ") +
        " }";
      fs.writeFileSync(file, "[\n" + tools.map(fmt).join(",\n") + "\n]\n");
    }
  ' "$MANIFEST" "opencode-ai" "${OPENCODE_VERSION}" || {
    emit_status failed "failed to add opencode-ai to ${MANIFEST}"
    exit 1
  }
fi

emit_status ok
