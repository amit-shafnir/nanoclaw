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

```
INBOUND   adapter → router deliverToAgent()
            ├─ [HOST] input rules — block ⇒ container never wakes
            │         invalid config ⇒ block + admin alert
            └─ writeSessionMessage → container poll-loop
                 ├─ [CONTAINER] same input rules re-checked (defense in depth
                 │   for rows that bypass the router: tasks, on_wake,
                 │   agent-to-agent) — BEFORE pre-task scripts, so a blocked
                 │   task never runs its script
                 └─ provider.query → result
                      ├─ [CONTAINER] output rules, per <message> block
                      └─ dispatch → messages_out
OUT (MCP) send_message / send_file caption+filename / edit_message /
          ask_user_question / send_card (string leaves)
            → [CONTAINER] output rules → block ⇒ tool error to agent
            → messages_out
DELIVERY  host delivery deliverMessage()
            └─ [HOST] output rules re-checked on the row's content string
               leaves — the enforcement layer; catches direct outbound.db
               INSERTs that bypass the container hooks. Block ⇒ row marked
               delivered but never sent; alert goes straight through the
               adapter (never via outbound.db ⇒ no recursion).
            → platform
```

Quarantine records travel as `guardrail_quarantine` system actions and are
persisted host-side under `data/guardrails/<agent-group-id>/` — never to
agent-readable paths. Container-side **input** blocks omit the content from
the record (outbound.db is agent-readable; the record carries the
`messages_in` id instead, and the text stays in `inbound.db`). **Output**
blocks keep the content — the agent authored it.

## Phase 1: Pre-flight

```bash
# Already applied? Each edit is marker-guarded — skip any step whose marker exists.
grep -c "MODULE-HOOK:guardrails-input" container/agent-runner/src/poll-loop.ts || true
grep -c "guardrails/index.js" src/router.ts || true
test -d src/modules/guardrails && echo "host module present"
test -d container/agent-runner/src/guardrails && echo "container module present"
```

## Phase 2: Apply

### 2a. Copy the module files (before the edits — the hooks import them)

```bash
mkdir -p src/modules/guardrails container/agent-runner/src/guardrails
cp .claude/skills/add-guardrails/resources/host/{config,rules,quarantine,index,delivery-check}.ts src/modules/guardrails/
cp .claude/skills/add-guardrails/resources/host/guardrails.test.ts src/modules/guardrails/
cp .claude/skills/add-guardrails/resources/host/guardrails-wiring.test.ts src/
cp .claude/skills/add-guardrails/resources/container/{config,rules,quarantine,input-check,output-check}.ts container/agent-runner/src/guardrails/
cp .claude/skills/add-guardrails/resources/container/{guardrails,mcp-hooks}.test.ts container/agent-runner/src/guardrails/
```

`rules.ts` is shipped byte-identical into both trees (they share no modules
by design); the wiring test asserts byte identity so drift goes red.

### 2b. Edit `src/router.ts` — host input gate

In `deliverToAgent()`, after the command-gate `if` block and before the
`writeSessionMessage(...)` call, insert (colocated dynamic import, flat
statements — the wiring test asserts this placement):

```typescript
  // Guardrails (optional; no-ops without groups/<folder>/guardrails/).
  // Fail-closed: a configured-but-broken guardrails.json blocks EVERY
  // message for the group until fixed. Blocking here means the container
  // never wakes; the container re-checks rows that bypass this router
  // (scheduled tasks, on_wake, agent-to-agent) via the MODULE-HOOKs in
  // poll-loop.ts. See /add-guardrails.
  const { applyInboundGuardrails } = await import('./modules/guardrails/index.js');
  if (
    applyInboundGuardrails({
      folder: agentGroup.folder,
      agentGroupId: agent.agent_group_id,
      sessionId: session.id,
      deliveryAddr,
      event,
      userId,
      messagingGroupId: mg.id,
    })
  ) {
    return;
  }
```

### 2c. Edit `container/agent-runner/src/poll-loop.ts` — container input hooks

Guardrails run **before** the pre-task script hooks: pre-task scripts are
arbitrary code, and a blocked task must never get to run one. The wiring
test asserts this order.

In the initial batch, directly after the `let keep` / `let skipped`
declarations and **before** the `// MODULE-HOOK:scheduling-pre-task:start`
marker, insert:

```typescript
    // MODULE-HOOK:guardrails-input:start
    {
      const { applyInputGuardrails } = await import('./guardrails/input-check.js');
      const guarded = applyInputGuardrails(keep, routing);
      if (guarded.blockedIds.length > 0) {
        markCompleted(guarded.blockedIds);
        log(`Guardrails blocked ${guarded.blockedIds.length} inbound message(s)`);
      }
      keep = guarded.keep;
    }
    // MODULE-HOOK:guardrails-input:end
```

