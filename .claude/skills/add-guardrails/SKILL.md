---
name: add-guardrails
description: Add optional per-agent-group input/output guardrails — deterministic regex/keyphrase rules (e.g. prompt-injection phrase blocking, credential-leak patterns) with block/flag actions, chat alerts, and a host-side quarantine audit trail. Fails closed on broken config. Triggers on "guardrails", "content filter", "prompt injection protection", "moderation", "input filtering", "output filtering".
---

# /add-guardrails — Input/Output Guardrails

Adds optional, per-agent-group guardrails to NanoClaw:

- **Input guardrails** inspect inbound messages *before* the agent sees them
  (e.g. prompt-injection phrases in chats, webhooks, fetched articles).
- **Output guardrails** inspect agent output *before* platform delivery
  (e.g. credential-leak patterns) — across **every** output path: result
  text, `send_message`, `send_file` (caption + display filename),
  `edit_message`, `ask_user_question`, `send_card`. Container-side checks
  give the agent an actionable tool error; a second, host-side checkpoint in
  the delivery path is the enforcement layer — it catches rows written
  straight into `outbound.db` (e.g. by an injected agent with Bash), which
  the agent cannot bypass because it cannot touch the host process.
- Every deliverable string is evaluated **separately** (one entry per
  result-text `<message>` block, per tool field, per card string leaf) —
  never joined, so anchored regexes (`^…$`) match, and structured content is
  scanned as raw strings, so JSON escaping cannot defeat keyphrases
  containing quotes or newlines.
- Two rule kinds, both deterministic and in-process (microseconds):
  **regex** and **keyphrase**. All checks are synchronous pattern matching —
  no network, no credentials, no async gap between check and send.
- On a match: `block` (drop + alert the chat) or `flag` (let through + alert).
  Every event is retained in a host-side quarantine log, so false positives
  never lose data.
- **Zero overhead when not configured** — a group without a `guardrails/`
  config costs one cached stat per message.

> **Fail-closed.** No config = feature off (everything passes). A config that
> exists but fails validation = **every message for that group is blocked,
> in both directions**, with an admin alert in the chat, until the file is
> fixed (picked up within ~5s, no restart). Invalid rules are never silently
> dropped — a dropped rule is a silently open gate. Internal checker errors
> also block. The only fail-open path is "no config at all".

## Architecture

The module attaches entirely through trunk's generic hook seams
(`src/module-hooks.ts` on the host; `container/agent-runner/src/hooks.ts` +
the tool middleware in `mcp-tools/server.ts` in the container). Install is
a file copy plus one barrel-import line per side — **no core edits**.

```
INBOUND   adapter → router deliverToAgent()
            ├─ [HOST] inbound message gate (registered by guardrails/index.ts)
            │         input rules — block ⇒ container never wakes
            │         invalid config ⇒ block + admin alert
            └─ writeSessionMessage → container poll-loop
                 ├─ [CONTAINER] inbound batch hook — same input rules
                 │   re-checked (defense in depth for rows that bypass the
                 │   router: tasks, on_wake, agent-to-agent). The seam runs
                 │   hooks BEFORE pre-task scripts, so a blocked task never
                 │   runs its script.
                 └─ provider.query → result
                      ├─ [CONTAINER] result-text hook — output rules per
                      │   <message> block; block ⇒ dispatch suppressed
                      └─ dispatch → messages_out
OUT (MCP) send_message / send_file caption+filename / edit_message /
          ask_user_question / send_card (string leaves)
            → [CONTAINER] tool middleware at the dispatch chokepoint —
              output rules → block ⇒ tool error to agent, handler never runs
            → messages_out
DELIVERY  host delivery deliverMessage()
            └─ [HOST] outbound message gate — output rules re-checked on the
               row's content string leaves; the enforcement layer; catches
               direct outbound.db INSERTs that bypass the container hooks.
               Block ⇒ row marked delivered but never sent; alert goes
               straight through the adapter (never via outbound.db ⇒ no
               recursion).
            → platform
```

