/**
 * Plugin-owned MCP servers are template content: the config verbs must refuse
 * to overwrite or delete them (the sanctioned change path is `groups
 * restamp`), while servers without the marker stay fully editable. Runs
 * through dispatch() with the host caller — the same path an approved agent
 * request replays through.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-cli-plugin-guard';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-test-cli-plugin-guard/groups',
  DATA_DIR: '/tmp/nanoclaw-test-cli-plugin-guard/data',
  TEMPLATES_DIR: '/tmp/nanoclaw-test-cli-plugin-guard/templates',
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { NANOCLAW_EXTENSION_NS } from '../../templates/extension.js';
import { MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL } from '../../templates/manifest.js';
import { createAgentFromTemplate } from '../../templates/create-agent.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands.
import './groups.js';

function writeTemplate(): void {
  const tpl = path.join(TEST_ROOT, 'templates', 'sdr');
  fs.mkdirSync(path.join(tpl, NANOCLAW_EXTENSION_NS, 'context'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'sdr' }));
  fs.writeFileSync(path.join(tpl, NANOCLAW_EXTENSION_NS, 'context', 'instructions.md'), 'You are an SDR agent.\n');
  fs.writeFileSync(
    path.join(tpl, 'mcp.json'),
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: { docs: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' } },
    }),
  );
}

async function run(command: string, args: Record<string, unknown>) {
  return dispatch({ id: 'req-1', command, args }, { caller: 'host' });
}

let groupId: string;

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
  writeTemplate();
  groupId = createAgentFromTemplate('sdr', { name: 'SDR' }).group.id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('plugin-owned MCP server guard (ncl groups config)', () => {
  it('refuses to overwrite a plugin-owned server', async () => {
    const res = await run('groups-config-add-mcp-server', {
      id: groupId,
      name: 'docs',
      url: 'https://evil.example.com/mcp',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/owned by plugin "sdr".*restamp/);
    expect(JSON.parse(getContainerConfig(groupId)!.mcp_servers).docs.url).toBe('https://mcp.example.com/mcp');
  });

  it('refuses to remove a plugin-owned server', async () => {
    const res = await run('groups-config-remove-mcp-server', { id: groupId, name: 'docs' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/owned by plugin "sdr"/);
    expect(JSON.parse(getContainerConfig(groupId)!.mcp_servers).docs).toBeDefined();
  });

  it('leaves unmarked servers fully editable', async () => {
    const added = await run('groups-config-add-mcp-server', {
      id: groupId,
      name: 'mine',
      url: 'https://mine.example.com/mcp',
    });
    expect(added.ok).toBe(true);
    const removed = await run('groups-config-remove-mcp-server', { id: groupId, name: 'mine' });
    expect(removed.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(groupId)!.mcp_servers).mine).toBeUndefined();
  });
});

describe('ncl groups restamp', () => {
  it('is a dry run without --yes and applies with it', async () => {
    fs.writeFileSync(
      path.join(TEST_ROOT, 'templates', 'sdr', NANOCLAW_EXTENSION_NS, 'context', 'instructions.md'),
      'You are an SDR agent v2.\n',
    );

    const dryRun = await run('groups-restamp', { id: groupId, template: 'sdr' });
    expect(dryRun.ok).toBe(true);
    if (dryRun.ok) {
      expect(dryRun.data).toMatchObject({ applied: false });
      expect(dryRun.human).toMatch(/DRY RUN/);
    }

    const applied = await run('groups-restamp', { id: groupId, template: 'sdr', yes: true });
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.data).toMatchObject({ applied: true });
  });

  it('rejects unknown flags via strict arg validation', async () => {
    const res = await run('groups-restamp', { id: groupId, template: 'sdr', force: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/unknown flag --force/);
  });
});
