# Phase 1, main side: seams rebuilt on the contract refactor, launch re-stacked

Both branches rebuilt. Nothing pushed. Backups taken first:
`backup/ollama-provider-seams-pre-contract` (1f8f702d) and
`backup/ollama-launch-finish-pre-contract` (eaab8a52).

## Final tips

`feat/ollama-provider-seams` = **c8d2de57**, `git log --oneline upstream/main..HEAD`:

```
c8d2de57 fix(agent-runner): result-door providers count DB-visible sends as delivered
94b05c42 fix(skills): fetch registry branches by explicit refspec
ff1ab8e2 fix(agents): persistent children inherit the creator's provider, model and effort
03289b21 fix(providers): provider-contributed env applies after the OneCLI gateway
d027ef6e feat(providers): container contributions carry the group model and blocked hosts
83f132e2 feat(provider): let a runtime contract carry thinking and the built-in tool set
4ed3caea docs(channels): adapter transports must authenticate the identity they assert
```

`feat/ollama-launch-finish` = **ad54dfcb**, 21 commits over the seams tip (the 20
rebased launch commits plus the new skill commit); `upstream/main..HEAD` is those
21 on top of the 7 above:

```
ad54dfcb feat(skills): install the Ollama provider contract with its payload
a51d4f5c docs(skills): describe unread notices in the local web chat
bfd3e11e feat(ollama): retry launch activation after a failed service step
6ef08823 docs(local-web): say the sidebar's create and delete act with host authority
8a4489ed fix(ollama): relaunch after every agent was deleted from the browser
b1442316 docs(agent-browser): reserve the browser for interactive work
c09818cd docs(ollama): describe the direct web tools, the turn rules, and the per-agent browser conversation
7f359a0b docs(skills): sync the local-web and Ollama install manifests with their payloads
9132fb96 fix(ollama): bootstrap when better-sqlite3 resolves outside the checkout
cf9c2891 feat(ollama): wire the launched agent's own browser conversation before the service starts
e45fc3f1 fix(ollama): rebuild refreshed provider payload
a1b76a74 fix(ollama): reuse only authenticated OneCLI
fc174da9 fix(setup): prevent pnpm self-install recursion
5b28db7e fix(ollama): validate before mutating launch state
fb90dff9 style(ollama): format launch tests
eb5db389 feat(ollama): configure verified browsing during launch
e9d3aa58 docs(ollama): record why the provider disables the two per-call reminders
2bac7ab6 docs(ollama): scope the cloud block and the launch ownership rule
b139d690 feat(skills): setup-ollama-launch, the deterministic 'ollama launch nanoclaw' entrypoint
9f360e02 feat(skills): add-ollama-provider installs from the providers registry
c9f8d91f feat(skills): add-local-web-chat installs the loopback browser channel
(+ the 7 seams commits)
```

## Conflicts resolved

1. `git cherry-pick 85fd3d6e` (docs on `src/channels/adapter.ts`): clean, kept.
2. `68ccf6dd` on `src/container-runner.ts`: conflicted with a 3-way apply. Taken
   from the spike's already-resolved staged diff instead, which adds
   `model: containerConfig.model` to the context object in
   `resolveProviderContribution` and `blockedHosts: contribution.blockedHosts`
   to the agent `ContainerSpec` in `composeSessionSpec`. The other five files of
   that commit applied clean.
3. `5b76990b` on `scripts/test-registry-skills.ts`: conflicted because main has
   restructured that block (an `apply` closure and a `skipEffects` variable).
   Resolved by keeping main's structure and changing only the one stub regex to
   the refspec form.
4. The launch rebase onto the new seams produced **no conflicts at all**. The
   expected clash in `.claude/skills/add-ollama-provider/SKILL.md` and
   `docs/ollama.md` did not happen: `git diff b76fcb3d 75f20168` touches neither
   file, so the launch branch's replacement applied unchanged.

## What changed versus the old seams

- `af8db8d0` and `68502af6` (the ClaudeProvider subclass seams) are **dropped**.
  Main's contract already carries textDelivery, settings ride `inference`, and
  the constructor takes a resolved configuration, so the subclass options they
  added no longer exist. Only their residue survives, as commit 83f132e2:
  exported `ClaudeInference` / `ClaudeExecutionPolicy` replacing the
  `ReturnType<...>` casts, `createPreToolUseHook(disallowedTools)` built from
  the resolved policy instead of the module constant, and `query()` spreading
  `thinking` / `tools` only when defined.
