---
name: add-opencode
description: Use OpenCode as an agent provider (AGENT_PROVIDER=opencode). OpenRouter, OpenAI, Google, DeepSeek, Anthropic, Zen, etc. via OpenCode config — not the Anthropic Agent SDK. Per-session and per-group via agent_provider; host passes OPENCODE_* and XDG mount when spawning containers.
---

# OpenCode agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected with **`AGENT_PROVIDER`** (`claude` | `codex` | `opencode` | `mock`).

Trunk ships only the `claude` provider baked in. OpenCode is a first-class pick in `/setup` now — but this skill is the manual / late-adopter path: it copies the OpenCode payload from the `providers` branch, wires it into the host and container barrels, installs the pinned SDK + CLI, and rebuilds the image.

## Install

The install is one idempotent script (re-running is safe — it self-skips when already wired):

```bash
bash setup/add-opencode.sh        # copy payload, wire barrels, bun add SDK, add CLI to cli-tools.json
./container/build.sh              # rebuild the agent image so the new CLI is baked in
```

That script:

- copies the payload files (`src/providers/opencode.ts`, the container runtime + tests, the setup module + tests) from the `providers` branch,
- appends `import './opencode.js';` to the three provider barrels (`src/providers/index.ts`, `container/agent-runner/src/providers/index.ts`, `setup/providers/index.ts`),
- runs `bun add @opencode-ai/sdk@1.4.17` in `container/agent-runner` (exact pin — the 1.14.x line is a breaking session-API change; bump deliberately, never `bun update`),
- adds `{ "name": "opencode-ai", "version": "1.4.17" }` to `container/cli-tools.json` (the global-CLI manifest the Dockerfile installs — **no Dockerfile edits**).

For a guided backend pick + key sign-in (writes `.env` + vaults the key for you), run the auth walk-through instead of editing config by hand:

```bash
pnpm exec tsx setup/index.ts --step provider-auth opencode
```

> **Local testing before pushing the `providers` PR:** the installer reads the payload from `${remote}/providers` by default. To test it against an un-pushed local branch, set `NANOCLAW_PROVIDERS_REF=<local-branch>` — it copies from that ref and skips the fetch.

## Configuration

`runAuth` (the `--step provider-auth opencode` path) writes these for you. To configure by hand, set them in `.env` — read **on the host** and passed into the container only when the effective provider is `opencode`. They do not switch the provider by themselves; the DB still needs `agent_provider` set (below).

- `OPENCODE_PROVIDER` — OpenCode provider id, e.g. `openrouter`, `anthropic`, `deepseek`, `opencode` (Zen).
- `OPENCODE_MODEL` — full model id in `provider/model` form, e.g. `deepseek/deepseek-chat`.
- `OPENCODE_SMALL_MODEL` — optional second model for lighter tasks; defaults to `OPENCODE_MODEL` if unset.
- `ANTHROPIC_BASE_URL` — **required for non-`anthropic` providers.** Routes the upstream provider's `baseURL` through OneCLI's credential proxy. Set it to the provider's API base (e.g. `https://api.deepseek.com/v1`, `https://openrouter.ai/api/v1`).

Credentials never live in `.env` or the container — register provider API keys in OneCLI with the matching `--host-pattern`; OneCLI injects them on the wire. Auto-created agents default to `all` secret mode, so the first agent receives a matching new secret automatically (only `selective`-mode agents need `onecli agents set-secrets`).

#### DeepSeek

```env
OPENCODE_PROVIDER=deepseek
OPENCODE_MODEL=deepseek/deepseek-chat
OPENCODE_SMALL_MODEL=deepseek/deepseek-chat
ANTHROPIC_BASE_URL=https://api.deepseek.com/v1
```
```bash
onecli secrets create --name "OpenCode (DeepSeek)" --type generic \
  --value YOUR_KEY --host-pattern "api.deepseek.com" \
  --header-name "Authorization" --value-format "Bearer {value}"
```

#### OpenRouter

```env
OPENCODE_PROVIDER=openrouter
OPENCODE_MODEL=openrouter/anthropic/claude-sonnet-4
OPENCODE_SMALL_MODEL=openrouter/anthropic/claude-haiku-4.5
ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
```
```bash
onecli secrets create --name "OpenCode (OpenRouter)" --type generic \
  --value YOUR_KEY --host-pattern "openrouter.ai" \
  --header-name "Authorization" --value-format "Bearer {value}"
```

#### Anthropic (no `ANTHROPIC_BASE_URL`)

When `OPENCODE_PROVIDER=anthropic`, OpenCode uses the native Anthropic endpoint — the proxy + placeholder-key pattern is unchanged and no base URL override is needed. Let OneCLI own header injection (`--type anthropic`, no custom header).

```env
OPENCODE_PROVIDER=anthropic
OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514
OPENCODE_SMALL_MODEL=anthropic/claude-haiku-4-5-20251001
```

#### OpenCode Zen (`x-api-key`, not Bearer)

Zen's HTTP API expects the key in the **`x-api-key`** header — `Authorization: Bearer …` returns 401 / "Missing API key". Note the naming overlap: NanoClaw `AGENT_PROVIDER=opencode` means "run the OpenCode provider"; `OPENCODE_PROVIDER=opencode` in `.env` is OpenCode's **Zen** provider id ([Zen docs](https://opencode.ai/docs/zen/)).

```env
OPENCODE_PROVIDER=opencode
OPENCODE_MODEL=opencode/big-pickle
OPENCODE_SMALL_MODEL=opencode/big-pickle
ANTHROPIC_BASE_URL=https://opencode.ai/zen/v1
```
```bash
onecli secrets create --name "OpenCode (Zen)" --type generic \
  --value YOUR_ZEN_KEY --host-pattern opencode.ai \
  --header-name "x-api-key" --value-format "{value}"
```

### Switch a group to OpenCode

```bash
ncl groups config update --id <group-id> --provider opencode
```

The DB columns `agent_groups.agent_provider` / `sessions.agent_provider` (session overrides group) drive the host-side contribution (per-session XDG mount, `OPENCODE_*` passthrough) and are materialized to the group's `container.json` at spawn time. Extra MCP servers still come from `container_config.mcpServers`; the runner merges them into the same `mcpServers` object passed to every provider.

## Operational notes

- OpenCode keeps a local **`opencode serve`** process and SSE subscription; the provider tears down with **`stream.return`** and **SIGKILL** on the server process on **`abort()`** / shared-runtime reset to avoid MCP/zombie hangs.
- Session continuation uses UUID format (SDK 1.4.x / CLI 1.4.x). Stale sessions are cleared by `isSessionInvalid` on OpenCode-specific error patterns. If you see UUID-related errors after an accidental CLI upgrade, clear `session_state` in `outbound.db` and wipe the `opencode-xdg` dir under the session folder.
- **`NO_PROXY`** for localhost matters when the OpenCode client talks to `127.0.0.1` inside the container while HTTP(S)_PROXY is set (e.g. OneCLI). The host provider config merges it in.

## Verify

```bash
grep -q "./opencode.js" src/providers/index.ts && echo "host barrel: OK"
grep -q "./opencode.js" container/agent-runner/src/providers/index.ts && echo "container barrel: OK"
grep -q '"opencode-ai"' container/cli-tools.json && echo "CLI manifest: OK"
grep -q '@opencode-ai/sdk' container/agent-runner/package.json && echo "agent-runner dep: OK"
cd container/agent-runner && bun test src/providers/ && cd -
```
