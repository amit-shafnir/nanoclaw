# Phase 1, providers side: feat/ollama-provider-finish rebuilt on upstream/providers

## Final log

```
git -C .claude/worktrees/ollama-provider-registry log --oneline upstream/providers..HEAD
78309dac feat(ollama): direct web search and fetch adapters for the daemon's signed endpoints
16f4d591 feat(ollama): local Ollama provider as a runtime and host contract
```

Base is `upstream/providers` at `ee0d0a34` (it advanced 2 commits past the
`f503f23c` in the brief; the codex contract refactor merged). Backup ref
`backup/ollama-provider-finish-pre-contract` = `28a79b85`, created before the
rewrite. Two commits were enough; nothing was left over. 12 files, 1100 lines.
No barrels touched. Nothing pushed.

## Instruction strings as committed

`container/agent-runner/src/providers/ollama.ts`, appended per turn by
`ollamaStandingInstructions(options)` in this order, joined by blank lines:

1. Model identity, only when a model is configured:
   `You are running through the local Ollama client with source model
   ${JSON.stringify(options.model)}. Report this source model, never the
   internal nanoclaw/* runtime alias.`
2. Agent messaging, always (carries the behavioral fix):
   `Agent messages do not run in the background: do the requested work in this
   turn before replying. Send the result to the agent named in `from`; `user`
   is only the human's own conversation.`
3. Approval, always:
   `If `ncl` returns `approval-pending`, say so in one line and end the turn;
   the host sends the result.`
4. Web tools, only when `NANOCLAW_OLLAMA_WEB_BROWSING === 'enabled'`:
   `For public web content use `mcp__nanoclaw__ollama_web_search` to find URLs
   and `mcp__nanoclaw__ollama_web_fetch` to read them. Use agent-browser only
   for clicks, typing, sign-in state, or screenshots.`

Header constant: `X-Ollama-Think: false`.

## Composed verification (all run, in the spike worktree)

Spike worktree payload files replaced with branch-head versions and confirmed
byte-identical (`cmp` over all 12); its main-side files (claude.ts seam,
realize.ts, the 68ccf6dd cherry-pick, barrels) left as they were.

| Gate | Result |
|---|---|
| `pnpm run build` | exit 0 |
| `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` | exit 0 |
| `pnpm exec vitest run src/provider-contracts src/providers setup/providers setup/provider-contract.test.ts src/container-runner.test.ts` | 10 files pass, 1 skipped; 145 tests pass, 1 skipped (legacy-payload-compat, pre-existing) |
| `bun test src/provider-contracts src/providers src/mcp-tools` | 27 files, 171 pass, 2 skip, 0 fail, 414 expects |
| ollama files alone (`bun test` on the 5 payload test files) | 30 pass, 0 fail |
| `pnpm exec tsx scripts/provider-contract-verifier.ts --required-declared ollama` | status passed, all 9 checks (`--help` read first: only `--required-declared` is accepted) |
| `pnpm exec prettier --check` on all 12 committed files | clean |

Local bun is 1.3.14; the Dockerfile pins 1.4.0, so the verifier used
`pnpm dlx bun@1.4.0` for its runtime steps while the direct runs used 1.3.14.

## What changed relative to the spike drafts

1. **Four instruction helpers collapsed into one builder.** The spike shipped
   `withOllamaModelIdentity` / `withOllamaWebToolInstructions` /
   `withOllamaApprovalInstructions` / `withOllamaAgentMessagingInstructions`,
   four exported copies of the same three-line append, chained in `query()`.
   Replaced by one exported pure function `ollamaStandingInstructions(options)`
   that returns the whole append, computed once in the constructor, plus a
   single append site in `query()`. Exports from the module go 5 to 1;
   `withOllamaThinkHeader` became private (the tool-policy test already covers
   it through the real path). Reason: the standards' rule-of-three and
   "export only what has a consumer today".
2. **Behavioral fix.** Second sentence added to the agent-messaging string and
   pinned in `ollama.test.ts` with the live failure recorded in a comment
   (child read `<message from="parent">`, answered `<message to="user">`).
   Vocabulary matches core's own (`destinations.ts` already says "address the
   destination it came `from`"), so the sentence reinforces rather than
   introduces a rule.
3. **Host contract dropped `commands`.** The spike duplicated Claude's
   nativeAdmin/nativeFiltered literals with a "lockstep" comment. `src/`
   consumes host-contract commands in exactly one place, `command-gate.ts`,
   which unions `nativeAdmin`/`nativeFiltered` across every registered
   contract, and Claude's contract is always registered by main's barrel. The
   copy could only drift, never change behavior. Omission is commented.
   (Codex's host contract likewise declares none.)
4. **Contract module's non-test exports made private.**
   `resolveOllamaExecutionPolicy` and `resolveOllamaMcpServers` are now module
   -local; `resolveOllamaInference` stays exported with a TSDoc saying why (the
   alias-fallback branch that the live query path cannot reach).
5. **`ollama-web.ts` / `ollama-web.test.ts` taken from `28a79b85`, not the
   spike.** The spike predates the truncation-notice commit; its copies were
   missing the clipped-excerpt marker and its test. Diffed before copying.
6. **`ollama.test.ts` rewritten** against the new builder (7 cases, was 6) and
   `ollama-tool-policy.test.ts` carried over with comment rewraps only.
7. Host `src/providers/ollama.ts` and `ollama.test.ts` are byte-identical to
   the backup; the spike's copies were already identical too.

## What I could not verify

- **The claude.ts main-side seam is not landed.** The payload needs
  `ClaudeInference` / `ClaudeExecutionPolicy` (the `thinking` and `tools`
  pass-through) exported from `container/agent-runner/src/providers/claude.ts`,
  and the host adapter needs `ctx.model` + `blockedHosts` on
  `ProviderContainerContribution` (seam 68ccf6dd) plus the `realize.ts`
  `blockedHosts` passthrough. All three exist only as uncommitted changes in
  the spike worktree. Everything above is green only against that composition;
  on `upstream/main` as it stands today the payload does not typecheck.
- **`thinking` versus the header.** The reason both the SDK option and
  `X-Ollama-Think: false` are set is the payload's claim that Claude Code drops
  `thinking` for a custom base URL. Verified by reading the existing comment
  only; it needs a live daemon capture. Carried forward unchanged.
- **The live agent-messaging fix.** Pinned as a string in a unit test; not
  re-run against a real parent/child pair on a local model. Whether the added
  sentence actually changes the model's behavior is unproven.
- **Standalone providers-branch runs.** The conformance test uses static
  imports (no `existsSync` guard like codex's). Deliberate: the whole payload
  imports `providers/claude-config.js` and `provider-contracts/claude.js`,
  which do not exist on the donor branch, so a guard on one file would be
  theatre. `providers` CI only runs `ci.yml` for PRs targeting `main`;
  `provider-contract.yml` composes core plus payload, which is the path that
  covers this. Read, not run.
- Nothing was run against a real Ollama daemon, container, or install.