- `022ee214` + `1f8f702d` squashed into ff1ab8e2 as instructed.
- `blockedHosts` landed as the spike recommended, not as the spike coded it: a
  `blockedHosts?: readonly string[]` field on `ProviderHostContract` with a
  bare-hostname shape check at registration, carried by
  `realizeProviderSpawnSurfaces`. The spike's version passed the *legacy
  overlay's* list through instead. **Consequence for the providers branch**: the
  Ollama payload must declare `blockedHosts` on
  `src/provider-contracts/ollama.ts`; `BLOCKED_CLOUD_HOSTS` returned from
  `src/providers/ollama.ts`'s container contribution is now dropped like the
  overlay's mounts once a contract exists. The adapter still needs the constant
  for `NO_PROXY`.

## Test counts (all run, not read)

Seams worktree, at c8d2de57:

| Gate | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ok |
| `pnpm run build` | exit 0 |
| `pnpm exec vitest run` (full) | 193 files pass, 1 skipped, 1 failed; 2380 tests pass, 1 skipped, 7 failed |
| `bun install --frozen-lockfile && bun test` | 437 tests across 53 files: 434 pass, 3 skip, 0 fail |
| `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` | exit 0 |
| `pnpm run lint` | 168 problems, **0 errors**, 168 warnings |
| `pnpm exec prettier --check` on all 20 changed files | clean |

Launch worktree, at ad54dfcb:

| Gate | Result |
|---|---|
| `pnpm run build` | exit 0 |
| `vitest run scripts/ollama-launch.test.ts scripts/ollama-launch-recovery.test.ts scripts/skill-apply.test.ts src/provider-surfaces.test.ts setup/providers` | 6 files, 136 tests pass |
| `pnpm exec vitest run` (full) | 196 files pass, 1 skipped, 1 failed; 2422 tests pass, 1 skipped, 7 failed |
| `bun test` | 434 pass, 3 skip, 0 fail |
| `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` | exit 0 |
| `pnpm run lint` | 0 errors |
| `pnpm exec tsx scripts/skill-apply.ts .claude/skills/add-ollama-provider` | plans 9 steps (1 copy, 5 appends, 3 runs), 0 agent tasks, 0 human inputs |
| `pnpm exec prettier --check` on SKILL.md + REMOVE.md | clean |

The only red is the one named in the brief: `scripts/update/transaction.e2e.test.ts`,
all 7 of its cases, failing at `git tag <name> <sha>` with `fatal: no tag message?`
— a machine git config, not the code. It fails identically on both branches and
touches nothing this work changed.

Per-commit red-before checks, each run by reverting the production file and
re-running:

- 83f132e2: `bun test src/providers/claude.contract-passthrough.test.ts` 4 pass;
  reverting `claude.ts` gives 2 pass / 2 fail (thinking and tools absent from
  the options; WebFetch allowed at the PreToolUse door).
- d027ef6e: `vitest run src/provider-contracts/realize.test.ts` 4 pass; reverting
  the `realize.ts` contribution gives 1 fail (blockedHosts undefined).
- c8d2de57: `bun test src/poll-loop.midturn-resultdoor.test.ts` 23 pass;
  reverting `poll-loop.ts` gives 22 pass / 1 fail (nudge fires after an MCP send
  for a result-door provider). Claude's mid-turn path is unchanged — with
  `suppressDelivery` its `sent` is always 0, so `sent > 0 || turnDelivered` is
  the expression it already evaluated.
- 03289b21 and ff1ab8e2 carry their tests; the composeSessionSpec collision case
  asserted the opposite value before, and `updateContainerConfigScalars` was
  never called before.

## Verified by reading, not running

- That `src/container-runner.ts` on main still let the gateway env win (spike
  claim, confirmed by reading lines 1074-1082 before applying da6c89d8).
- That `create-agent.ts` on main had no model/effort handling before ff1ab8e2.
- That main between b76fcb3d and 75f20168 never touched
  `.claude/skills/add-ollama-provider/` or `docs/ollama.md` (`git diff --stat`,
  empty) — which is why the launch rebase was conflict-free.
- The Ollama payload's own behavior. Nothing on either branch executes it; the
  payload lives on the providers branch and is not in either worktree.

## Not done / open

- The providers-branch payload still has to move `BLOCKED_CLOUD_HOSTS` onto
  `src/provider-contracts/ollama.ts` for the blocked-host declaration to take
  effect. Until it does, an Ollama group spawns without `--add-host` entries.
  The regression test in `realize.test.ts` guards core; nothing on main can
  guard the payload.
- The skill's copy fence lists twelve files that do not exist on the providers
  branch yet in this shape (`src/provider-contracts/ollama.ts`,
  `container/agent-runner/src/provider-contracts/ollama.ts`,
  `container/agent-runner/src/providers/ollama.conformance.test.ts`). An install
  fails until the providers branch carries them.
- `scripts/skill-apply.ts .claude/skills/add-ollama-provider` was run in plan
  mode only; no apply against a real providers remote.
