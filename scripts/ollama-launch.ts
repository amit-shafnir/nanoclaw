/**
 * ollama-launch.ts — headless orchestrator behind `ollama launch nanoclaw`.
 *
 * Ollama's launcher clones this checkout and execs `scripts/ollama-launch.sh`,
 * which forwards here. This script points the install at a local Ollama endpoint
 * by reusing the bundled `claude` provider as-is: Ollama speaks the Anthropic
 * Messages API, so no provider code changes are needed — only per-group config.
 *
 *   - `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` are stored on the agent
 *     group's `container_configs.env`, which the spawn path emits as `docker run
 *     -e` after the OneCLI gateway apply (so they take precedence) — see
 *     buildPerGroupOverrideArgs in src/container-runner.ts;
 *   - the model id is the `container_configs.model` scalar, passed verbatim as
 *     the container's `--model` flag.
 *
 * Those rows are written directly via the container-config DB helpers rather than
 * the `ncl` CLI, because `ncl` talks over the host's Unix socket and so needs the
 * host process running; this script also runs the setup steps and owns the same
 * data/v2.db, so direct writes are race-free and equivalent.
 *
 * Exit codes: 0 success · 2 prerequisite missing (Docker) · 3 needs a manual step
 * (egress lockdown) · 1 anything else. Non-zero paths print a one-line reason to
 * stderr; on success a single `CHAT: ...` line is printed to stdout.
 *
 * Cloud Ollama models need no separate mode: pass a `:cloud`-suffixed model id
 * (e.g. `glm-4.7:cloud`) with the local daemon signed in (`ollama signin`). The
 * daemon proxies to ollama.com, and the Anthropic-compatible surface, base URL,
 * and ignored auth token are identical to a local model — so the path below
 * carries both. The ollama.com credential lives in the daemon, never here.
 *
 * Usage:
 *   pnpm exec tsx scripts/ollama-launch.ts \
 *     --model <id> --base-url <url> [--display-name <name>] \
 *     [--agent-name <name>] [--group <agent-group-id>]
 */
import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as p from '@clack/prompts';

import { runQuietStep } from '../setup/lib/runner.js';
import { runWindowedStep } from '../setup/lib/windowed-runner.js';
import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../src/db/container-configs.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';
import { normalizeName } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { isUpgradeCurrent } from '../src/upgrade-state.js';
import type { AgentGroup, MessagingGroupAgent } from '../src/types.js';

const CLI_CHANNEL = 'cli';
const CLI_PLATFORM_ID = 'local';

/** Loopback hosts the container cannot reach — rewritten to the host gateway. */
const CONTAINER_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]']);
/** Docker's host alias; resolves to the host from inside the container (macOS native). */
const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

export interface LaunchArgs {
  model: string;
  baseUrl: string;
  /** The human operator's name (the cli:local user); first run only. */
  displayName?: string;
  /** The assistant's own name; defaults to displayName in the cli-agent step when omitted. */
  agentName?: string;
  group?: string;
}

export type ParseResult = { ok: true; value: LaunchArgs } | { ok: false; message: string };

/**
 * Parse the launch CLI arguments. Returns a discriminated result rather than
 * exiting so the caller controls the exit code; unknown flags and missing values
 * are reported, not ignored.
 */
export function parseArgs(argv: string[]): ParseResult {
  let model: string | undefined;
  let baseUrl: string | undefined;
  let displayName: string | undefined;
  let agentName: string | undefined;
  let group: string | undefined;

  const takeValue = (flag: string, raw: string | undefined): string | { error: string } =>
    raw === undefined || raw.startsWith('--') ? { error: `missing value for ${flag}` } : raw;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--model':
      case '--base-url':
      case '--display-name':
      case '--agent-name':
      case '--group': {
        const val = takeValue(flag, next);
        if (typeof val !== 'string') return { ok: false, message: val.error };
        if (flag === '--model') model = val;
        else if (flag === '--base-url') baseUrl = val;
        else if (flag === '--display-name') displayName = val;
        else if (flag === '--agent-name') agentName = val;
        else group = val;
        i++;
        break;
      }
      default:
        return { ok: false, message: `unknown argument: ${flag}` };
    }
  }

  if (!model) return { ok: false, message: 'missing required argument: --model' };
  if (!baseUrl) return { ok: false, message: 'missing required argument: --base-url' };

  return { ok: true, value: { model, baseUrl, displayName, agentName, group } };
}

