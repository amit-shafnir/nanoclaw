# Removing add-guardrails

Reverse of apply: remove the two barrel-import lines, then delete the module
directories. No core files were edited by the install, so there is nothing
else to revert. Safe to re-run if some pieces are already gone.

## 1. Remove the barrel lines

- `src/modules/index.ts` — delete the `import './guardrails/index.js';` line.
- `container/agent-runner/src/modules.ts` — delete the
  `import './guardrails/register.js';` line.

## 2. Delete the module directories

```bash
rm -rf src/modules/guardrails container/agent-runner/src/guardrails
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
