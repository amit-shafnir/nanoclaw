# Agent Templates

A **template** is a reusable directory you stamp into a working agent group: it
carries the agent's standing instructions, its MCP tool servers, its skills,
and optional recurring tasks, but **no secrets and no provider**. Point `ncl`
at one and you get a configured agent in seconds; you choose the
runtime/provider separately.

Templates use the vendor-neutral
[Agent Plugins 1.0.0](https://agent-plugins.org) directory format. The
portable surface (skills, `mcp.json`) follows the spec exactly; everything
NanoClaw-specific (persona, extra context, tasks, display name) rides in the
spec's extension mechanism under the `ai.nanoco.nanoclaw` namespace. Two
consequences:

- **A NanoClaw template is a conformant plugin.** Dropped into another
  spec-compatible client (Codex, Cursor, VS Code, ...), its skills and MCP
  servers load; the NanoClaw extras are ignored by rule.
- **A conformant third-party plugin is a stampable template.** Only
  `plugin.json` is required, so a persona-less native plugin stamps as a new
  agent group with its skills and MCP servers; the NanoClaw-only slots stay
  empty and the group is named after the folder.

Templates are purely additive and require no DB migration. **Templates
are resolved only from a local directory**: `templates/` at the
project root by default (committed but shipped empty), or whatever
`NANOCLAW_TEMPLATES_DIR` points at (a local path only). The public registry
([`nanocoai/nanoclaw-templates`](https://github.com/nanocoai/nanoclaw-templates))
is a manual copy source — clone or download it yourself and copy the chosen
template into your local `templates/` before stamping.

> **Migrating from the pre-plugin layout?** The old format (a bare
> `context/instructions.md` marker, `.mcp.json`) is no longer read; stamping
> one fails with a migration error. Re-fetch the template from the registry,
> or convert it: add `plugin.json`, rename `.mcp.json` to `mcp.json` (spec
> `$schema` + a declared `type` per server), and move `context/` and `tasks/`
> under `ai.nanoco.nanoclaw/`.

## Using a template

**Via the CLI:**

```bash
ncl groups create --template sales/sdr --name "SDR Agent"
```

This stamps the group but does **not** wire it to a channel. Run
`/manage-channels` (or `ncl wirings create`) afterward, exactly as for a
hand-built group.

If the reader skipped or ignored anything (a non-conforming skill, an
unsupported MCP transport, an unknown manifest field), the create response
carries a `templateReport` listing each item by name — components are never
silently stripped.

### The template ref

`--template <ref>` is a path **relative to the local templates directory**
(`templates/` by default, or `NANOCLAW_TEMPLATES_DIR`). Refs are multi-segment,
e.g. `sales/sdr` → `templates/sales/sdr`. The plugin root is the leaf folder;
its manifest `name` is just `sdr`.

For safety the ref must stay inside the templates directory: absolute paths, a
leading `~`, and `../` escapes are rejected. There is no `--source`, no git URL,
and no remote fetch at `ncl` time. Populate `templates/` first (by hand, e.g.
copying from the public registry), then stamp.

`NANOCLAW_TEMPLATES_DIR` may point the library at another **local** directory; it
is never a URL and never changes at runtime.

## What's in a template

The full authoring reference lives in the
[templates repo README](https://github.com/nanocoai/nanoclaw-templates#anatomy-of-a-template).
The short version: only `plugin.json` is required; everything else is optional
and defaults sensibly:

```
<template>/
├── plugin.json                  # REQUIRED: Agent Plugins manifest ($schema + name; the discovery marker)
├── mcp.json                     # optional: stdio or streamable-http MCP servers, NO secrets
├── skills/<name>/               # optional: one folder per skill (SKILL.md + any references/), copied whole
├── ai.nanoco.nanoclaw/          # optional: the NanoClaw extension dir (spec §8.2)
│   ├── context/
│   │   ├── instructions.md      # the agent's standing persona
│   │   └── additional_context/  # extra .md files, referenced from instructions.md by relative path
│   │       └── *.md
│   └── tasks/*.md               # recurring tasks, created paused
└── README.md                    # recommended: per-template docs
```

| Path                                                  | Loaded as                                                                                                    | Required |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------- |
| `plugin.json`                                          | Plugin identity: exact 1.0.0 `$schema`, spec-valid `name`, optional metadata and `extensions`               | **Yes**  |
| `skills/<name>/`                                       | A skill, auto-triggered by its `description` (SKILL.md frontmatter needs `name` + `description`)            | No       |
| `mcp.json` → `mcpServers`                              | MCP tool servers (validated, then written to container config)                                               | No       |
| `ai.nanoco.nanoclaw/context/instructions.md`           | The agent's persona, prepended to its `CLAUDE.md`/`AGENTS.md` every spawn (system-prompt tier, any provider) | No       |
| `ai.nanoco.nanoclaw/context/**/*.md` (others)          | Extra context, copied into the agent's workspace with the same layout relative to `instructions.md`          | No       |
| `ai.nanoco.nanoclaw/tasks/*.md`                        | Recurring scheduled tasks, created paused pending user activation                                            | No       |
| `extensions["ai.nanoco.nanoclaw"].agentName` (manifest) | Display name for the stamped group; defaults to the template folder leaf                                    | No       |

Failure boundaries follow the spec: an invalid `plugin.json` (or a containment
or size violation, below) rejects the whole template; a malformed `mcp.json`
invalidates only the MCP component; one bad skill or server entry skips only
that skill or server, always with a named report line.

Notes:

- **No provider, model, effort, or packages in a template.** Those are set on
  the agent later via `ncl groups config update`. The runtime defaults to the
  install's configured provider.
- **The persona is optional to the loader** but the first-party registry
  requires one by policy (its CI enforces it). Keep `instructions.md` focused
  (under ~200 lines): it's always in the agent's prompt, and some providers
  cap that doc (Codex ~32 KB), so an over-long persona gets truncated. Put
  bulk material in `skills/` or extra context files instead.
- Skills are copied into the agent's own skills overlay, keyed to that group,
  never shared across groups.

## The stamped plugin at runtime

Stamping copies the **whole plugin** to `groups/<folder>/plugins/<name>/`,
which is mounted **read-only** in the container at
`/workspace/agent/plugins/<name>` — plugin content is immutable at runtime,
per the spec. A writable sibling, `plugin-data/<name>`, is provisioned for
per-plugin state.

stdio MCP servers declared by a plugin run against that contract:

- `PLUGIN_ROOT` and `PLUGIN_DATA` are injected into the server's environment.
- `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` expand (once, non-recursively) in `args`
  elements and `env` values.
- A `./`-relative `command` resolves against the plugin root, so a
  plugin-shipped server binary runs from the read-only copy inside the
  container — never on the host.

Because the whole plugin is present, a skill can reference sibling plugin
files (say, a `TROUBLESHOOTING.md` at the plugin root) and they exist in the
container. Re-stamping replaces the plugin directory, so updates are
idempotent.

## Security posture

Plugin content is **data on the host and code only in the container**. The
host process copies and validates plugin files but never executes anything
inside them; stdio servers, skill scripts, and task script gates all run in
the agent container. At stamp time NanoClaw enforces:

- **No symlinks, no special files.** The whole tree is walked with `lstat`;
  any symlink rejects the template outright (stricter than the spec, which a
  client is allowed to be).
- **Containment.** Every path must resolve inside the plugin root.
- **Size caps.** At most 2,000 files, 50 MB total, 16 levels deep.
- **Secret lint.** `env` and `headers` values matching known credential
  formats (`sk-`, `ghp_`, `xox…-`, `AKIA…`, PEM headers) reject the template;
  the literal `"placeholder"` always passes; a credential-shaped key with an
  unrecognized value warns but does not block.
- **Defense in depth.** Stored MCP config is re-validated when the container
  config is materialized; invalid entries are dropped and logged.

### Recurring tasks

Each immediate Markdown file under `ai.nanoco.nanoclaw/tasks/` defines one
recurring task. The filename becomes its readable name, the frontmatter
supplies its cron schedule, an optional script can decide whether to wake the
agent, and the Markdown body is the prompt:

```markdown
---
schedule: '*/15 * * * *'
script: |
  if [ -f /workspace/agent/wake-next-task ]; then
    echo '{"wakeAgent": true}'
  else
    echo '{"wakeAgent": false}'
  fi
---

Investigate the alerts reported by the script and notify me if they are serious.
```

`schedule` is required. `script` is optional and may be a single-line or
multiline YAML string. The frontmatter accepts no other fields, so typos cannot
silently change behavior. Task files are reader input: they are copied with the
plugin into `plugins/<name>/` but do not become live files in the agent
workspace root.

Template tasks use the same creation path as `ncl tasks create`, including cron
validation, the group timezone, first-run calculation, isolated task sessions,
the run-log prompt, script behavior, and frequency limits. Ungated tasks are
limited to four fires in the next 24 hours; tasks with a script gate may run more
often. Templates do not expose the dangerous frequency override or one-time
tasks.

The script is passed unchanged to NanoClaw's normal task creation and execution
path. See [Scheduled Tasks](scheduled-tasks.md#script-gates) for the script
contract, testing workflow, frequency limit, and failure behavior. Avoid putting
secrets directly in scripts; prefer runtime credential injection through OneCLI.

Tasks start **paused**, so stamping a template never starts background work
without user consent. Until the setup welcome flow offers activation, inspect
and enable them with the existing task CLI:

```bash
ncl tasks list --group <agent-group-id> --status paused
ncl tasks resume <task-id>
```

Resuming preserves NanoClaw's normal pause/resume semantics: if the stored next
run passed while paused, the task is eligible immediately.

### Referencing extra context files

Extra `.md` files under `ai.nanoco.nanoclaw/context/` (by convention in an
`additional_context/` subfolder) are copied into the agent's workspace
preserving their position relative to `instructions.md` — a template file at
`ai.nanoco.nanoclaw/context/additional_context/pricing.md` is readable by the
agent as `additional_context/pricing.md`, the same relative path you'd use
from `instructions.md` itself. Nothing is injected automatically: the agent
only reads an extra file if `instructions.md` points to it, so reference every
file you ship.

```markdown
Pricing rules live in `additional_context/pricing.md`. Read it before quoting a price.
```

Context files are copied when you stamp, so files added to the template later
won't reach an already-created agent. Re-stamp the same name to update it.

## MCP servers and credentials

**Templates declare MCP servers, not secrets.** `mcp.json` has exactly two
top-level fields — the spec `$schema` and `mcpServers` — and every server
declares its transport: `"stdio"` (`command` + `args` + optional `env` ) or
`"streamable-http"` (an HTTPS `url` + optional `headers`). The legacy `sse`
transport is not supported (such servers are skipped with a notice, as the
spec permits).

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "hubspot": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@hubspot/mcp-server"]
    },
    "microsoft-learn": {
      "type": "streamable-http",
      "url": "https://learn.microsoft.com/api/mcp"
    }
  }
}
```

Remote URLs must not carry secrets: userinfo, fragments, and
credential-looking query parameters (`?api_key=…`, `?token=…`) are rejected;
authentication belongs in the credentials proxy. Non-secret query parameters
(e.g. Datadog's `?toolsets=apm`) are fine. Hostnames that reach the
container's host machine are rejected, and plain HTTP is allowed only for
`localhost`. A stdio `command` is a single token: a bare executable name or
a `./`-relative path resolved against the plugin root. An explicit `cwd` is
validated against the spec's fixed forms but currently skipped with a notice
(the provider runtime does not support it).

Credentials are held by the **credentials proxy** and injected into outbound
HTTPS calls at the proxy boundary, matched by API host, at request time. The key
never sits in `mcp.json`, the container env, or chat context. See
[the credentials proxy section in CLAUDE.md](../CLAUDE.md#secrets--credentials--onecli)
for the model.

Two ways a credential gets connected:

1. **Up front.** Register the secret with the credentials proxy (its web UI or
   CLI), matched to the service's API host (e.g. `api.example.com`). Matching
   credentials are injected automatically, so usually nothing else is needed.
2. **On demand (the common path).** Don't set anything up first. The first time
   the agent calls a service with no credential, the API returns **401/403** and
   the agent replies with a prefilled connect link for that host. The user opens
   it, pastes the key, and asks the agent to retry. The key lands in the
   credentials proxy, which injects it on every later call.

### MCP servers that require an env var to boot

Some MCP servers refuse to start unless an env var is _present_, even though the
real credential should come from the credentials proxy, not the env. Because
`mcp.json`'s `env` block passes through verbatim to the agent's container
config, put the literal **`"placeholder"`** there to satisfy the boot check:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "acme": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@acme/mcp-server"],
      "env": { "ACME_API_KEY": "placeholder" }
    }
  }
}
```

The server starts; its real outbound calls are still authenticated by the
credentials proxy. **Never put a real key in `env` or `headers`**: stamping
rejects values that match known credential formats, and `"placeholder"` is the
one value the lint always accepts. The same convention covers `headers` on
remote servers — stamp with a placeholder, then have the operator set the real
value with `ncl groups config add-mcp-server --headers` if the endpoint truly
needs a static header.

### Approval-gating sensitive actions

The credentials proxy can _hold_ a credentialed outbound request and require a
human to approve it before it leaves the proxy: enforcement the agent can't talk
around. This is matched on the outbound HTTP request (host + method + path),
configured on the credentials proxy, and answered by NanoClaw (it DMs an approver). The host side is
already wired; see
[the credentialed-approval flow in CLAUDE.md](../CLAUDE.md#requiring-approval-for-credential-use)
and the [`sales/sdr` template README](https://github.com/nanocoai/nanoclaw-templates/blob/main/sales/sdr/README.md)
for a worked example.

## Contributing a template

Templates ship in the separate
[`nanocoai/nanoclaw-templates`](https://github.com/nanocoai/nanoclaw-templates)
repo, not this one. To add one: fork that repo, drop a plugin directory at
`<category>/<template>/` with at least `plugin.json` and (registry policy) a
persona at `ai.nanoco.nanoclaw/context/instructions.md`, run that repo's
`node scripts/check-templates.mjs`, test it end to end (copy it under
`templates/` and run
`ncl groups create --template <category>/<template> --name Test`), confirm
any predefined tasks appear under `ncl tasks list --status paused`, confirm no
secrets are committed, and open a PR. The repo's README has the full anatomy,
category conventions, and checklist.
