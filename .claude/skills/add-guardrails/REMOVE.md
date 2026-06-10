# Removing add-guardrails

Reverse of apply: remove the marked edits first (they import the module
files), then delete the files. Safe to re-run if some pieces are already gone.

## 1. Remove the marked edits by hand

- `src/router.ts` — the guardrails block in `deliverToAgent()` (the
  `// Guardrails (optional…)` comment, the
  `await import('./modules/guardrails/index.js')` line, and the
  `if (applyInboundGuardrails(...)) { return; }` statement).
- `src/delivery.ts` — the host output-checkpoint block in `deliverMessage()`
  (the `// Host-side output guardrails…` comment, the
  `await import('./modules/guardrails/delivery-check.js')` line, and the
  `if (guard.action === 'block') { … return; }` statement).
- `container/agent-runner/src/poll-loop.ts` — the three marker blocks:
  `MODULE-HOOK:guardrails-input`, `MODULE-HOOK:guardrails-input-followup`,
  and `MODULE-HOOK:guardrails-output`. If the scheduling pre-task blocks are
  populated, point their calls back at the raw batch:
  `applyPreTaskScripts(normalMessages)` (initial) and
  `applyPreTaskScripts(newMessages)` (follow-up) instead of
  `applyPreTaskScripts(keep)`.
- `container/agent-runner/src/mcp-tools/core.ts` — the three marker blocks:
  `MODULE-HOOK:guardrails-output-mcp` (send_message),
  `MODULE-HOOK:guardrails-output-mcp-file` (send_file), and
  `MODULE-HOOK:guardrails-output-mcp-edit` (edit_message); plus the
  `// No guardrails hook here…` comment in add_reaction.
- `container/agent-runner/src/mcp-tools/interactive.ts` — the two marker
  blocks: `MODULE-HOOK:guardrails-output-mcp-question` (ask_user_question)
  and `MODULE-HOOK:guardrails-output-mcp-card` (send_card).
- `src/container-runner.ts` — the `guardrails/` nested-RO mount block in
  `buildMounts()`.
- `src/index.ts` — the quarantine-sink block in `main()` (the dynamic import
  of `./modules/guardrails/quarantine.js` and the
  `registerGuardrailsDeliveryAction()` call).

## 2. Delete the module files and tests

```bash
rm -rf src/modules/guardrails container/agent-runner/src/guardrails
rm -f src/guardrails-wiring.test.ts
```

## 3. Optional cleanup

Per-group configs and the quarantine audit trail are left in place; delete
them only if you're sure you no longer need the audit history:

```bash
rm -rf groups/<folder>/guardrails    # per group
rm -rf data/guardrails               # quarantine logs
```

## 4. Rebuild and restart

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
# systemctl --user restart $(systemd_unit)             # Linux
```
