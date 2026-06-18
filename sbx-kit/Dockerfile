FROM docker/sandbox-templates:claude-code-docker

USER root

RUN npm install -g pnpm@10.33.0

COPY scripts/seed-images.sh /usr/local/bin/nanoclaw-seed-images
COPY scripts/start-nanoclaw.sh /usr/local/bin/nanoclaw-start
RUN chmod 0755 /usr/local/bin/nanoclaw-seed-images /usr/local/bin/nanoclaw-start

ARG AGENT_IMAGE=nanoclaw-agent:latest
ARG AGENT_TAG=nanoclaw-agent:latest
ARG ONECLI_IMAGE=ghcr.io/onecli/onecli:1.36.0
ARG ONECLI_TAG=ghcr.io/onecli/onecli:1.36.0
ARG POSTGRES_IMAGE=postgres:18-alpine
ARG POSTGRES_TAG=postgres:18-alpine
ARG ONECLI_GATEWAY_VERSION=1.36.0

RUN install -d -m 0755 /opt/nanoclaw && \
    printf '%s %s\n' \
      "$AGENT_IMAGE" "$AGENT_TAG" \
      "$ONECLI_IMAGE" "$ONECLI_TAG" \
      "$POSTGRES_IMAGE" "$POSTGRES_TAG" \
      > /opt/nanoclaw/inner-images.txt

USER agent

ARG NANOCLAW_REPO=https://github.com/nanocoai/nanoclaw
ARG NANOCLAW_REF=main
ARG ONECLI_CLI_VERSION=2.2.5

ENV PATH="/home/agent/.local/bin:${PATH}"
ENV ONECLI_VERSION="${ONECLI_GATEWAY_VERSION}"

WORKDIR /home/agent
RUN if git clone --depth 1 --branch "$NANOCLAW_REF" "$NANOCLAW_REPO" nanoclaw; then \
      :; \
    else \
      git clone --depth 1 "$NANOCLAW_REPO" nanoclaw && \
      cd nanoclaw && \
      git fetch --depth 1 origin "$NANOCLAW_REF" && \
      git checkout FETCH_HEAD && \
      cd ..; \
    fi && \
    cd nanoclaw && \
    git fetch --depth 1 origin channels:refs/remotes/origin/channels && \
    git fetch --depth 1 origin providers:refs/remotes/origin/providers

WORKDIR /home/agent/nanoclaw
RUN pnpm install --frozen-lockfile --network-concurrency=1 && \
    pnpm rebuild better-sqlite3 && \
    pnpm run build && \
    pnpm exec tsx scripts/upgrade-state.ts set

RUN set -eu; \
    mkdir -p "$HOME/.local/bin"; \
    os=linux; \
    case "$(uname -m)" in \
      x86_64|amd64) arch=amd64 ;; \
      arm64|aarch64) arch=arm64 ;; \
      *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    tmp="$(mktemp -d)"; \
    trap 'rm -rf "$tmp"' EXIT; \
    archive="onecli_${ONECLI_CLI_VERSION}_${os}_${arch}.tar.gz"; \
    curl -fsSL -o "$tmp/$archive" \
      "https://github.com/onecli/onecli-cli/releases/download/v${ONECLI_CLI_VERSION}/$archive"; \
    tar -xzf "$tmp/$archive" -C "$tmp"; \
    install -m 0755 "$tmp/onecli" "$HOME/.local/bin/onecli"; \
    onecli version

WORKDIR /sbx-workspace
CMD ["/usr/local/bin/nanoclaw-start"]