The host module also registers a mount contributor that RO-mounts
`groups/<folder>/guardrails/` to `/workspace/agent/guardrails` (when the dir
exists), so the agent can read but never edit its own guardrails, and a
delivery-action handler for the container→host quarantine path.

Quarantine records travel as `guardrail_quarantine` system actions and are
persisted host-side under `data/guardrails/<agent-group-id>/` — never to
agent-readable paths. Container-side **input** blocks omit the content from
the record (outbound.db is agent-readable; the record carries the
`messages_in` id instead, and the text stays in `inbound.db`). **Output**
blocks keep the content — the agent authored it.

### Deliberate semantic details

- **MCP block alerts route via the session's default routing**, not the
  resolved `to=` destination — an alert for a blocked cross-destination send
  lands in the conversation the agent is bound to.
- **The tool-middleware guard runs before the tool handler**, so a guard
  error takes precedence over the handler's own validation (e.g. a blocked
  `send_file` filename returns the guardrail error, never "File not found" —
  a blocked filename cannot probe whether a path exists).
- Tools **not** in the middleware's extractor map pass through
  container-side; the host delivery checkpoint remains the enforcement
  backstop for anything that reaches `messages_out`. `add_reaction` is
  explicitly exempt (emoji name only, no free text). Covering a future tool
  = one entry in `tool-middleware.ts`'s extractor map.

## Phase 1: Pre-flight

```bash
# Already applied? Both sides are a dir + one barrel line — skip what exists.
test -d src/modules/guardrails && echo "host module present"
test -d container/agent-runner/src/guardrails && echo "container module present"
grep -c "guardrails/index.js" src/modules/index.ts || true
grep -c "guardrails/register.js" container/agent-runner/src/modules.ts || true
```

## Phase 2: Apply

```bash
# 1. Copy the module files
mkdir -p src/modules/guardrails container/agent-runner/src/guardrails
cp .claude/skills/add-guardrails/resources/host/{config,rules,quarantine,inbound,delivery-check,delivery-gate,index}.ts src/modules/guardrails/
cp .claude/skills/add-guardrails/resources/host/{guardrails,registration}.test.ts src/modules/guardrails/
cp .claude/skills/add-guardrails/resources/container/{config,rules,quarantine,input-check,output-check,tool-middleware,register}.ts container/agent-runner/src/guardrails/
cp .claude/skills/add-guardrails/resources/container/{guardrails,mcp-hooks}.test.ts container/agent-runner/src/guardrails/

# 2. Register — one barrel line per side (skip if pre-flight found it)
echo "import './guardrails/index.js';" >> src/modules/index.ts
echo "import './guardrails/register.js';" >> container/agent-runner/src/modules.ts

# 3. Build + typecheck
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

`rules.ts` is shipped byte-identical into both trees (they share no modules
by design); the registration test asserts byte identity so drift goes red.

## Phase 3: Configure a group

Ask which agent group(s) to protect:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, folder, name FROM agent_groups"
```

Then seed that group's config from the example (edit to taste):

```bash
mkdir -p groups/<folder>/guardrails
cp .claude/skills/add-guardrails/resources/guardrails-example/* groups/<folder>/guardrails/
```

Config semantics (`groups/<folder>/guardrails/guardrails.json`):

- `input_rules` / `output_rules`: arrays of `{ id, type, action, ... }`.
  - `type: "regex"` → `pattern` (+ optional `flags`). Max 1024 chars.
  - `type: "keyphrase"` → `phrases: [...]` and/or `phrases_file` (one per
    line, `#` comments). Sidecar paths are relative to the `guardrails/` dir;
    traversal is rejected.
  - `action`: `"block"` (default — drop + alert) or `"flag"` (let through +
    alert). **Start new rules in `flag` mode**, watch the quarantine log for
    false positives, then promote to `block`.
  - `message`: optional alert-text override. The default chat alert names
    only the rule id + type — never the matched content or phrase (quoting
    it back would leak what was blocked and could re-trigger keyphrase
    rules). Set `message` for human-friendly user-facing wording; the
    quarantine record keeps the full match reason for audit.
