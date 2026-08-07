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

const MARKER = 'context/instructions.md';

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
  return fs
    .readdirSync(dir, { recursive: true })
    .map((entry): TemplateEntry | null => {
      const rel = entry.split(path.sep).join('/');
      if (rel === MARKER) return { ref: '.', name: rootName };
      if (!rel.endsWith(`/${MARKER}`)) return null;
      const ref = rel.slice(0, -(MARKER.length + 1));
      return { ref, name: ref.split('/').pop() ?? ref };
    })
    .filter((entry): entry is TemplateEntry => entry !== null)
    .sort((a, b) => a.ref.localeCompare(b.ref));
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
