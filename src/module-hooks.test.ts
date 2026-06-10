/**
 * Seam tests for the module hook registries: empty registries are exact
 * no-ops (trunk behavior unchanged), hooks run in registration order, and
 * the first gate refusal short-circuits.
 *
 * Each test imports a fresh copy of the module so registrations never leak
 * between cases.
 */
import { describe, expect, it, vi } from 'vitest';

import type { InboundGateContext, MountContext, OutboundGateContext } from './module-hooks.js';

async function freshHooks(): Promise<typeof import('./module-hooks.js')> {
  vi.resetModules();
  return import('./module-hooks.js');
}

function inboundCtx(): InboundGateContext {
  return {
    event: {
      channelType: 'test',
      platformId: 'chat-1',
      threadId: null,
      message: { id: 'm1', kind: 'chat', content: '{"text":"hi"}', timestamp: '2026-01-01T00:00:00Z' },
    },
    userId: null,
    mg: {
      id: 'mg-1',
      channel_type: 'test',
      platform_id: 'chat-1',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: '2026-01-01T00:00:00Z',
    },
    agentGroup: { id: 'ag-1', name: 'Test', folder: 'test', agent_provider: null, created_at: '2026-01-01T00:00:00Z' },
    session: sessionFixture(),
    deliveryAddr: { channelType: 'test', platformId: 'chat-1', threadId: null },
  };
}

function sessionFixture(): OutboundGateContext['session'] {
  return {
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
}

function outboundCtx(): OutboundGateContext {
  return {
    msg: {
      id: 'out-1',
      kind: 'chat',
      platform_id: 'chat-1',
      channel_type: 'test',
      thread_id: null,
      content: '{"text":"hello"}',
      in_reply_to: null,
    },
    session: sessionFixture(),
  };
}

function mountCtx(): MountContext {
  return { agentGroup: inboundCtx().agentGroup, session: sessionFixture(), groupDir: '/tmp/groups/test' };
}

describe('inbound message gates', () => {
  it('allows when nothing is registered', async () => {
    const hooks = await freshHooks();
    await expect(hooks.runInboundMessageGates(inboundCtx())).resolves.toBe(true);
  });

  it('runs gates in registration order and supports async gates', async () => {
    const hooks = await freshHooks();
    const order: string[] = [];
    hooks.registerInboundMessageGate(async () => {
      order.push('first');
      return true;
    });
    hooks.registerInboundMessageGate(() => {
      order.push('second');
      return true;
    });
    await expect(hooks.runInboundMessageGates(inboundCtx())).resolves.toBe(true);
    expect(order).toEqual(['first', 'second']);
  });

  it('short-circuits on the first refusal', async () => {
    const hooks = await freshHooks();
    const later = vi.fn(() => true);
    hooks.registerInboundMessageGate(() => false);
    hooks.registerInboundMessageGate(later);
    await expect(hooks.runInboundMessageGates(inboundCtx())).resolves.toBe(false);
    expect(later).not.toHaveBeenCalled();
  });
});

describe('outbound message gates', () => {
  it('allows when nothing is registered', async () => {
    const hooks = await freshHooks();
    await expect(hooks.runOutboundMessageGates(outboundCtx())).resolves.toBe(true);
  });

  it('short-circuits on the first refusal', async () => {
    const hooks = await freshHooks();
    const later = vi.fn(() => true);
    hooks.registerOutboundMessageGate(async () => false);
    hooks.registerOutboundMessageGate(later);
    await expect(hooks.runOutboundMessageGates(outboundCtx())).resolves.toBe(false);
    expect(later).not.toHaveBeenCalled();
  });
});

describe('mount contributors', () => {
  it('returns no mounts when nothing is registered', async () => {
    const hooks = await freshHooks();
    expect(hooks.runMountContributors(mountCtx())).toEqual([]);
  });

  it('concatenates contributions in registration order', async () => {
    const hooks = await freshHooks();
    hooks.registerMountContributor(({ groupDir }) => [
      { hostPath: `${groupDir}/a`, containerPath: '/a', readonly: true },
    ]);
    hooks.registerMountContributor(() => []);
    hooks.registerMountContributor(() => [{ hostPath: '/b', containerPath: '/b', readonly: false }]);
    expect(hooks.runMountContributors(mountCtx())).toEqual([
      { hostPath: '/tmp/groups/test/a', containerPath: '/a', readonly: true },
      { hostPath: '/b', containerPath: '/b', readonly: false },
    ]);
  });
});
