/**
 * create_agent forwards the optional `provider` arg into the outbound system
 * row (and only when set). The host reads it from there to gate cross-provider
 * creation — dropping it here would silently fall back to same-provider.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { createAgent } from './agents.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function lastCreateAgentPayload(): Record<string, unknown> {
  const out = getUndeliveredMessages();
  expect(out).toHaveLength(1);
  return JSON.parse(out[0].content) as Record<string, unknown>;
}

describe('create_agent MCP tool — provider passthrough', () => {
  it('includes provider when the arg is set', async () => {
    await createAgent.handler({ name: 'Scout', provider: 'codex' });
    expect(lastCreateAgentPayload()).toMatchObject({ action: 'create_agent', name: 'Scout', provider: 'codex' });
  });

  it('omits provider when the arg is absent', async () => {
    await createAgent.handler({ name: 'Scout' });
    expect(lastCreateAgentPayload()).not.toHaveProperty('provider');
  });
});