If the scheduling pre-task block is populated, change its call to consume
the guarded list — `applyPreTaskScripts(keep)` instead of
`applyPreTaskScripts(normalMessages)` — otherwise the script gate would
operate on the unguarded batch and resurrect blocked messages.

In the follow-up poll, the same: insert the block (markers suffixed
`-followup`, log saying `follow-up message(s)`) after its `let keep` /
`let skipped` declarations and before
`// MODULE-HOOK:scheduling-pre-task-followup:start`, and point the follow-up
`applyPreTaskScripts` call at `keep` instead of `newMessages`.

### 2d. Edit `poll-loop.ts` — container output hook

In `processQuery`'s `result` branch, at the top of the existing
`if (event.text)` body:

```typescript
        if (event.text) {
          // MODULE-HOOK:guardrails-output:start
          const { applyOutputGuardrails } = await import('./guardrails/output-check.js');
          const guardedResult = applyOutputGuardrails(event.text, routing);
          if (guardedResult.text === null) {
            continue; // blocked — the guardrail already alerted + quarantined
          }
          // MODULE-HOOK:guardrails-output:end
          ... existing dispatchResultText(event.text, routing) + nudge block unchanged ...
        }
```

### 2e. Edit `container/agent-runner/src/mcp-tools/core.ts` — MCP send hooks

In the `send_message` handler, after `resolveRouting(...)` succeeds and before
`writeMessageOut(...)`:

```typescript
    // MODULE-HOOK:guardrails-output-mcp:start
    const { checkOutputTexts } = await import('../guardrails/output-check.js');
    const guard = checkOutputTexts([text], {
      channel_type: routing.channel_type,
      platform_id: routing.platform_id,
      thread_id: routing.thread_id,
    });
    if (guard.blocked) return err(guard.message ?? 'Message blocked by output guardrail.');
    // MODULE-HOOK:guardrails-output-mcp:end
```

In the `send_file` handler, after the routing error check and before the
path-resolution/outbox copy (the filename is checked *before* the
file-exists check, so a blocked filename never leaks whether a path exists):

```typescript
    // MODULE-HOOK:guardrails-output-mcp-file:start
    // Caption and display filename are both delivered (shown in chat), so
    // both are scanned — file CONTENTS are a documented coverage gap. On a
    // filename block the agent can rename and retry. Runs even with an empty
    // caption so an invalid config still blocks.
    const { checkOutputTexts } = await import('../guardrails/output-check.js');
    const guard = checkOutputTexts(
      [(args.text as string) || '', (args.filename as string) || path.basename(filePath)],
      {
        channel_type: routing.channel_type,
        platform_id: routing.platform_id,
        thread_id: routing.thread_id,
      },
    );
    if (guard.blocked) return err(guard.message ?? 'Message blocked by output guardrail.');
    // MODULE-HOOK:guardrails-output-mcp-file:end
```

In the `edit_message` handler, after the `getRoutingBySeq` validation and
before `writeMessageOut(...)`:

```typescript
    // MODULE-HOOK:guardrails-output-mcp-edit:start
    // Without this, an agent could send clean text then smuggle blocked
    // content into the delivered message via an edit.
    const { checkOutputTexts } = await import('../guardrails/output-check.js');
    const guard = checkOutputTexts([text], {
      channel_type: routing.channel_type,
      platform_id: routing.platform_id,
      thread_id: routing.thread_id,
    });
    if (guard.blocked) return err(guard.message ?? 'Message blocked by output guardrail.');
    // MODULE-HOOK:guardrails-output-mcp-edit:end
```

In the `add_reaction` handler, add the first-line comment so the omission
reads as deliberate:

```typescript
    // No guardrails hook here: add_reaction carries only an emoji name, no free text.
```

### 2f. Edit `container/agent-runner/src/mcp-tools/interactive.ts` — question/card hooks

In the `ask_user_question` handler, after `const r = routing();` and before
the `writeMessageOut(...)` that posts the question card:

```typescript
    // MODULE-HOOK:guardrails-output-mcp-question:start
    // Each delivered field is checked as its own string — joining them would
    // break anchored regexes and could split keyphrases across fields.
    const { checkOutputTexts } = await import('../guardrails/output-check.js');
    const guard = checkOutputTexts(
      [title, question, ...options.flatMap((o) => [o.label, o.selectedLabel, o.value])],
      { channel_type: r.channel_type, platform_id: r.platform_id, thread_id: r.thread_id },
    );
    if (guard.blocked) return err(guard.message ?? 'Message blocked by output guardrail.');
    // MODULE-HOOK:guardrails-output-mcp-question:end
```