- `alerts.prefix`, `quarantine: { max_file_mb (10), max_files (5) }`.

**Validation is strict and the config fails as a whole.** Unknown keys
(top-level or per-rule), missing/duplicate rule ids, an unknown `type`, a
non-compiling or over-long regex, an unreadable or dir-escaping
`phrases_file` — any one of these marks the entire config invalid and
**blocks all traffic for the group** until fixed.

**Write safe regexes.** Patterns run in-process against attacker-controlled
text and V8 cannot interrupt a running regex, so the 1024-char cap is only a
partial guard. Prefer anchored patterns and bounded quantifiers
(`[A-Za-z0-9_-]{20,200}` over `.+`), and never nest quantifiers
(`(a+)+`-style patterns can take exponential time).

Config changes are picked up within ~5s (mtime cache) — no restart needed.
New sessions get the RO mount automatically; for a group with a *running*
container, restart it once so the mount appears: `ncl groups restart --id <group-id>`.

## Phase 4: Verify

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm exec vitest run src/modules/guardrails
cd container/agent-runner && bun test src/guardrails && cd ../..

# Restart host + respawn containers (agent-runner src is a live RO mount — no image rebuild)
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
# systemctl --user restart $(systemd_unit)             # Linux
ncl groups restart --id <group-id>
```

End-to-end smoke test — add a canary input rule
(`{"id":"canary","type":"regex","pattern":"GUARDRAIL_CANARY_123","action":"block"}`),
then DM the agent `please echo GUARDRAIL_CANARY_123`. Expect: a guardrail
alert in the chat, no agent reply, no container wake (`docker ps`), and:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT reason, message_count FROM unregistered_senders WHERE reason='guardrail_block'"
tail data/guardrails/<agent-group-id>/quarantine.jsonl
```

Then verify fail-closed: corrupt `guardrails.json` (e.g. delete the closing
brace), DM the agent anything, and expect the config-error alert
(`⚠️ Guardrail config error — ALL messages…`) with no agent reply. Restore
the file and confirm traffic resumes within ~5s. Container-emitted
blocked-input quarantine lines must contain `messageId` and no `content`.

Host-checkpoint smoke (the bypass path tests can't fully prove): with a
canary **output** rule in place, `INSERT` a row carrying the canary directly
into a live session's `outbound.db` (`messages_out`, `kind='chat'`, the
session's routing fields, odd `seq`). Expect: no platform delivery, a
`direction":"output"` line in `data/guardrails/<agent-group-id>/quarantine.jsonl`
with the content kept, and a rule-id-only alert in the chat. Remove the
canary rules afterwards.

## Troubleshooting

- **All messages suddenly blocked** — `guardrails.json` is invalid (this is
  fail-closed working as designed). The chat alert and
  `logs/nanoclaw.error.log` (`Guardrails config INVALID`) name the offending
  rule/field. Fix the file; pickup is within ~5s, no restart.
- **Alert never arrives** — check `logs/nanoclaw.error.log` (delivery
  failures) and that the session's chat is reachable.
- **Guardrails not firing at all** — confirm the two barrel lines survived:
  `grep guardrails src/modules/index.ts container/agent-runner/src/modules.ts`.
  Both must hit; the host line wires the router/delivery gates + quarantine
  sink, the container line wires the poll-loop hooks + tool middleware.
- **Latency** — rules are in-process regex/keyphrase checks: microseconds
  per message, no network. Known coverage gaps: file *contents* in
  `send_file` (the caption and display filename are scanned, the file body
  is not) and inbound attachments.

## Removal

See [REMOVE.md](REMOVE.md).