export type PreflightResult = { ok: true } | { ok: false; exitCode: 3; message: string };

/**
 * Conditions that block a launch and need operator action before a retry. Egress
 * lockdown severs the container's path to a host-loopback Ollama. A missing
 * Docker daemon (exit 2) is detected at runtime, not here.
 */
export function classifyPreflight(input: { egressLockdownOn: boolean }): PreflightResult {
  if (input.egressLockdownOn)
    return {
      ok: false,
      exitCode: 3,
      message:
        'NANOCLAW_EGRESS_LOCKDOWN=true blocks the container from reaching a host-loopback Ollama. ' +
        'Unset it, or point --base-url at a routable Ollama address.',
    };
  return { ok: true };
}

/**
 * Rewrite a host-view base URL into one the container can reach. The launcher
 * passes the host's own loopback (e.g. http://127.0.0.1:11434); from inside the
 * container that loopback is the container itself, so swap it for the Docker
 * host gateway. Non-loopback and unparseable URLs pass through verbatim.
 */
export function rewriteBaseUrlForContainer(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (e: unknown) {
    if (!(e instanceof TypeError)) throw e; // only an unparseable URL is expected here
    return baseUrl;
  }
  if (!CONTAINER_LOOPBACK_HOSTS.has(url.hostname)) return baseUrl;
  const port = url.port ? `:${url.port}` : '';
  const pathPart = url.pathname === '/' ? '' : url.pathname;
  return `${url.protocol}//${CONTAINER_HOST_GATEWAY}${port}${pathPart}`;
}

/**
 * Per-group env that points the bundled `claude` provider at Ollama.
 * ANTHROPIC_AUTH_TOKEN is a non-empty placeholder: the SDK refuses to send a
 * request without one, OneCLI forwards the unmatched Ollama host WITHOUT
 * injecting a secret (the placeholder rides through), and Ollama ignores the
 * bearer token. A real Anthropic host would have the token replaced by OneCLI,
 * so the placeholder can never bill.
 *
 * CLAUDE_CODE_ATTRIBUTION_HEADER=off stops the bundled `claude` binary from
 * stamping its billing line (`x-anthropic-billing-header` / `cch`) as the FIRST
 * system block. That line carries a nonce + cc_version suffix that rotate every
 * turn; Ollama's KV prefix cache is anchored at token 0, so a changing front
 * invalidates the cache every turn and re-prefills the whole (growing) prompt —
 * the "slower every message" local-model latency. With it off the prompt front
 * is static and the cache holds across turns. This is the real fix; cutting the
 * system prompt or tool schemas did nothing for steady-state latency.
 */
export function ollamaEnvOverrides(containerBaseUrl: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: containerBaseUrl,
    ANTHROPIC_AUTH_TOKEN: 'placeholder',
    CLAUDE_CODE_ATTRIBUTION_HEADER: 'off',
  };
}

/**
 * Merge the Ollama env overrides onto a group's existing `container_configs.env`,
 * dropping NANOCLAW_BARE_SYSTEM_PROMPT. The spread keeps any pre-existing key the
 * overrides don't set, so a group deployed by the old bare-prompt launcher would
 * otherwise carry that var forever; deleting it lets a re-launch self-heal.
 */
export function mergeOllamaEnv(existingEnvJson: string, containerBaseUrl: string): Record<string, string> {
  const env = { ...(JSON.parse(existingEnvJson) as Record<string, string>), ...ollamaEnvOverrides(containerBaseUrl) };
  delete env.NANOCLAW_BARE_SYSTEM_PROMPT;
  return env;
}

/**
 * Block api.anthropic.com so an Ollama-routed agent can never reach (or bill) the
 * real Anthropic API even if a request escapes the base-URL override — the spawn
 * path maps each blocked host to `--add-host <host>:0.0.0.0`. Union with the
 * group's existing list so a re-launch keeps any host the operator already blocked.
 * Only this exact host is blocked because it's the one OneCLI's Anthropic secret
 * matches (host-pattern in setup/auth.ts); broaden here if that pattern broadens.
 */