In the `send_card` handler, after `const r = routing();` and before
`writeMessageOut(...)`:

```typescript
    // MODULE-HOOK:guardrails-output-mcp-card:start
    // The card's string leaves are scanned raw — scanning JSON.stringify(card)
    // would let JSON escaping defeat keyphrases containing quotes or newlines.
    const { checkOutputTexts } = await import('../guardrails/output-check.js');
    const { collectStringLeaves } = await import('../guardrails/rules.js');
    const guard = checkOutputTexts([...collectStringLeaves(card), (args.fallbackText as string) || ''], {
      channel_type: r.channel_type,
      platform_id: r.platform_id,
      thread_id: r.thread_id,
    });
    if (guard.blocked) return err(guard.message ?? 'Message blocked by output guardrail.');
    // MODULE-HOOK:guardrails-output-mcp-card:end
```

### 2g. Edit `src/container-runner.ts` — RO-mount the guardrails dir

In `buildMounts()`, directly after the `container.json` nested-RO mount:

```typescript
  // guardrails/ — nested RO mount on top of the RW group dir so the agent
  // cannot edit or delete its own guardrails. See /add-guardrails.
  const guardrailsDir = path.join(groupDir, 'guardrails');
  if (fs.existsSync(guardrailsDir)) {
    mounts.push({ hostPath: guardrailsDir, containerPath: '/workspace/agent/guardrails', readonly: true });
  }
```

### 2h. Edit `src/index.ts` — quarantine sink registration

In `main()`, just before `log.info('NanoClaw running')`:

```typescript
  // Guardrails quarantine sink (optional; no-ops until a container emits a
  // 'guardrail_quarantine' system action). See /add-guardrails.
  const { registerGuardrailsDeliveryAction } = await import('./modules/guardrails/quarantine.js');
  registerGuardrailsDeliveryAction();
```

### 2i. Edit `src/delivery.ts` — host output checkpoint

In `deliverMessage()`, directly after the `if (msg.kind === 'system')` branch
and before the `if (msg.channel_type === 'agent')` branch (the wiring test
asserts this placement — system rows carry quarantine records that would
self-match and are never platform-delivered; a2a leaks count as output),
insert (colocated dynamic import, flat statements):

```typescript
  // Host-side output guardrails — the enforcement layer the agent cannot
  // touch (container-side checks are bypassable via direct outbound.db
  // INSERTs). Placed after the system branch (system rows carry quarantine
  // records that would self-match and are never platform-delivered) and
  // before the agent-to-agent branch (a2a leaks count as output). A blocked
  // row resolves normally so the caller marks it delivered — no retry loop;
  // the alert goes straight through the adapter, never via outbound.db, so
  // it can't recurse through this check.
  const { checkOutboundDelivery } = await import('./modules/guardrails/delivery-check.js');
  const guard = checkOutboundDelivery({
    folder: getAgentGroup(session.agent_group_id)?.folder ?? null,
    agentGroupId: session.agent_group_id,
    sessionId: session.id,
    msg,
  });
  if (guard.action === 'block') {
    if (guard.alertText && msg.channel_type && msg.channel_type !== 'agent' && msg.platform_id) {
      try {
        await deliveryAdapter.deliver(
          msg.channel_type,
          msg.platform_id,
          msg.thread_id,
          'chat',
          JSON.stringify({ text: guard.alertText }),
        );
      } catch (err) {
        log.warn('Guardrail block alert delivery failed', { messageId: msg.id, err });
      }
    }
    return;
  }
```

`getAgentGroup` and `log` are already imported by `delivery.ts`. There is
deliberately **no exemption mechanism**: every row field is agent-writable,
so nothing row-based can be trusted to mark a row exempt.

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
pnpm exec vitest run src/modules/guardrails src/guardrails-wiring.test.ts
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
- **No quarantine lines from container blocks** — confirm the
  `registerGuardrailsDeliveryAction()` edit in `src/index.ts` survived
  (`pnpm exec vitest run src/guardrails-wiring.test.ts`).
- **Latency** — rules are in-process regex/keyphrase checks: microseconds
  per message, no network. Known coverage gaps: file *contents* in
  `send_file` (the caption and display filename are scanned, the file body
  is not) and inbound attachments.

## Removal

See [REMOVE.md](REMOVE.md).
