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
import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATA_DIR } from '../src/config.js';
import { getAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
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
 */
export function ollamaEnvOverrides(containerBaseUrl: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: containerBaseUrl,
    ANTHROPIC_AUTH_TOKEN: 'placeholder',
  };
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

/** Run one headless setup step as a child process, so a step's own process.exit() cannot terminate this orchestrator. */
function runSetupStep(step: string, stepArgs: string[] = []): void {
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
    runSetupStep('environment');
    if (!isDockerAvailable()) {
      console.error('ollama-launch: Docker is required but not installed/running');
      return 2;
    }
    runSetupStep('container');
    runSetupStep('onecli');
    runSetupStep('mounts', ['--empty']);
  }
  // The service step builds the host, stamps the version-sensitive upgrade marker
  // (without which the host refuses to boot), and (re)installs the launchd/systemd
  // unit — but it also rebuilds and hard-restarts the running host, bouncing live
  // sessions. So run it on first install, or on a re-launch only when the host is
  // actually down; a normal re-launch of a running host is left untouched.
  if (!onboarded || !isHostServiceRunning()) {
    runSetupStep('service');
  }

  // Creating the cli agent is idempotent. The launcher only passes --display-name
  // on first run; on a re-launch it is omitted and the existing group is resolved
  // from the cli wiring below.
  if (displayName && !group) {
    const cliAgentArgs = ['--display-name', displayName];
    if (agentName) cliAgentArgs.push('--agent-name', agentName);
    runSetupStep('cli-agent', cliAgentArgs);
  }

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const ag = resolveAgentGroup({ group, displayName });
  ensureContainerConfig(ag.id);
  const row = getContainerConfig(ag.id);
  if (!row) throw new LaunchError(1, `container config missing for agent group ${ag.id}`);

  const env = { ...(JSON.parse(row.env) as Record<string, string>), ...ollamaEnvOverrides(containerBaseUrl) };
  updateContainerConfigJson(ag.id, 'env', env);
  updateContainerConfigScalars(ag.id, { model });
  console.error(`[ollama-launch] wired agent group ${ag.id} -> ${containerBaseUrl} (model ${model})`);

  console.log(`CHAT: cd ${process.cwd()} && pnpm run chat "hi"`);
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
