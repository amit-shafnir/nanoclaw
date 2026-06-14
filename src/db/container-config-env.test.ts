/**
 * Per-group env + blocked_hosts columns (migration 017 + container-configs DB layer).
 *
 * Covers: the columns are added NOT NULL with empty-JSON defaults; ensure/update
 * round-trips through getContainerConfig; and an existing pre-017 row is
 * backfilled with the defaults (no data loss, no crash) when 017 applies.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from './container-configs.js';
import { initTestDb, closeDb, getDb } from './connection.js';
import { runMigrations, migrations } from './migrations/index.js';

function now(): string {
  return new Date().toISOString();
}

function seedGroup(id = 'ag-1'): void {
  getDb()
    .prepare('INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)')
    .run(id, 'A', id, now());
}

afterEach(() => {
  closeDb();
});

describe('migration 017 — fresh DB', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
  });

  it('adds NOT NULL env + blocked_hosts columns', () => {
    const cols = getDb().prepare("PRAGMA table_info('container_configs')").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const env = cols.find((c) => c.name === 'env');
    const blocked = cols.find((c) => c.name === 'blocked_hosts');
    expect(env).toBeDefined();
    expect(env!.notnull).toBe(1);
    expect(blocked).toBeDefined();
    expect(blocked!.notnull).toBe(1);
  });

  it('ensureContainerConfig seeds empty env + blocked_hosts from the column defaults', () => {
    seedGroup();
    ensureContainerConfig('ag-1');
    const cfg = getContainerConfig('ag-1');
    expect(cfg!.env).toBe('{}');
    expect(cfg!.blocked_hosts).toBe('[]');
  });

  it('updateContainerConfigJson round-trips env + blocked_hosts', () => {
    seedGroup();
    ensureContainerConfig('ag-1');
    updateContainerConfigJson('ag-1', 'env', { ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434' });
    updateContainerConfigJson('ag-1', 'blocked_hosts', ['api.anthropic.com']);
    const cfg = getContainerConfig('ag-1');
    expect(JSON.parse(cfg!.env)).toEqual({ ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434' });
    expect(JSON.parse(cfg!.blocked_hosts)).toEqual(['api.anthropic.com']);
  });
});

describe('migration 017 — upgrade arm', () => {
  it('backfills defaults on a pre-017 container_configs row', () => {
    const db = initTestDb();
    runMigrations(
      db,
      migrations.filter((m) => m.name !== 'ollama-env'),
    );
    const preCols = db.prepare("PRAGMA table_info('container_configs')").all() as Array<{ name: string }>;
    expect(preCols.some((c) => c.name === 'env')).toBe(false);

    // Seed a config row on the old schema (no env/blocked_hosts columns yet).
    db.prepare("INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-1','A','a',?)").run(now());
    db.prepare("INSERT INTO container_configs (agent_group_id, updated_at) VALUES ('ag-1', ?)").run(now());

    expect(() => runMigrations(db)).not.toThrow();

    const cfg = getContainerConfig('ag-1');
    expect(cfg!.env).toBe('{}');
    expect(cfg!.blocked_hosts).toBe('[]');
  });
});
