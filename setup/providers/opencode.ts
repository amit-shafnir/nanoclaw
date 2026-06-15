/**
 * OpenCode provider setup — backend pick + key sign-in + install verification.
 *
 * OpenCode-owned payload code: travels with the provider on the `providers`
 * branch; `/add-opencode` (or `setup/add-opencode.sh`) copies it back in. The
 * only trunk reach-in is one import + one picker entry in setup/auto.ts.
 *
 * OpenCode is a thin agent over any OpenAI-/Anthropic-shaped backend, so auth
 * is "pick a backend, paste its key". Unlike Codex (one vendor, OAuth), there
 * is no browser/device flow — every backend is an API key dropped into the
 * OneCLI vault under a host pattern. The key never lands in .env or the
 * container; the gateway injects it on the wire. Only the routing config
 * (which provider/model, which base URL) goes to .env, where the host reads it
 * and passes OPENCODE_* into the container at spawn time.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { upsertEnvKey } from '../environment.js';
import { brightSelect } from '../lib/bright-select.js';
import { brandBody } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { registerSetupProvider } from './registry.js';

/**
 * A backend OpenCode can route to. The curated entries pre-fill everything but
 * the key and model; "Something else" builds one of these at runtime from
 * answers. `baseUrl` absent means OpenCode talks to the provider's native
 * endpoint (the `anthropic` case) — no ANTHROPIC_BASE_URL override.
 */
export interface OpenCodeBackend {
  value: string;
  label: string;
  hint: string;
  /** OPENCODE_PROVIDER — OpenCode's provider id, not NanoClaw's. */
  providerId: string;
  /** ANTHROPIC_BASE_URL override. Omit to use the provider's native endpoint. */
  baseUrl?: string;
  /** OneCLI host pattern the key is scoped to. */
  hostPattern: string;
  /** `anthropic` lets OneCLI own header injection; `generic` needs the header. */
  secretType: 'anthropic' | 'generic';
  headerName?: string;
  valueFormat?: string;
  defaultModel: string;
  secretName: string;
}

/** Curated backends — the common picks. Keep host patterns in sync with the skill. */
export const BACKENDS: OpenCodeBackend[] = [
  {
    value: 'openrouter',
    label: 'OpenRouter',
    hint: 'one key, hundreds of models',
    providerId: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    hostPattern: 'openrouter.ai',
    secretType: 'generic',
    headerName: 'Authorization',
    valueFormat: 'Bearer {value}',
    defaultModel: 'openrouter/anthropic/claude-sonnet-4.6',
    secretName: 'OpenCode (OpenRouter)',
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    hint: 'cheap, strong coding models',
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    hostPattern: 'api.deepseek.com',
    secretType: 'generic',
    headerName: 'Authorization',
    valueFormat: 'Bearer {value}',
    defaultModel: 'deepseek/deepseek-v4-flash',
    secretName: 'OpenCode (DeepSeek)',
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    hint: 'Claude models directly',
    providerId: 'anthropic',
    hostPattern: 'api.anthropic.com',
    secretType: 'anthropic',
    defaultModel: 'anthropic/claude-sonnet-4-6',
    secretName: 'OpenCode (Anthropic)',
  },
  {
    value: 'zen',
    label: 'OpenCode Zen',
    hint: 'OpenCode-hosted models (x-api-key)',
    providerId: 'opencode',
    baseUrl: 'https://opencode.ai/zen/v1',
    hostPattern: 'opencode.ai',
    secretType: 'generic',
    headerName: 'x-api-key',
    valueFormat: '{value}',
    defaultModel: 'opencode/claude-sonnet-4-6',
    secretName: 'OpenCode (Zen)',
  },
];

/** `onecli secrets create` args for a backend + key. Pure — the auth flow's self-check. */
export function buildSecretArgs(backend: OpenCodeBackend, key: string): string[] {
  const args = [
    'secrets',
    'create',
    '--name',
    backend.secretName,
    '--type',
    backend.secretType,
    '--value',
    key,
    '--host-pattern',
    backend.hostPattern,
  ];
  if (backend.secretType === 'generic') {
    args.push('--header-name', backend.headerName!, '--value-format', backend.valueFormat!);
  }
  return args;
}

interface OnecliSecret {
  hostPattern: string | null;
}

