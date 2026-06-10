/**
 * Proves the guardrails module registers its hooks at import time. The
 * mount contributor is the one registration with a pure, DB-free observable
 * (gates need adapter/DB state and have their own behavior suites), so it
 * stands in for "the barrel import wired the module".
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { runMountContributors } from '../../module-hooks.js';
import type { AgentGroup, Session } from '../../types.js';
import './index.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function groupDirWith(guardrails: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-reg-'));
  tmpDirs.push(dir);
  if (guardrails) fs.mkdirSync(path.join(dir, 'guardrails'));
  return dir;
}

const agentGroup: AgentGroup = {
  id: 'ag-1',
  name: 'Test',
  folder: 'test',
  agent_provider: null,
  created_at: '2026-01-01T00:00:00Z',
};

const session: Session = {
  id: 's-1',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-1',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'idle',
  last_active: null,
  created_at: '2026-01-01T00:00:00Z',
};

describe('guardrails registration', () => {
  it('contributes an RO mount when the group has a guardrails dir', () => {
    const groupDir = groupDirWith(true);
    const mounts = runMountContributors({ agentGroup, session, groupDir });
    expect(mounts).toContainEqual({
      hostPath: path.join(groupDir, 'guardrails'),
      containerPath: '/workspace/agent/guardrails',
      readonly: true,
    });
  });

  it('contributes nothing for a group without a guardrails dir', () => {
    const groupDir = groupDirWith(false);
    expect(runMountContributors({ agentGroup, session, groupDir })).toEqual([]);
  });
});

describe('shared rules.ts (anti-drift)', () => {
  it('host and container copies are byte-identical', () => {
    const read = (rel: string): string => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
    expect(
      read('src/modules/guardrails/rules.ts'),
      'src/modules/guardrails/rules.ts and container/agent-runner/src/guardrails/rules.ts have drifted — ' +
        'they are hand-maintained duplicates by design (the trees share no modules); mirror the edit to both',
    ).toBe(read('container/agent-runner/src/guardrails/rules.ts'));
  });
});
