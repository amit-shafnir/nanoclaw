/** Setup-only discovery for the fixed NanoClaw template registry. */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { normalizeName } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { resolveLocalTemplate } from '../src/templates/local-dir.js';
import type { AgentGroup } from '../src/types.js';

export const DEFAULT_TEMPLATES_SOURCE = 'https://github.com/nanocoai/nanoclaw-templates';

export interface TemplateEntry {
  ref: string;
  name: string;
}

export interface ClonedRegistry {
  dir: string;
  cleanup: () => void;
}

type RunNcl = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export type TemplateAgentInstallResult = { status: 'installed'; group: AgentGroup } | { status: 'cancelled' };

export interface TemplateAgentInstallOptions {
  ref: string;
  name: string;
  timezone?: string;
  provider?: string;
  projectRoot: string;
  runNcl: RunNcl;
  confirmReplace: (existing: AgentGroup) => Promise<boolean>;
}

// A directory is a template iff it is an Agent Plugins directory — the
// manifest is the discovery marker. The pre-plugin layout is detected only to
// point the operator at a re-fetch.
const MARKER = 'plugin.json';
const LEGACY_MARKER = 'context/instructions.md';

export function cloneRegistry(): ClonedRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tpl-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', '--', DEFAULT_TEMPLATES_SOURCE, dir], {
      stdio: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('Could not clone the template library', { cause: err });
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function listTemplatesFromDir(dir: string): TemplateEntry[] {
  if (!fs.existsSync(dir)) return [];
  const rootName = path.basename(path.resolve(dir));
  const rels = (fs.readdirSync(dir, { recursive: true }) as string[]).map((entry) =>
    entry.split(path.sep).join('/'),
  );

  const refs = new Set<string>();
  for (const rel of rels) {
    if (rel === MARKER) refs.add('.');
    else if (rel.endsWith(`/${MARKER}`)) refs.add(rel.slice(0, -(MARKER.length + 1)));
  }

  // A context/instructions.md outside any plugin is the pre-plugin template
  // layout. Fail with a pointer instead of silently listing nothing. (The
  // same file INSIDE a plugin — e.g. ai.nanoco.nanoclaw/context/ — is fine.)
  const legacy = rels
    .filter((rel) => rel === LEGACY_MARKER || rel.endsWith(`/${LEGACY_MARKER}`))
    .map((rel) => (rel === LEGACY_MARKER ? '.' : rel.slice(0, -(LEGACY_MARKER.length + 1))))
    .filter((ref) => !isWithinTemplate(ref, refs));
  if (legacy.length > 0) {
    throw new Error(
      `Templates predate the plugin format (no ${MARKER}): ${legacy.join(', ')}. ` +
        'Re-fetch the template library (and update NanoClaw if fetching does not help).',
    );
  }

  return [...refs]
    .map((ref) => ({ ref, name: ref === '.' ? rootName : (ref.split('/').pop() ?? ref) }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

/** True when `ref` equals or sits anywhere below a discovered template ref. */
function isWithinTemplate(ref: string, templateRefs: Set<string>): boolean {
  if (templateRefs.has('.')) return true;
  for (let current = ref; ; ) {
    if (templateRefs.has(current)) return true;
    const cut = current.lastIndexOf('/');
    if (cut === -1) return false;
    current = current.slice(0, cut);
  }
}

/** Copy a list-derived registry template into the local template library. */
export function copyTemplate(srcDir: string, ref: string, destDir: string): string {
  if (ref === '.') throw new Error('Cannot copy the registry root as a template');
  const from = resolveLocalTemplate(ref, srcDir);
  const to = path.resolve(destDir, ref);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
  return to;
}

/** Stamp the setup-selected template through the same ncl command used after setup. */
export async function installTemplateAgent(options: TemplateAgentInstallOptions): Promise<TemplateAgentInstallResult> {
  const groups = parseAgentGroups(await options.runNcl('groups-list', {}));
  const expectedFolder = normalizeName(options.name);
  const existing = groups.find(
    (group) =>
      group.folder === expectedFolder ||
      group.name.localeCompare(options.name, undefined, { sensitivity: 'accent' }) === 0,
  );

  if (existing && !(await options.confirmReplace(existing))) {
    return { status: 'cancelled' };
  }

  let created: AgentGroup | undefined;
  let replacementCommitted = false;
  try {
    created = parseAgentGroup(
      await options.runNcl('groups-create', {
        template: options.ref,
        name: options.name,
        ...(options.timezone ? { timezone: options.timezone } : {}),
      }),
    );

    if (options.provider) {
      await options.runNcl('groups-config-update', {
        id: created.id,
        provider: options.provider,
      });
    }

    if (existing) {
      await options.runNcl('groups-restart', { id: existing.id });
      await options.runNcl('groups-delete', { id: existing.id });
      replacementCommitted = true;
      removeGroupFiles(options.projectRoot, existing);
    }
  } catch (error) {
    if (created && !replacementCommitted) await removeCreatedGroup(options, created);
    throw error;
  }

  if (!created) throw new Error('ncl did not create the template agent');
  return { status: 'installed', group: created };
}

async function removeCreatedGroup(options: TemplateAgentInstallOptions, group: AgentGroup): Promise<void> {
  try {
    await options.runNcl('groups-delete', { id: group.id });
    removeGroupFiles(options.projectRoot, group);
  } catch {
    // Preserve the original setup failure; cleanup is best effort.
  }
}

function removeGroupFiles(projectRoot: string, group: AgentGroup): void {
  fs.rmSync(path.join(projectRoot, 'groups', group.folder), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(projectRoot, 'data', 'v2-sessions', group.id), {
    recursive: true,
    force: true,
  });
}

function parseAgentGroups(value: unknown): AgentGroup[] {
  if (!Array.isArray(value)) throw new Error('ncl groups list returned an invalid response');
  return value.map(parseAgentGroup);
}

function parseAgentGroup(value: unknown): AgentGroup {
  if (!isRecord(value)) throw new Error('ncl returned an invalid agent group');
  const { id, name, folder, agent_provider: provider, created_at: createdAt } = value;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof folder !== 'string' ||
    (provider !== null && typeof provider !== 'string') ||
    typeof createdAt !== 'string'
  ) {
    throw new Error('ncl returned an invalid agent group');
  }
  return { id, name, folder, agent_provider: provider, created_at: createdAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
