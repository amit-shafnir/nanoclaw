#!/usr/bin/env bash
# Build NanoClaw's Docker Sandbox images from a clean upstream ref.
set -euo pipefail

REF="${NANOCLAW_REF:-main}"
REPO="${NANOCLAW_REPO:-https://github.com/nanocoai/nanoclaw}"
TARGET="${TARGET:-sbx}"
IMAGE="${IMAGE:-nanoclaw-sbx:local}"
AGENT_IMAGE="${AGENT_IMAGE:-docker.io/nanocoai/nanoclaw-agent:latest}"
AGENT_TAG="${AGENT_TAG:-nanoclaw-agent:latest}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:18-alpine}"
POSTGRES_TAG="${POSTGRES_TAG:-$POSTGRES_IMAGE}"
KIT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT

clone_source() {
  if [ ! -d "$ctx/nanoclaw/.git" ]; then
    echo "==> Cloning $REPO@$REF"
    if ! git clone --depth 1 --branch "$REF" "$REPO" "$ctx/nanoclaw"; then
      git clone --depth 1 "$REPO" "$ctx/nanoclaw"
      git -C "$ctx/nanoclaw" fetch --depth 1 origin "$REF"
      git -C "$ctx/nanoclaw" checkout FETCH_HEAD
    fi
    git -C "$ctx/nanoclaw" fetch --depth 1 origin channels:refs/remotes/origin/channels
    git -C "$ctx/nanoclaw" fetch --depth 1 origin providers:refs/remotes/origin/providers
  fi
}

json_value() {
  node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(v[process.argv[2]] || ""));' "$1" "$2"
}

read_versions() {
  clone_source
  ONECLI_GATEWAY_VERSION="${ONECLI_GATEWAY_VERSION:-$(json_value "$ctx/nanoclaw/versions.json" onecli-gateway)}"
  ONECLI_CLI_VERSION="${ONECLI_CLI_VERSION:-$(json_value "$ctx/nanoclaw/versions.json" onecli-cli)}"
  ONECLI_IMAGE="${ONECLI_IMAGE:-ghcr.io/onecli/onecli:${ONECLI_GATEWAY_VERSION}}"
  ONECLI_TAG="${ONECLI_TAG:-$ONECLI_IMAGE}"
}

build_agent() {
  clone_source
  echo "==> Building agent image ${AGENT_IMAGE}"
  docker build -t "$AGENT_IMAGE" "$ctx/nanoclaw/container"
  case "$AGENT_IMAGE" in
    */*)
      echo "==> Pushing agent image ${AGENT_IMAGE}"
      docker push "$AGENT_IMAGE"
      ;;
    *)
      echo "==> Agent image is local-only (${AGENT_IMAGE}); not pushing"
      ;;
  esac
}

build_sbx() {
  read_versions
  echo "==> Building sandbox image ${IMAGE}"
  echo "    nanoclaw = ${REPO}@${REF}"
  echo "    agent    = ${AGENT_IMAGE} -> ${AGENT_TAG}"
  echo "    onecli   = ${ONECLI_IMAGE} -> ${ONECLI_TAG}"
  echo "    postgres = ${POSTGRES_IMAGE} -> ${POSTGRES_TAG}"
  docker build -t "$IMAGE" \
    --build-arg NANOCLAW_REPO="$REPO" \
    --build-arg NANOCLAW_REF="$REF" \
    --build-arg AGENT_IMAGE="$AGENT_IMAGE" \
    --build-arg AGENT_TAG="$AGENT_TAG" \
    --build-arg ONECLI_IMAGE="$ONECLI_IMAGE" \
    --build-arg ONECLI_TAG="$ONECLI_TAG" \
    --build-arg ONECLI_GATEWAY_VERSION="$ONECLI_GATEWAY_VERSION" \
    --build-arg ONECLI_CLI_VERSION="$ONECLI_CLI_VERSION" \
    --build-arg POSTGRES_IMAGE="$POSTGRES_IMAGE" \
    --build-arg POSTGRES_TAG="$POSTGRES_TAG" \
    "$KIT_DIR"
}

case "$TARGET" in
  agent) build_agent ;;
  sbx) build_sbx ;;
  all) build_agent; build_sbx ;;
  *) echo "TARGET must be agent|sbx|all" >&2; exit 1 ;;
esac

echo "==> Done"
