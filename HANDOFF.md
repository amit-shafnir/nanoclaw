# Handoff: `ollama launch nanoclaw` integration

Written 2026-09-14 for a colleague with no prior context. Everything referenced here is on a remote; nothing depends on the author's machine. Facts marked "not verified" were not exercised in-session.

## What this is

`ollama launch nanoclaw` installs NanoClaw driving a local model through the Ollama daemon, with a loopback browser chat. It spans two repos and four NanoClaw trunks. The bar set by the owner (Amit): the full user journey works, replies arrive in seconds, and the code is committed per trunk, rebased on current upstream, verified in a composed tree, and reviewed. The journey works. Latency does not meet the bar yet; the cause is diagnosed (issue 1).

## Branches and pull requests (remote state after the 2026-09-14 push)

| Trunk | Branch | Remote | Tip | PR |
|---|---|---|---|---|
| main | `feat/ollama-provider-seams` | nanocoai/nanoclaw | c8d2de57, 7 commits over upstream/main 75f20168 | [#3547](https://github.com/nanocoai/nanoclaw/pull/3547) draft, base main |
| main, stacked on seams | `feat/ollama-launch-finish` | nanocoai/nanoclaw | ad54dfcb, 21 commits over seams | [#3548](https://github.com/nanocoai/nanoclaw/pull/3548) draft, base feat/ollama-provider-seams |
| providers | `feat/ollama-provider-finish` | amit-shafnir/nanoclaw (fork) | 66e8878e, 2 commits over upstream/providers ee0d0a34 | [#3546](https://github.com/nanocoai/nanoclaw/pull/3546) draft, base providers, head on the fork |
| channels | `feat/local-web-channel-finish` | nanocoai/nanoclaw | 667b7cb0, 2 commits over upstream/channels 6d5c1d08 | none yet (issue 4) |
| Ollama fork | `feat/nanoclaw-launch-v2` | amit-shafnir/ollama | 02ef8f11, 7 commits over ollama/ollama main | [amit-shafnir/ollama#1](https://github.com/amit-shafnir/ollama/pull/1) on the fork; upstream [ollama/ollama#16751](https://github.com/ollama/ollama/pull/16751) closed 2026-06-16 by the author, to be reopened |
| E2E fixture | `test/ollama-e2e-fable` | amit-shafnir/nanoclaw (fork) | launch tip + `run.sh`, `reset.sh`, `README-E2E.md`, this file, `e2e-handoff/` | not a PR branch |

The providers payload does not compile on the providers branch alone; that branch is a donor branch whose core files are stale by design. It is verified only composed (main tip plus payload).

**Ship order, bottom up, each step after the previous merges:** #3547, then a new PR for `feat/local-web-channel-finish` into `channels`, then #3546, then #3548. main's `registry-skills` CI on #3548 stays red until both payloads are on their registry branches. #3547 and #3548 should become a native GitHub stack (`gh stack`) rather than prose order.

## Open issues, ranked by what a user loses

### 1. Replies after a tool call take 3.5 minutes (diagnosed, not fixed)

Evidence is on the wire, captured by a logging proxy between the agent container and the daemon: `e2e-handoff/captures/` in this branch (`index.log` plus the stalled request and its response; analyze with `python3 e2e-handoff/harness/analyze.py e2e-handoff/captures`).

After any `tool_result` (create_agent, send_message, web_search, web_fetch), the next request generated exactly 8,192 output tokens, the `CLAUDE_CODE_MAX_OUTPUT_TOKENS` cap, with `stop_reason: max_tokens`, zero content blocks, zero text, about 210 seconds. The Claude CLI then retried the same turn; eight identical stalls were captured back to back. Requests whose last message is plain user text return in 0.7 to 11 s. Thinking is off on the wire: the container sends `X-Ollama-Think: false`, the fork middleware honors it, and a direct probe returned 7 tokens with the header versus 200 thinking tokens without.

Reading the fork's `model/renderers/gemma4.go` and `model/parsers/gemma4.go`: with thinking off, the renderer emits an empty thought block and the parser drops any `<|channel>...<channel|>` span. After a tool result gemma4 opens a thought channel anyway and never closes it, so the whole generation is discarded as thinking until the cap. This is an Ollama gemma4 renderer or parser interaction with thinking disabled, not NanoClaw code. Two hand-built tool-result probes against the Desktop daemon did not reproduce it; the trigger needs the real prompt (15k tokens, 22 tools, the Claude Code system prompt), which is why the captured request matters.

First step: replay the captured request. Set `"stream": false` and `"max_tokens": 600` in a copy of `e2e-handoff/captures/1788786670585-016.request.json`, then against a fork daemon:

```bash
curl -s http://127.0.0.1:11436/v1/messages -H content-type:application/json -H anthropic-version:2023-06-01 \
  -H x-api-key:ollama -H 'anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14' \
  -H 'X-Ollama-Think: false' -d @replay.json
```

Run it with and without the `X-Ollama-Think` header, and with `"temperature": 0.3`. Candidate fixes, cheapest first, none tried:

1. Leave thinking on for gemma4 (drop the header and the SDK `thinking: disabled` for models whose parser misbehaves with it off); measure the thinking-token cost per turn.
2. Fix the fork: in `model/parsers/gemma4.go`, when thinking is disabled and a thought channel opens after a tool response, treat it as content or close it. Adds to the fork PR.
3. Lower `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (set in `src/providers/ollama.ts` on the providers branch) so a runaway costs 30 s instead of 3.5 min. Mitigation only; the turn still fails and retries.
4. Try `qwen3.8:27b-mlx` to learn whether it is gemma4-specific.

Amit asked for a plan with measured numbers per option, not one pick.

### 2. The main-side stack is 47 commits behind upstream/main and does not rebase cleanly

Probed 2026-09-14 in a throwaway worktree. `feat/ollama-provider-seams` conflicts at commit 94b05c42 `fix(skills): fetch registry branches by explicit refspec` in `scripts/skill-apply.ts`, `scripts/skill-apply.test.ts`, `scripts/test-registry-skills.ts`. Cause: upstream [#3773](https://github.com/nanocoai/nanoclaw/pull/3773) landed the same fix through a new `scripts/git-fetch-branch.ts`. Resolution: drop 94b05c42 during the rebase. Expect a second conflict at c8d2de57 `fix(agent-runner): result-door providers count DB-visible sends as delivered`: upstream [#3738](https://github.com/nanocoai/nanoclaw/pull/3738) rewrote 115 lines of `container/agent-runner/src/poll-loop.ts` around the same region; the fix is still needed (main still computes `turnDelivered` only for mid-turn providers, poll-loop.ts line 628) and must be re-applied by hand. `src/container-runner.ts` gained one line (`containerName`) near our contribution edit. Then re-stack `feat/ollama-launch-finish` with `git rebase --onto <new seams tip> c8d2de57 feat/ollama-launch-finish`; the last such re-stack had no conflicts. After rebasing, re-run the composed verification (section below) before force-pushing with `--force-with-lease`.

### 3. Uncommitted fix: re-creating a deleted agent's name from the sidebar returns 409

A deleted agent leaves its workspace folder under `groups/` and `ncl groups create` refuses to claim an unowned folder, so creating an agent with the same name from the browser fails with "Agent creation stopped during agent group". The fix walks folder suffixes (`web-name`, `web-name-2`, ...) the way agent-to-agent creation does. It is in this branch as `e2e-handoff/local-web-folder-suffix.patch` (17 lines against `src/channels/local-web-conversations.ts` at 667b7cb0). Still needed: a regression test in `src/channels/local-web-conversations.test.ts` (create the folder under the test `GROUPS_DIR` without an agent group, then assert the second create lands in `web-name-2`), prettier, a composed run, then a commit on `feat/local-web-channel-finish`.

### 4. `feat/local-web-channel-finish` has no PR

Open one into `channels` on nanocoai/nanoclaw when shipping (second in the order above). The earlier local-web work merged as [#3298](https://github.com/nanocoai/nanoclaw/pull/3298); this branch carries two commits on top: sidebar create and delete, question routing, unread badges.

### 5. #3546 is a fork PR

Its head lives on amit-shafnir/nanoclaw. A native stack cannot span repos, so if it should join a stack, re-open it from a branch on nanocoai.

### 6. The provider is not offered in the setup wizard

`.claude/skills/add-ollama-provider/SKILL.md` declares `nanoclaw-provider-offered: 'false'`. Offering it costs a `setup/providers/ollama.ts` entry and an update to `setup/providers/skill-descriptor.test.ts` (it expects only codex). Decision pending with Amit.

### 7. Not verified

- That both the `X-Ollama-Think` header and the SDK `thinking: disabled` option are required. The header alone worked in a probe; the SDK option alone was never captured on the wire. If one suffices, remove the other (`container/agent-runner/src/provider-contracts/ollama.ts` and `container/agent-runner/src/providers/ollama.ts`).
- OpenCode under the env-ordering change (seams commit 03289b21, provider env applies after the OneCLI gateway): its `NO_PROXY` now beats the gateway's. Never run live.
- The launch retry marker's recreate path after every agent was deleted was exercised live once (relaunch recreated agent "Ollama" in 7 s); the marker's own failure modes are reasoned, not driven.

### 8. Review nits, unaddressed

From the third persona review (2026-09-07): the seams branch spans four themes (contract seams plus child inheritance, refspec fix, nudge fix, channel doc); the maintainer gates on theme count, so refspec and nudge may want their own thin PRs. Two hostname validators exist for one invariant (strict in `src/provider-contracts/registry.ts`, loose in the container spec validator). WebSearch and WebFetch are excluded at three doors (`tools`, `disallowedTools`, the pre-tool hook); two are redundant once one is proven live. `eslint.config.js` mixes a reformat with the browser-asset override. The agent-messaging instruction sentence "do not run in the background" could be more concrete for a small model.

## Verification that ran (2026-09-07, on upstream/main 75f20168)

Composed clone built from a bare registry with `main` = launch tip, `providers` = provider tip, `channels` = local-web tip, both install skills applied through the real skill engine (`scripts/skill-apply.ts`):

| Check | Result |
|---|---|
| `scripts/test-registry-skills.ts --all add-ollama-provider add-local-web-chat` | 2/2 |
| host `pnpm run build`, container `tsc --noEmit` | clean |
| `pnpm exec vitest run` | 2480 pass; only `scripts/update/transaction.e2e.test.ts` fails, identically on upstream/main on that machine (git tag in a temp repo) |
| `bun test` in `container/agent-runner` | 464 pass, 0 fail |
| `pnpm run lint` | 0 errors |
| `scripts/provider-contract-verifier.ts --required-declared ollama` | passed |

Persona review round three: main seams DECIDE, launch DECIDE, channels DECIDE, providers DECIDE WITH CONDITIONS (issue 1, and live proof of the child replying to its parent, which the E2E then provided).

Live E2E through the product's own paths (fixture below): install 46 s with a cached image, welcome and chat 1 to 3 s, a child created by the parent replied `to="parent"` and the parent relayed the result, `ncl groups delete` raised an approval card that was approved through the browser API in 13 s, sidebar delete, delete of the last agent, relaunch after that recreated agent "Ollama" in 7 s, and every container carried the eight blocked cloud hosts as `--add-host ...:0.0.0.0`. Logs: `e2e-handoff/reports/journey*.log`.

## Reproducing the E2E from this branch

Prerequisites: macOS with Docker Desktop running, Ollama.app installed with `gemma4:12b-mlx` pulled, Go 1.26, Node 24, pnpm.

```bash
git clone -b test/ollama-e2e-fable https://github.com/amit-shafnir/nanoclaw nanoclaw-ollama-e2e
cd nanoclaw-ollama-e2e
STATE="$(git rev-parse --git-dir)/e2e-state"; mkdir -p "$STATE/bin/lib/ollama"

# 1. Registry the launcher clones from (split branches, complete history, no shallow graft)
git init -q --bare "$STATE/registry.git"; git -C "$STATE/registry.git" symbolic-ref HEAD refs/heads/main
git fetch -q https://github.com/nanocoai/nanoclaw feat/ollama-launch-finish feat/local-web-channel-finish
git fetch -q https://github.com/amit-shafnir/nanoclaw feat/ollama-provider-finish
git push -q "$STATE/registry.git" \
  refs/remotes/nanocoai/feat/ollama-launch-finish:refs/heads/main \
  refs/remotes/amit-shafnir/feat/ollama-provider-finish:refs/heads/providers \
  refs/remotes/nanocoai/feat/local-web-channel-finish:refs/heads/channels   # adjust remote names to yours

# 2. Launcher binary from the fork branch
git clone -q -b feat/nanoclaw-launch-v2 https://github.com/amit-shafnir/ollama ../ollama-fork
(cd ../ollama-fork && go build -o "$STATE/bin/ollama" .)

# 3. Probe the registry the way the launcher fetches (a shallow graft once passed silently and broke the install)
P=$(mktemp -d); git clone -q --depth 1 "file://$STATE/registry.git" "$P/n"
for b in providers channels; do git -C "$P/n" fetch -q origin "+refs/heads/$b:refs/remotes/origin/$b" && git -C "$P/n" show "origin/$b:$( [ $b = providers ] && echo container/agent-runner/src/provider-contracts/ollama.ts || echo scripts/local-web-preview.ts )" >/dev/null && echo "$b ok"; done

# 4. Run as a user would (daemon on 11436, chat on 3211, isolated HOME under /private/tmp)
./run.sh          # ./reset.sh returns to first-run state
```

Headless, without a browser: `e2e-handoff/harness/e2e-headless.sh` replays the Go launcher's exact sequence (`FIXTURE_DIR=$PWD NANOCLAW_E2E_OLLAMA_PORT=11436 NANOCLAW_LOCAL_WEB_PORT=3211 MODEL=gemma4:12b-mlx bash e2e-handoff/harness/e2e-headless.sh launch`; `relaunch` reuses the install; `LAUNCH_BASE_URL` overrides the daemon URL the containers get). `e2e-handoff/harness/journey.mjs <install-dir> [step,...]` drives the browser API and times every step. `e2e-handoff/harness/proxy.mjs 11437 http://127.0.0.1:11436 <outdir>` is the logging proxy; point `LAUNCH_BASE_URL` at it to capture the wire.

## Reading the code

The upstream provider-contract refactor ([#3581](https://github.com/nanocoai/nanoclaw/pull/3581), [#3585](https://github.com/nanocoai/nanoclaw/pull/3585), [#3586](https://github.com/nanocoai/nanoclaw/pull/3586), [#3727](https://github.com/nanocoai/nanoclaw/pull/3727)) made providers declared contracts: runtime contract in `container/agent-runner/src/provider-contracts/registry.ts`, host contract in `src/provider-contracts/registry.ts`, a SKILL.md descriptor, and an install verifier. The Ollama payload is expressed that way (`container/agent-runner/src/provider-contracts/ollama.ts`, `src/provider-contracts/ollama.ts`); the seams branch carries only what the contract cannot: `thinking` and `tools` pass-through in `claude.ts`, `blockedHosts` as a host-contract field, env ordering, child inheritance of provider, model and effort, and result-door delivery. Design notes: `e2e-handoff/reports/spike-REPORT.md`, `main-side.md`, `providers-side.md`.

## Working rules for this feature

Never push without being told (this branch and the four feature branches were pushed on explicit instruction on 2026-09-14). Never open or merge a PR without being told. Never use bare `git stash`. No AI attribution trailers in commits; Nanoco commits never credit a model. Commit bodies carry Why, What, Verification. Agent-facing prose is written, then halved. No em dashes in prose. A payload branch is verified only composed; compose main tip plus both payloads through the skill engine and run the full suite there.