export function ollamaBlockedHosts(existingBlockedJson: string): string[] {
  return [...new Set([...(JSON.parse(existingBlockedJson) as string[]), 'api.anthropic.com'])];
}

/** Carries the intended process exit code from a controlled failure to the top-level handler. */
class LaunchError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'LaunchError';
  }
}

type SocketProbe = () => Promise<boolean>;
type HostServiceRestart = () => void;

interface SocketWaitOptions {
  attempts?: number;
  intervalMs?: number;
  restartAfter?: number;
}

function hostRestartCommandText(): string {
  return process.platform === 'darwin'
    ? `launchctl kickstart -k gui/$(id -u)/${getLaunchdLabel()}`
    : `systemctl --user restart ${getSystemdUnit()}`;
}

function restartHostService(): void {
  try {
    if (process.platform === 'darwin') {
      execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${getLaunchdLabel()}`], {
        stdio: 'ignore',
      });
    } else if (process.platform === 'linux') {
      execFileSync('systemctl', ['--user', 'restart', getSystemdUnit()], { stdio: 'ignore' });
    }
  } catch {
    // The follow-up socket probe reports the actionable failure; restart is best-effort.
  }
}

/** Resolves true if something accepts a connection on data/cli.sock within `timeoutMs`. */
function cliSocketAccepts(timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(path.join(DATA_DIR, 'cli.sock'));
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Block until the host is listening on data/cli.sock, then return. A plain socket
 * connect — not a model round-trip — is the right readiness signal: it confirms
 * launchd brought the host up without paying a cold inference or aborting on a
 * slow model. This gates the cache prime below: primeModelCache swallows connect
 * errors, so priming against a not-yet-bound socket would silently no-op and leave
 * the first turns cold (the launchd race that made replies slow again). Restarts
 * the host once if the socket hasn't come up by `restartAfter` tries.
 */
export async function waitForCliSocket(
  probe: SocketProbe = cliSocketAccepts,
  restart: HostServiceRestart = restartHostService,
  { attempts = 20, intervalMs = 1_000, restartAfter = 10 }: SocketWaitOptions = {},
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await probe()) return;
    if (i === restartAfter - 1) restart();
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new LaunchError(1, `NanoClaw service is not listening on data/cli.sock. Try: ${hostRestartCommandText()}`);
}

/** Same wording setup:auto uses, so the two flows read identically. */
const STEP_LABELS: Record<string, { running: string; done: string; failed?: string }> = {
  environment: { running: 'Checking your system…', done: 'Your system looks good.' },
  container: {
    running: "Preparing your assistant's sandbox…",
    done: 'Sandbox ready.',
    failed: "Couldn't prepare the sandbox.",
  },
  onecli: { running: 'Setting up the secure gateway…', done: 'Gateway ready.' },
  mounts: { running: "Setting your assistant's access rules…", done: 'Access rules set.' },
  service: { running: 'Starting NanoClaw in the background…', done: 'NanoClaw is running.' },
  'cli-agent': { running: 'Bringing your assistant online…', done: 'Assistant wired up.' },
};

/**
 * Run one headless setup step as a child process (its own process.exit() can't
 * terminate this orchestrator). On a TTY, wrap it in the same clack spinner /
 * rolling-tail UI setup:auto uses; piped/headless callers keep raw passthrough.
 */
async function runSetupStep(step: string, stepArgs: string[] = []): Promise<void> {
  if (!process.stdout.isTTY) {
    console.error(`[ollama-launch] setup step: ${step}`);
    const result = spawnSync('pnpm', ['exec', 'tsx', 'setup/index.ts', '--step', step, ...stepArgs], {
      stdio: 'inherit',
    });
    if (result.error) throw new LaunchError(1, `failed to launch setup step "${step}": ${result.error.message}`);
    if (result.status !== 0)
      throw new LaunchError(
        1,
        `setup step "${step}" failed (${result.status !== null ? `exit ${result.status}` : `signal ${result.signal}`})`,
      );
    return;
  }

  const labels = STEP_LABELS[step];
  // container is the slow image build → rolling-tail window; everything else → spinner.
  const res =
    step === 'container' ? await runWindowedStep(step, labels, stepArgs) : await runQuietStep(step, labels, stepArgs);
  if (!res.ok) {
    if (res.transcript) console.error(res.transcript); // ponytail: dump-and-exit instead of auto.ts's fail() UI; add a pretty screen only if it matters
    throw new LaunchError(1, `setup step "${step}" failed`);
  }
}

/** True only when the Docker daemon is installed AND reachable. */
function isDockerAvailable(): boolean {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

/**
 * Read-only probe of whether the host service is already running, so a re-launch
 * can skip the rebuild + restart that the `service` step performs. Mirrors the
 * check in setup/verify.ts. A false result (down, or an unmanaged platform)
 * safely falls back to running the step.
 */
function isHostServiceRunning(): boolean {
  try {
    if (process.platform === 'darwin') {
      const line = execSync('launchctl list', { encoding: 'utf-8' })
        .split('\n')
        .find((l) => l.includes(getLaunchdLabel()));
      if (!line) return false;
      const pid = line.trim().split(/\s+/)[0];
      return pid !== '-' && pid !== '';
    }
    if (process.platform === 'linux') {
      const prefix = process.getuid?.() === 0 ? 'systemctl' : 'systemctl --user';
      execSync(`${prefix} is-active ${getSystemdUnit()}`, { stdio: 'ignore' });
      return true;
    }
    // Any probe failure (missing launchctl/systemctl, inactive unit, parse miss)
    // means "can't confirm running"; the caller then safely runs the service step
    // rather than crashing the launch.
    // eslint-disable-next-line no-catch-all/no-catch-all -- intentional fall-back swallow (see above)
  } catch {
    return false;
  }
  return false;
}

/**
 * Pick the agent the cli/local channel routes to: highest priority, and among
 * equal priorities the oldest wiring (the original cli agent). A deterministic
 * tiebreak avoids re-pointing a different group across re-launches when more
 * than one agent is wired at the default priority.
 */
export function selectPrimaryWiring(wirings: MessagingGroupAgent[]): MessagingGroupAgent | undefined {
  return wirings.slice().sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at))[0];
}

/**
 * Resolve the agent group to configure. Preference: an explicit --group, then
 * the deterministic cli folder for --display-name, then (re-launch, neither
 * flag) the primary agent wired to the cli/local channel.
 */
function resolveAgentGroup(input: { group?: string; displayName?: string }): AgentGroup {
  if (input.group) {
    const ag = getAgentGroup(input.group);
    if (!ag) throw new LaunchError(1, `no agent group with id "${input.group}"`);
    return ag;
  }
  if (input.displayName) {
    const folder = `${CLI_CHANNEL}-with-${normalizeName(input.displayName)}`;
    const ag = getAgentGroupByFolder(folder);
    if (!ag)
      throw new LaunchError(1, `agent group not found for display name "${input.displayName}" (folder ${folder})`);
    return ag;
  }
  const cliMg = getMessagingGroupByPlatform(CLI_CHANNEL, CLI_PLATFORM_ID);
  if (!cliMg) throw new LaunchError(1, 'no cli channel found; re-run with --display-name to create one');
  const wired = selectPrimaryWiring(getMessagingGroupAgents(cliMg.id));
  if (!wired) throw new LaunchError(1, 'cli channel has no wired agent; re-run with --display-name');
  const ag = getAgentGroup(wired.agent_group_id);
  if (!ag) throw new LaunchError(1, `cli wiring points at missing agent group ${wired.agent_group_id}`);
  return ag;
}

/**
 * Interactive first conversation with the cli agent. Loops until the operator
 * presses Enter (or cancels) on an empty prompt. `chat.ts` already connects to
 * data/cli.sock and waits for the reply (120s timeout), so the reply streams in
 * with no ping/spinner wrapper here. spawn errors are swallowed: a chat hiccup
 * must not flip a good install to a non-zero exit.
 */
async function runFirstChat(): Promise<void> {
  for (;;) {
    const msg = await p.text({
      message: 'Say hi to your assistant — or press Enter to continue',
      placeholder: 'e.g. "hi, what can you do?"',
    });
    const text = String(msg).trim();
    if (p.isCancel(msg) || !text) return;
    await new Promise<void>((resolve) =>
      spawn('pnpm', ['--silent', 'run', 'chat', text], { stdio: ['ignore', 'inherit', 'inherit'] })
        .on('close', () => resolve())
        .on('error', () => resolve()),
    );
  }
}

/**
 * Run ONLY the channel block of setup/auto.ts by skipping every other step.
 * NANOCLAW_REEXEC_SG=1 suppresses both the welcome menu and the "already
 * installed?" prompt, so the picker is reused verbatim with no auto.ts edits.
 * displayName is omitted on re-launch (auto.ts falls back to the existing name).
 */
function runChannelStep(displayName?: string): void {
  spawnSync('pnpm', ['run', 'setup:auto'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NANOCLAW_SKIP: 'environment,container,onecli,auth,mounts,service,cli-agent,first-chat,timezone,verify',
      NANOCLAW_REEXEC_SG: '1',
      ...(displayName ? { NANOCLAW_DISPLAY_NAME: displayName } : {}),
    },
  });
}

/**
 * Preload the model into Ollama so the user's first message isn't stuck behind a
 * cold load (gemma4 is ~9.6GB; first inference loads it from disk). `keep_alive:
 * -1` pins it resident. Uses `hostBaseUrl` — the host-reachable endpoint, not the
 * container's host.docker.internal rewrite. Best-effort: never fail the launch on
 * a warmup miss, and cap the wait so a wedged Ollama can't hang the install.
 */
async function warmOllama(hostBaseUrl: string, model: string): Promise<void> {
  const url = `${hostBaseUrl.replace(/\/$/, '')}/api/generate`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: -1 }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    // best-effort warmup; a cold first message is a worse outcome than a silent miss, not a failure
  }
}

/**
 * Prime Ollama's KV prefix cache with one real binary turn before the user's
 * first message. warmOllama() loads weights only; the bundled binary's first
 * turn still pays the cold ~6.6s prefill of the system+tools+CLAUDE.md prefix.
 * One throwaway turn here caches that prefix — stable across turns now that
 * CLAUDE_CODE_ATTRIBUTION_HEADER=off removes the rotating billing front — so the
 * user's first turn lands warm. A real binary turn (not a reconstructed curl) so
 * the cached prefix is byte-identical to what the user's turn will send.
 *
 * The cli channel can't thread (supportsThreads=false → the router forces
 * threadId null, src/router.ts), so there's no separate throwaway session: the
 * prime runs in the same cli session. chat.ts doesn't replay history, so the
 * exchange is invisible in the terminal — it only sits in the session's
 * continuation. Awaits the reply so the prefix is cached before the real turn.
 * Best-effort: a warmup miss is a slower first turn, never a failed launch.
 */
async function primeModelCache(): Promise<void> {
  await new Promise<void>((resolve) =>
    spawn('pnpm', ['--silent', 'run', 'chat', 'Reply with: ok'], { stdio: 'ignore' })
      .on('close', () => resolve())
      .on('error', () => resolve()),
  );
}

/** Generate a DB id in the codebase's `<prefix>-<ts>-<rand>` shape. */
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Ensure the channel agent group exists and is wired to Ollama BEFORE setup:auto's
 * channel flow runs. setup:auto's init-first-agent looks up `dm-with-<name>` and
 * REUSES it if present (init-first-agent.ts), so pre-creating it means the welcome
 * container spawns on Ollama instead of spawning stale (no env/model) and then
 * 401-looping against api.anthropic.com. The folder is `dm-with-<name>` for every
 * direct channel, so this is channel-agnostic.
 */
function prewireChannelGroup(
  displayName: string,
  agentName: string | undefined,
  containerBaseUrl: string,
  model: string,
): void {
  const folder = `dm-with-${normalizeName(displayName)}`;
  let dm = getAgentGroupByFolder(folder);
  if (!dm) {
    createAgentGroup({
      id: generateId('ag'),
      name: agentName ?? displayName,
      folder,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    dm = getAgentGroupByFolder(folder)!;
  }
  wireOllama(dm.id, containerBaseUrl, model);
}

/** Point one agent group's container config at the Ollama endpoint + model. Idempotent. */
function wireOllama(agId: string, containerBaseUrl: string, model: string): void {
  ensureContainerConfig(agId);
  const row = getContainerConfig(agId);
  if (!row) throw new LaunchError(1, `container config missing for agent group ${agId}`);
  const env = mergeOllamaEnv(row.env, containerBaseUrl);
  updateContainerConfigJson(agId, 'env', env);
  updateContainerConfigJson(agId, 'blocked_hosts', ollamaBlockedHosts(row.blocked_hosts));
  updateContainerConfigScalars(agId, { model });
  console.error(`[ollama-launch] wired agent group ${agId} -> ${containerBaseUrl} (model ${model})`);
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`ollama-launch: ${parsed.message}`);
    return 1;
  }
  const { model, baseUrl, displayName, agentName, group } = parsed.value;

  const preflight = classifyPreflight({
    egressLockdownOn: process.env.NANOCLAW_EGRESS_LOCKDOWN === 'true',
  });
  if (!preflight.ok) {
    console.error(`ollama-launch: ${preflight.message}`);
    return preflight.exitCode;
  }

  const containerBaseUrl = rewriteBaseUrlForContainer(baseUrl);

  // Install only when this checkout has never been onboarded. isUpgradeCurrent()
  // is the same predicate the host's startup tripwire uses (marker present AND
  // version-current), so a stale marker correctly re-triggers the build.
  const onboarded = isUpgradeCurrent();
  if (!onboarded) {
    await runSetupStep('environment');
    if (!isDockerAvailable()) {
      console.error('ollama-launch: Docker is required but not installed/running');
      return 2;
    }
    await runSetupStep('container');
    await runSetupStep('onecli');
    await runSetupStep('mounts', ['--empty']);
  }
  // The service step builds the host, stamps the version-sensitive upgrade marker
  // (without which the host refuses to boot), and (re)installs the launchd/systemd
  // unit — but it also rebuilds and hard-restarts the running host, bouncing live
  // sessions. So run it on first install, or on a re-launch only when the host is
  // actually down; a normal re-launch of a running host is left untouched.
  if (!onboarded || !isHostServiceRunning()) {
    await runSetupStep('service');
  }

  // Creating the cli agent is idempotent. The launcher only passes --display-name
  // on first run; on a re-launch it is omitted and the existing group is resolved
  // from the cli wiring below.
  if (displayName && !group) {
    const cliAgentArgs = ['--display-name', displayName];
    if (agentName) cliAgentArgs.push('--agent-name', agentName);
    await runSetupStep('cli-agent', cliAgentArgs);
  }

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const ag = resolveAgentGroup({ group, displayName });
  wireOllama(ag.id, containerBaseUrl, model);

  // Preload the model so the first chat (below) lands warm, not behind a cold load.
  // Uses baseUrl (host-reachable), not the container's host.docker.internal rewrite.
  console.error('[ollama-launch] warming up the model…');
  await warmOllama(baseUrl, model);
  // Gate the prime on a live socket: priming a not-yet-bound host silently
  // no-ops and leaves the first turns cold.
  await waitForCliSocket();

  // warmOllama loads weights only; prime the binary's system+tools prefix into
  // Ollama's KV cache with one real turn so the first user message lands warm.
  // Both paths: the non-TTY `ollama launch` flow benefits as much as the TTY one.
  console.error('[ollama-launch] priming the model cache…');
  await primeModelCache();

  // Interactive: chat with the agent, then (first run only) pick a channel.
  // Non-TTY callers (the Go launcher pipes/inherits) get the machine-readable
  // success line instead. The tail is soft — neither step flips the exit code.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    await runFirstChat();
    if (!onboarded) {
      // Pre-wire the channel group to Ollama BEFORE setup:auto creates it, so its
      // welcome container spawns on Ollama and reuses our config (no 401-loop race).
      if (displayName) prewireChannelGroup(displayName, agentName, containerBaseUrl, model);
      runChannelStep(displayName);
    }
  } else {
    console.log(`CHAT: cd ${process.cwd()} && pnpm run chat "hi"`);
  }
  return 0;
}

const invokedDirectly =
  !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      if (err instanceof LaunchError) {
        console.error(`ollama-launch: ${err.message}`);
        process.exit(err.exitCode);
      }
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(1);
    });
}
