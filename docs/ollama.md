# Running Agents on Local Ollama

NanoClaw agents can be routed to a local [Ollama](https://ollama.com) instance instead of the Anthropic API. This cuts API costs to zero and keeps all inference on your hardware.

## How It Works

Ollama exposes an Anthropic-compatible `/v1/messages` endpoint. The Claude Code CLI (which runs inside agent containers) uses the Anthropic SDK, which reads `ANTHROPIC_BASE_URL` to find the API host. Pointing that variable at Ollama is all that's needed — no new provider code, no changes to the agent runtime.

```
┌─────────────────────────────┐
│  Agent container            │
│                             │
│  Claude Code CLI            │
│    ↓ ANTHROPIC_BASE_URL     │
│    http://host.docker.      │      ┌──────────────────┐
│    internal:11434    ───────┼─────▶│  Ollama :11434   │
│                             │      │  gemma4:latest   │
└─────────────────────────────┘      └──────────────────┘
```

`host.docker.internal` is Docker's magic hostname that resolves to the host machine from inside a container — so Ollama running on your Mac or Linux box is reachable at that address.

## The OneCLI Complication

NanoClaw normally runs API calls through an OneCLI HTTPS proxy that injects real credentials in place of a placeholder key. When redirecting to Ollama you need to bypass that proxy so requests go direct. Two env vars handle this:

- `NO_PROXY=host.docker.internal` — tells the Anthropic SDK's HTTP client to skip the proxy for that hostname
- `no_proxy=host.docker.internal` — lowercase variant for tools that check the lowercase form

Both are set in the agent group's `container.json` alongside `ANTHROPIC_BASE_URL`.

## Network Isolation

Setting `ANTHROPIC_BASE_URL` redirects requests but doesn't prevent a misconfigured agent from accidentally reaching `api.anthropic.com` directly. The `blockedHosts` field in `container.json` adds a Docker `--add-host` flag that resolves the domain to `0.0.0.0`, making it physically unreachable from inside the container:

```json
"blockedHosts": ["api.anthropic.com"]
```

With this in place, even if the model setting drifts back to a Claude model name, the API call will fail immediately rather than silently billing your account.

## Model Selection

The Claude Code CLI reads its model from `~/.claude/settings.json` inside the container, which NanoClaw bind-mounts from `data/v2-sessions/<agent-group-id>/.claude-shared/settings.json`. Set `"model": "gemma4:latest"` (or whatever Ollama model you've pulled) there. Use the exact name from `ollama list`.

Model selection considerations for Apple Silicon:

| Model | Size | Quality | Speed (M4 Pro) |
|-------|------|---------|----------------|
| `gemma4:latest` | 8.0B | Good general-purpose | Fast |
| `qwen3-coder:latest` | 32B | Excellent for coding tasks | Moderate |
| `llama3.2:latest` | 3B | Basic | Very fast |

The agent uses tool calls extensively (read/write files, shell commands). Models that support tool use reliably work best. Gemma 4 and Qwen 3 Coder both handle structured tool calls well.

## Per-turn latency: keep the prompt front stable

Out of the box this path gets **slower every message** — each reply re-reads the whole (growing) multi-thousand-token prompt from scratch, even for a one-word answer. Ollama has a KV prefix cache that should skip that repeated work, but on this path it never kicks in.

**Cause.** The bundled `claude` binary stamps a billing line — `x-anthropic-billing-header: ...; cch=<nonce>; ...cc_version=<ver>` — as the **first** system block of every request. Both the `cch` nonce and the `cc_version` suffix rotate every turn. Ollama's prefix cache is anchored at token 0, so a value that changes at the very front makes Ollama treat the entire prompt as new and re-prefill all of it. (Ollama ignores the line itself, so removing it doesn't change output.)

**Fix.** Set `CLAUDE_CODE_ATTRIBUTION_HEADER=off` in the agent group's `container.json` `env` block — the `/add-ollama-provider` skill and the `ollama launch nanoclaw` flow both do this. The binary then omits the billing line entirely, the prompt front is static, and the cache holds across turns. Follow-up replies drop to a fraction of a second; turn-1 still pays a one-time cold prefill (the launcher primes it with a throwaway turn at warmup). No proxy, no provider code. Cutting the system prompt or tool schemas instead does *nothing* for steady-state latency — the rotating front is the whole problem.

> `CLAUDE_CODE_ATTRIBUTION_HEADER` is an undocumented binary env var. If a binary bump ignores it (the billing line reappears at the front), fall back to the proxy below — and re-check the var name against the request body.

**Fallback — strip the line in a proxy.** If the env var stops working, run a tiny proxy between the container and Ollama that pins the **whole** billing line (both `cch` and `cc_version`) to a constant. Point the agent group's `ANTHROPIC_BASE_URL` at the proxy instead of Ollama directly:

```
ANTHROPIC_BASE_URL=http://host.docker.internal:11999   # the proxy
# proxy forwards to http://127.0.0.1:11434 (Ollama)
```

The proxy is ~40 lines of dependency-free Node:

```js
// ollama-billing-proxy.mjs — neutralize the binary's per-turn billing line so
// Ollama's prefix cache survives across turns. Listens on :11999, forwards to
// Ollama. Pinning only `cch=` is NOT enough — the `cc_version` suffix rotates
// too, so the whole `x-anthropic-billing-header:` value must be pinned.
import http from 'node:http';

const TARGET_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.OLLAMA_PORT || 11434);
const LISTEN_PORT = Number(process.env.PROXY_PORT || 11999);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    if (req.method === 'POST' && body.length) {
      body = Buffer.from(
        body.toString('utf8').replace(/x-anthropic-billing-header:[^"\n]*/g, 'x-anthropic-billing-header: pinned'),
        'utf8',
      );
    }
    const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}`, 'content-length': String(body.length) };
    const proxyReq = http.request(
      { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    proxyReq.end(body);
  });
});
server.listen(LISTEN_PORT, '0.0.0.0', () => console.log(`cch-proxy :${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`));
```

Run it durably so it survives reboots. On Linux, a systemd user service:

```ini
# ~/.config/systemd/user/ollama-cch-proxy.service
[Unit]
Description=Ollama cch-normalizing proxy for NanoClaw
After=network-online.target

