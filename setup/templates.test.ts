import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentGroup } from '../src/types.js';
import { copyTemplate, installTemplateAgent, listTemplatesFromDir } from './templates.js';

describe('setup template library', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-templates-'));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds nested templates by plugin.json and copies one without git metadata', () => {
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    fs.mkdirSync(path.join(source, 'sales', 'sdr'), { recursive: true });
    fs.writeFileSync(path.join(source, 'sales', 'sdr', 'plugin.json'), '{"name":"sdr"}');
    // A context/instructions.md INSIDE a plugin (the NanoClaw extension dir)
    // must not trip the legacy detection.
    fs.mkdirSync(path.join(source, 'sales', 'sdr', 'ai.nanoco.nanoclaw', 'context'), { recursive: true });
    fs.writeFileSync(
      path.join(source, 'sales', 'sdr', 'ai.nanoco.nanoclaw', 'context', 'instructions.md'),
      'Sell well.',
    );
    fs.mkdirSync(path.join(source, 'sales', 'sdr', '.git'), { recursive: true });
    fs.writeFileSync(path.join(source, 'sales', 'sdr', '.git', 'config'), 'ignored');

    expect(listTemplatesFromDir(source)).toEqual([{ ref: 'sales/sdr', name: 'sdr' }]);

    copyTemplate(source, 'sales/sdr', destination);
    expect(fs.readFileSync(path.join(destination, 'sales', 'sdr', 'plugin.json'), 'utf8')).toBe('{"name":"sdr"}');
    expect(fs.existsSync(path.join(destination, 'sales', 'sdr', '.git'))).toBe(false);
    expect(() => copyTemplate(source, '../escape', destination)).toThrow('escapes the templates directory');
  });

  it('emits the migration error for a pre-plugin template layout', () => {
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'sales', 'sdr', 'context'), { recursive: true });
    fs.writeFileSync(path.join(source, 'sales', 'sdr', 'context', 'instructions.md'), 'Sell well.');

    expect(() => listTemplatesFromDir(source)).toThrow(/predate the plugin format.*sales\/sdr.*Re-fetch/s);
  });

  it('creates through ncl, then replaces the confirmed conflicting agent', async () => {
    const existing: AgentGroup = {
      id: 'ag-old',
      name: 'SDR',
      folder: 'sdr',
      agent_provider: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const created: AgentGroup = {
      id: 'ag-new',
      name: 'SDR',
      folder: 'sdr-a1b2c3d4',
      agent_provider: null,
      created_at: '2026-01-02T00:00:00.000Z',
    };
    fs.mkdirSync(path.join(root, 'groups', existing.folder), { recursive: true });
    fs.mkdirSync(path.join(root, 'data', 'v2-sessions', existing.id), { recursive: true });

    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const result = await installTemplateAgent({
      ref: 'sales/sdr',
      name: 'SDR',
      timezone: 'Asia/Jerusalem',
      provider: 'codex',
      projectRoot: root,
      runNcl: async (command, args) => {
        calls.push({ command, args });
        if (command === 'groups-list') return [existing];
        if (command === 'groups-create') return created;
        return {};
      },
      confirmReplace: async () => true,
    });

    expect(result).toEqual({ status: 'installed', group: created });
    expect(calls).toEqual([
      { command: 'groups-list', args: {} },
      {
        command: 'groups-create',
        args: { template: 'sales/sdr', name: 'SDR', timezone: 'Asia/Jerusalem' },
      },
      {
        command: 'groups-config-update',
        args: { id: 'ag-new', provider: 'codex' },
      },
      { command: 'groups-restart', args: { id: 'ag-old' } },
      { command: 'groups-delete', args: { id: 'ag-old' } },
    ]);
    expect(fs.existsSync(path.join(root, 'groups', existing.folder))).toBe(false);
    expect(fs.existsSync(path.join(root, 'data', 'v2-sessions', existing.id))).toBe(false);
  });

  it('parses list rows without agent_provider (the groups resource projection)', async () => {
    // The real `ncl groups list` projects only id/name/folder/created_at —
    // rows carry no agent_provider key. A prior wizard step (cli-agent)
    // guarantees the list is never empty, so this shape always reaches the
    // parser in a live run.
    const listRow = {
      id: 'ag-terminal',
      name: 'Terminal Agent',
      folder: '_ping-test',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const created: AgentGroup = {
      id: 'ag-new',
      name: 'Journalist',
      folder: 'journalist',
      agent_provider: null,
      created_at: '2026-01-02T00:00:00.000Z',
    };

    const result = await installTemplateAgent({
      ref: 'media/journalist',
      name: 'Journalist',
      projectRoot: root,
      runNcl: async (command) => {
        if (command === 'groups-list') return [listRow];
        if (command === 'groups-create') return created;
        return {};
      },
      confirmReplace: async () => {
        throw new Error('no conflict expected');
      },
    });

    expect(result).toEqual({ status: 'installed', group: created });
  });

  it('cancels template installation when replacement is declined', async () => {
    const existing: AgentGroup = {
      id: 'ag-old',
      name: 'SDR',
      folder: 'sdr',
      agent_provider: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const calls: string[] = [];
    const result = await installTemplateAgent({
      ref: 'sales/sdr',
      name: 'SDR',
      projectRoot: root,
      runNcl: async (command) => {
        calls.push(command);
        return [existing];
      },
      confirmReplace: async () => false,
    });

    expect(result).toEqual({ status: 'cancelled' });
    expect(calls).toEqual(['groups-list']);
  });

  it('keeps the existing agent when the replacement cannot be created', async () => {
    const existing: AgentGroup = {
      id: 'ag-old',
      name: 'SDR',
      folder: 'sdr',
      agent_provider: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    fs.mkdirSync(path.join(root, 'groups', existing.folder), { recursive: true });

    await expect(
      installTemplateAgent({
        ref: 'sales/sdr',
        name: 'SDR',
        projectRoot: root,
        runNcl: async (command) => {
          if (command === 'groups-list') return [existing];
          throw new Error('invalid template task');
        },
        confirmReplace: async () => true,
      }),
    ).rejects.toThrow('invalid template task');

    expect(fs.existsSync(path.join(root, 'groups', existing.folder))).toBe(true);
  });

  it('keeps setup and ncl on the same template stamper', () => {
    const setup = fs.readFileSync(path.join(process.cwd(), 'setup', 'templates.ts'), 'utf8');
    const wiring = fs.readFileSync(path.join(process.cwd(), 'scripts', 'init-first-agent.ts'), 'utf8');
    const groups = fs.readFileSync(path.join(process.cwd(), 'src/cli/resources/groups.ts'), 'utf8');
    expect(setup).toContain("options.runNcl('groups-create'");
    expect(groups).toContain('createAgentFromTemplate(String(args.template)');
    expect(wiring).toContain('getAgentGroup(args.agentGroupId)');
  });

  it('keeps a deferred template agent selectable by the later wiring skill', () => {
    const skill = fs.readFileSync(
      path.join(process.cwd(), '.claude', 'skills', 'init-first-agent', 'SKILL.md'),
      'utf8',
    );
    expect(skill).toContain('ncl groups list --json');
    expect(skill).toContain('ncl wirings list --json');
    expect(skill).toContain('--agent-group-id "${AGENT_GROUP_ID}"');
  });
});
