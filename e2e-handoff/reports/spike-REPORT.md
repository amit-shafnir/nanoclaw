# Spike: Ollama provider on the provider-contract refactor

Worktree: `<worktrees>/spike-ollama-contract` (detached at upstream/main 75f20168, uncommitted, 26 files, left in place). Nothing else was touched (the main clone's only status line is the pre-existing `?? .codex/`).

## Result: feasible, everything green

Verified by running:

| Gate | Result |
|---|---|
| `pnpm run build` | exit 0 |
| `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` | exit 0 |
| `vitest run src/provider-contracts src/providers setup/providers setup/provider-contract.test.ts` | 9 files pass, 1 skipped (legacy-payload-compat); 109 tests pass, 1 skipped |
| `vitest run src/container-runner.test.ts src/drivers` | 6 files, 175 tests pass |
| `bun test src/provider-contracts src/providers src/mcp-tools` | 27 files, 169 pass, 2 skip, 0 fail (Ollama + contracts subset: 53 pass across 7 files) |
| `scripts/provider-contract-verifier.ts --required-declared ollama` | status passed, all 9 checks. `--help` prints the usage line and exits 1 |
| Inventories | host `{"host":["claude","ollama"],"hostProviders":["ollama"],"setupProviders":["claude"]}`, runtime `{"contracts":["claude","ollama"],"providers":["claude","ollama"]}` |

Local bun is 1.3.14; the Dockerfile pins 1.4.0. Direct `bun test` runs used 1.3.14; the verifier uses `pnpm dlx bun@1.4.0` per its code.

## What was built

Container contract `container/agent-runner/src/provider-contracts/ollama.ts` (77 lines): `textDelivery: 'result'`; `executionPolicy` constant = Claude's policy plus WebSearch/WebFetch disallowed and `tools` = TOOL_ALLOWLIST minus both; `inference` wraps `resolveClaudeInference`, routes `model` to `environment.NANOCLAW_OLLAMA_RUNTIME_MODEL`, adds `settings.skipWebFetchPreflight`, and `thinking: disabled` when no effort; `mcpServers` wraps Claude's and filters the two tools from allowedTools; `memory`, `lifecycle`, `history`, `commands` reuse `claudeRuntimeContract`'s objects directly. Host contract `src/provider-contracts/ollama.ts` (25 lines) spreads `CLAUDE_COMPATIBLE_HOST_SURFACES` and declares `legacyHostAdapter: 'required'`. `providers/ollama.ts` (86 lines) still subclasses ClaudeProvider but takes `(options, configuration)`; it keeps only the X-Ollama-Think header and the three instruction appends. Tests adapted to `createProvider`; `ollama.conformance.test.ts` added. SKILL.md got the `metadata.nanoclaw-provider*` keys (`offered: 'false'`, `image: hardened-compatible`) and the two contract barrel appends.

## Residual main-side changes (exact)

1. `container/agent-runner/src/providers/claude.ts` (68+/35-). Exported `ClaudeInference` (adds `thinking?: Options['thinking']`, widens `settings` to `Options['settings']`) and `ClaudeExecutionPolicy` (adds `tools?: Options['tools']`) replace the `ReturnType<typeof resolve...>` casts (new lines 75-97); `createPreToolUseHook(disallowedTools)` replaces the module const that read `SDK_DISALLOWED_TOOLS` (lines 144-170) and is built from the resolved policy (line 245); `query()` spreads `thinking` and `tools` (lines 307-308). Why: `query()` consumed only model/effort/settings and disallowedTools/permissionMode, so a contract wrapping Claude's resolves had nowhere to carry reasoning-off or the built-in tool set, and the hook enforced only Claude's constant list.
2. `src/provider-contracts/realize.ts` lines 129-134: under a host contract only `overlay.env` survived, so `blockedHosts` from the legacy adapter was dropped silently. Spike passes it through. Recommended landing shape: declare `blockedHosts` as data on `ProviderHostContract` (registry.ts type + shape check, ~10 lines) and have realize carry it. No regression test added (realize.test.ts has no overlay fixture).
3. Cherry-picked 68ccf6dd (31 lines, 6 files); one conflict in `container-runner.ts` resolved by adding `model: containerConfig.model` to the context object.

## Seam commits: obsoleted vs still needed

| Seam | Status |
|---|---|
| ClaudeProvider seams for subclasses (af8db8d0) | Obsoleted: contract carries textDelivery, settings ride inference, constructor takes configuration |
| builtInTools/thinking/disallowedTools (68502af6) | Obsoleted as subclass options; disallowedTools already rides executionPolicy on main; only the `tools`/`thinking` pass-through above remains |
| container contributions carry model + blocked hosts (68ccf6dd) | Still needed (applied here) plus the realize passthrough |
| provider env after gateway (da6c89d8) | Still needed: main `container-runner.ts:1077-1082` still lets the gateway win (by reading) |
| children inherit model / effort (022ee214, 1f8f702d) | Still needed: main `create-agent.ts` has no model/effort handling (by reading) |
| explicit refspec fetch (5b76990b) | Still needed: `skill-apply.ts:653` still `git fetch ${remote} ${b}` (by reading) |
| result-door delivered (cce006d5) | Still needed, verified by running: grafting the seams test onto main's `poll-loop.midturn-resultdoor.test.ts` gives 22 pass, 1 fail (nudge fires after an MCP send for a result-door provider). Not fixed in the spike |

## Landing plan

main: claude.ts seam (+ ~40 test lines), realize/host-contract blockedHosts (+ ~20 test lines), 68ccf6dd rebased, da6c89d8 (2 + 11 test), create-agent inherit (~20 + 23 test), refspec (3 lines, 3 files), poll-loop result door (13 + 23 test). Replace main's existing env-var-only `.claude/skills/add-ollama-provider/SKILL.md` and `docs/ollama.md` with the payload-install skill (~80+/145-). Decide `offered`: `'true'` requires changing `setup/providers/skill-descriptor.test.ts` (expects `['codex']`) and a `setup/providers/ollama.ts` entry.

providers: `src/providers/ollama.ts` (152), `ollama.test.ts` (105), `ollama-registration.test.ts` (8), `src/provider-contracts/ollama.ts` (25), `container/.../provider-contracts/ollama.ts` (77), `container/.../providers/ollama.ts` (86), `ollama.test.ts` (63), `ollama-tool-policy.test.ts` (116), `ollama-registration.test.ts` (8), `ollama.conformance.test.ts` (7), `mcp-tools/ollama-web.ts` (286), `ollama-web.test.ts` (154).

Wrinkles: the runtime alias is read from the contract's `environment` (process.env) while the provider reads `options.env` for the header and browsing flag; `index.ts` passes `env: {...process.env}` so they agree at runtime, and the tests set both. Ollama declares no `speedTiers`, so `--speed` is rejected for its groups.

## Not verified

The payload's claim that Claude Code drops `thinking` for a custom base URL, so both the SDK option and the X-Ollama-Think header must stay. That needs a live daemon capture. Also unrecorded: why the payload chose result-only delivery; the contract comment states the fact only.