[Service]
ExecStart=/usr/bin/node %h/.config/nanoclaw/ollama-cch-proxy.mjs
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now ollama-cch-proxy
loginctl enable-linger "$USER"   # so it runs without an active login session
```

On macOS use a `launchd` user agent (`~/Library/LaunchAgents/`) running the same script.

**Scope.** This only affects the Claude-Code-CLI → Ollama path described here. Codex and OpenCode don't use the Claude Agent SDK, so they never emit the billing line and get prompt caching for free.

## What Changes at the Code Level

Three files need to support this feature. See `/add-ollama-provider` for the exact changes.

**`src/container-config.ts`** — `ContainerConfig` interface needs `env` and `blockedHosts` fields so the per-group JSON can carry them.

**`src/container-runner.ts`** — At container spawn time, `env` entries become `-e KEY=VAL` Docker flags (applied after OneCLI's injected vars so they win), and `blockedHosts` entries become `--add-host HOST:0.0.0.0` flags.

**`container/Dockerfile`** — The container runs as the host user's uid (e.g. 501 on macOS), not as the `node` user (uid 1000). The home directory must be `chmod 777` so any uid can write `~/.claude.json` and `~/.claude/settings.json`.

## Tradeoffs

| | Ollama (local) | Anthropic API |
|---|---|---|
| Cost | Free | Pay-per-token |
| Privacy | Fully local | Data sent to Anthropic |
| Model quality | Good (open-weight) | Excellent (Claude) |
| Cold start | 5–30s (model load) | ~1s |
| Context window | Varies by model | 200k tokens (Sonnet) |
| Tool use reliability | Good (large models) | Excellent |
| Hardware req. | 16GB+ RAM | None |

For personal automation on capable hardware, the tradeoff favors local. For complex multi-step tasks requiring large context or high reliability, Claude is still ahead.

## Reverting to Claude

Remove the `env` and `blockedHosts` keys from `groups/<folder>/container.json`, remove `"model"` from the shared settings file, and restart the service. No rebuild needed.

## See Also

- `/add-ollama-provider` — step-by-step skill to configure any agent group for Ollama
- [Ollama Anthropic compatibility docs](https://ollama.com/blog/openai-compatibility) — upstream docs on the API bridge
- `docs/architecture.md` — how the container spawn and env injection pipeline works