/** True if the vault already holds a secret scoped to this host (idempotency guard). */
function secretExistsForHost(hostPattern: string): boolean {
  try {
    const out = execFileSync('onecli', ['secrets', 'list'], { encoding: 'utf-8' });
    const parsed = JSON.parse(out) as { data?: unknown };
    const secrets = Array.isArray(parsed.data) ? (parsed.data as OnecliSecret[]) : [];
    return secrets.some((s) => (s.hostPattern ?? '').toLowerCase() === hostPattern.toLowerCase());
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

async function askText(message: string, initialValue?: string): Promise<string> {
  return ensureAnswer(
    await p.text({ message, initialValue, validate: (v) => (v && v.trim() ? undefined : 'Required.') }),
  ).trim();
}

/** Resolve "Something else" into a backend from interactive answers. */
async function buildCustomBackend(): Promise<OpenCodeBackend> {
  const baseUrl = await askText('Backend base URL', 'https://');
  const providerId = await askText('OpenCode provider id (OPENCODE_PROVIDER)');
  const defaultModel = await askText('Model id (provider/model form)', `${providerId}/`);
  const headerStyle = ensureAnswer(
    await brightSelect<'bearer' | 'xapikey'>({
      message: 'How is the key sent?',
      options: [
        { value: 'bearer', label: 'Authorization: Bearer <key>', hint: 'most providers' },
        { value: 'xapikey', label: 'x-api-key: <key>', hint: 'Anthropic-style' },
      ],
      initialValue: 'bearer',
    }),
  );
  let hostPattern: string;
  try {
    hostPattern = new URL(baseUrl).host;
  } catch {
    hostPattern = await askText('Host pattern for the key (e.g. api.example.com)');
  }
  return {
    value: 'custom',
    label: 'Something else',
    hint: '',
    providerId,
    baseUrl,
    hostPattern,
    secretType: 'generic',
    headerName: headerStyle === 'xapikey' ? 'x-api-key' : 'Authorization',
    valueFormat: headerStyle === 'xapikey' ? '{value}' : 'Bearer {value}',
    defaultModel,
    secretName: `OpenCode (${hostPattern})`,
  };
}

export async function runOpenCodeAuth(): Promise<void> {
  const pick = ensureAnswer(
    await brightSelect<string>({
      message: 'Which backend should OpenCode use?',
      options: [
        ...BACKENDS.map((b) => ({ value: b.value, label: b.label, hint: b.hint })),
        { value: 'custom', label: 'Something else', hint: 'any OpenAI/Anthropic-compatible API' },
      ],
      initialValue: 'openrouter',
    }),
  );
  setupLog.userInput('opencode_backend', pick);

  const backend = pick === 'custom' ? await buildCustomBackend() : BACKENDS.find((b) => b.value === pick)!;
  const model = await askText(`Model for ${backend.label}`, backend.defaultModel);

  // Routing config to .env (read on the host, passed into the container).
  upsertEnvKey('OPENCODE_PROVIDER', backend.providerId);
  upsertEnvKey('OPENCODE_MODEL', model);
  upsertEnvKey('OPENCODE_SMALL_MODEL', model);
  if (backend.baseUrl) upsertEnvKey('ANTHROPIC_BASE_URL', backend.baseUrl);

  if (secretExistsForHost(backend.hostPattern)) {
    setupLog.step('auth', 'skipped', 0, { PROVIDER: 'opencode', REASON: 'secret-already-present' });
    p.log.success(brandBody(`${backend.label} key already in your vault — routing config updated.`));
    return;
  }

  const key = ensureAnswer(
    await p.password({
      message: `Paste your ${backend.label} API key`,
      validate: (v) => (v && v.trim() ? undefined : 'Required.'),
    }),
  ).trim();

  try {
    execFileSync('onecli', buildSecretArgs(backend, key), { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    setupLog.step('auth', 'failed', 0, { PROVIDER: 'opencode', BACKEND: backend.value, ERROR: String(err) });
    p.log.error(
      brandBody("Couldn't save your key to the vault. Make sure OneCLI is running (`onecli version`), then retry."),
    );
    process.exit(1);
  }
  setupLog.step('auth', 'success', 0, { PROVIDER: 'opencode', BACKEND: backend.value });
  p.log.success(brandBody(`${backend.label} connected — key lives in your OneCLI vault, never in the container.`));
}

// ─── install verification ────────────────────────────────────────────────

/**
 * Verify the opencode provider payload is wired — provider files, both runtime
 * barrels, and the CLI in the container manifest. Mirrors `verifyCodexInstall`.
 */
export function verifyOpenCodeInstall(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const root = process.cwd();

  const requiredFiles = ['src/providers/opencode.ts', 'container/agent-runner/src/providers/opencode.ts'];
  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`missing file: ${file}`);
  }

  for (const barrel of ['src/providers/index.ts', 'container/agent-runner/src/providers/index.ts']) {
    const barrelPath = path.join(root, barrel);
    if (!fs.existsSync(barrelPath) || !fs.readFileSync(barrelPath, 'utf-8').includes("import './opencode.js';")) {
      problems.push(`missing barrel import in ${barrel}`);
    }
  }

  const manifestPath = path.join(root, 'container', 'cli-tools.json');
  let hasCli = false;
  if (fs.existsSync(manifestPath)) {
    try {
      const tools = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Array<{ name?: string }>;
      hasCli = Array.isArray(tools) && tools.some((t) => t.name === 'opencode-ai');
    } catch {
      hasCli = false;
    }
  }
  if (!hasCli) problems.push('container/cli-tools.json missing the opencode-ai CLI entry');

  return { ok: problems.length === 0, problems };
}

export async function runOpenCodeInstallCheck(): Promise<void> {
  p.log.step(brandBody('Checking the OpenCode provider install…'));
  const { ok, problems } = verifyOpenCodeInstall();
  if (ok) {
    setupLog.step('opencode-install', 'success', 0, {});
    p.log.success(brandBody('OpenCode installed properly.'));
    return;
  }

  setupLog.step('opencode-install', 'failed', 0, { PROBLEMS: problems.join('; ') });
  p.log.warn(brandBody('The OpenCode provider is not fully installed:'));
  for (const problem of problems) console.log(k.dim(`   • ${problem}`));
  p.log.warn(
    brandBody(
      'Finish it with your coding agent: open Claude Code or Codex in this repo and run the /add-opencode skill. Setup will continue — OpenCode groups will work once the install completes.',
    ),
  );
}

// Self-registration: the setup picker and the standalone `provider-auth` step
// render from the registry — this call is opencode's only reach-in to the
// setup flow (guarded by the barrel-driven registration test).
registerSetupProvider({
  value: 'opencode',
  label: 'OpenCode',
  hint: 'OpenRouter / DeepSeek / Anthropic / Zen — API key',
  runAuth: runOpenCodeAuth,
  runInstallCheck: runOpenCodeInstallCheck,
});
