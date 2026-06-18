/**
 * Pi provider setup — auth walk-through + install verification.
 *
 * Pi-owned payload code: it travels with the provider on the `providers` branch
 * and `/add-pi` (or `setup/add-pi.sh`) copies it back in. The only trunk
 * reach-ins are one import + one picker entry in setup/auto.ts and one
 * INSTALL_SCRIPTS entry in setup/provider-auth.ts.
 *
 * Pi runs on Claude Sonnet via Anthropic's API, so auth is just an Anthropic
 * API key in the OneCLI vault (host-pattern api.anthropic.com) — the same
 * credential the Claude provider uses, so a standard install usually already
 * has it and this step is a no-op. The key never lands in .env or the
 * container; the gateway injects it on the wire and the container only ever
 * sees the placeholder ANTHROPIC_API_KEY.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { brandBody } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { registerSetupProvider } from './registry.js';

const ANTHROPIC_HOST = 'api.anthropic.com';

interface OnecliSecret {
  type: string;
  hostPattern: string | null;
}

/** True if the vault already holds an Anthropic-scoped credential (idempotency guard). */
function anthropicSecretExists(): boolean {
  try {
    const out = execFileSync('onecli', ['secrets', 'list'], { encoding: 'utf-8' });
    const parsed = JSON.parse(out) as { data?: unknown };
    const secrets = Array.isArray(parsed.data) ? (parsed.data as OnecliSecret[]) : [];
    return secrets.some(
      (s) => s.type?.toLowerCase() === 'anthropic' || (s.hostPattern ?? '').toLowerCase().includes(ANTHROPIC_HOST),
    );
  } catch {
    return false;
  }
}

function ensureAnswer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return value as T;
}

// ─── auth step ─────────────────────────────────────────────────────────────

export async function runPiAuth(): Promise<void> {
  if (anthropicSecretExists()) {
    setupLog.step('auth', 'skipped', 0, { PROVIDER: 'pi', REASON: 'anthropic-secret-already-present' });
    p.log.success(brandBody('Anthropic key already in your vault — Pi will use it. Nothing to do.'));
    return;
  }

  const key = ensureAnswer(
    await p.password({
      message: 'Paste your Anthropic API key (sk-ant-…)',
      validate: (v) =>
        v && v.trim().startsWith('sk-ant-') ? undefined : 'That does not look like an Anthropic API key.',
    }),
  ).trim();

  try {
    execFileSync(
      'onecli',
      [
        'secrets',
        'create',
        '--name',
        'Pi (Anthropic)',
        '--type',
        'anthropic',
        '--value',
        key,
        '--host-pattern',
        ANTHROPIC_HOST,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    setupLog.step('auth', 'failed', 0, { PROVIDER: 'pi', ERROR: String(err) });
    p.log.error(
      brandBody(
        "Couldn't save your Anthropic key to the vault. Make sure OneCLI is running (`onecli version`), then retry.",
      ),
    );
    process.exit(1);
  }
  setupLog.step('auth', 'success', 0, { PROVIDER: 'pi' });
  p.log.success(brandBody('Anthropic key connected — it lives in your OneCLI vault, never in the container.'));
}

// ─── install verification ────────────────────────────────────────────────

/**
 * Verify the pi provider payload is wired — provider files (including the
 * ported instruction-flatten + replay helpers), all three barrels, and the Pi
 * SDK dependency in the container package. Mirrors `verifyCodexInstall`.
 */
export function verifyPiInstall(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const root = process.cwd();

  const requiredFiles = [
    'src/providers/pi.ts',
    'container/agent-runner/src/providers/pi.ts',
    'container/agent-runner/src/providers/pi-mcp-bridge.ts',
    'container/agent-runner/src/providers/agent-instructions.ts',
    'container/agent-runner/src/db/replay.ts',
    'setup/providers/pi.ts',
  ];
  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`missing file: ${file}`);
  }

  for (const barrel of [
    'src/providers/index.ts',
    'container/agent-runner/src/providers/index.ts',
    'setup/providers/index.ts',
  ]) {
    const barrelPath = path.join(root, barrel);
    if (!fs.existsSync(barrelPath) || !fs.readFileSync(barrelPath, 'utf-8').includes("import './pi.js';")) {
      problems.push(`missing barrel import in ${barrel}`);
    }
  }

  const pkgPath = path.join(root, 'container', 'agent-runner', 'package.json');
  let hasDep = false;
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { dependencies?: Record<string, string> };
      hasDep = Boolean(pkg.dependencies?.['@earendil-works/pi-coding-agent']);
    } catch {
      hasDep = false;
    }
  }
  if (!hasDep)
    problems.push('container/agent-runner/package.json missing the @earendil-works/pi-coding-agent dependency');

  return { ok: problems.length === 0, problems };
}

export async function runPiInstallCheck(): Promise<void> {
  p.log.step(brandBody('Checking the Pi provider install…'));
  const { ok, problems } = verifyPiInstall();
  if (ok) {
    setupLog.step('pi-install', 'success', 0, {});
    p.log.success(brandBody('Pi installed properly.'));
    return;
  }

  setupLog.step('pi-install', 'failed', 0, { PROBLEMS: problems.join('; ') });
  p.log.warn(brandBody('The Pi provider is not fully installed:'));
  for (const problem of problems) console.log(k.dim(`   • ${problem}`));
  p.log.warn(
    brandBody(
      'Finish it with your coding agent: open Claude Code or Codex in this repo and run the /add-pi skill. Setup will continue — Pi groups will work once the install completes.',
    ),
  );
}

// Self-registration: the setup picker and the standalone `provider-auth` step
// render from the registry — this call is pi's only reach-in to the setup flow
// (guarded by the barrel-driven registration test).
registerSetupProvider({
  value: 'pi',
  label: 'Pi',
  hint: 'Pi coding agent — runs on Claude Sonnet, keeps its own tools + NanoClaw tools',
  runAuth: runPiAuth,
  runInstallCheck: runPiInstallCheck,
});
