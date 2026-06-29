import { describe, expect, it } from 'vitest';

import { configFromDb } from './container-config.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

function row(overrides: Partial<ContainerConfigRow> = {}): ContainerConfigRow {
  return {
    agent_group_id: 'ag-1',
    provider: null,
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: '"all"',
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    cli_scope: 'group',
    env: '{}',
    blocked_hosts: '[]',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const group: AgentGroup = {
  id: 'ag-1',
  name: 'Test',
  folder: 'test',
  agent_provider: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('configFromDb env/blockedHosts', () => {
  it('parses the env + blocked_hosts JSON columns', () => {
    const config = configFromDb(
      row({
        env: '{"ANTHROPIC_BASE_URL":"http://host.docker.internal:11434"}',
        blocked_hosts: '["api.anthropic.com"]',
      }),
      group,
    );
    expect(config.env).toEqual({ ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434' });
    expect(config.blockedHosts).toEqual(['api.anthropic.com']);
  });

  it('defaults to an empty env map + blocked-hosts list', () => {
    const config = configFromDb(row(), group);
    expect(config.env).toEqual({});
    expect(config.blockedHosts).toEqual([]);
  });
});
