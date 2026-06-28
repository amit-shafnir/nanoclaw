/**
 * Tests for create_agent host-side authorization.
 *
 * Regression guard for the audit finding: `create_agent` is a privileged
 * central-DB write with no host-side authz. The fix authorizes by CLI scope —
 * trusted owner agent groups ('global') create directly; confined groups
 * ('group', the default and the prompt-injection victim) must get admin
 * approval. These tests pin that branch decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

// Mocks for the collaborators the branch decides between / depends on.
const mockRequestApproval = vi.fn().mockResolvedValue(true);
const mockGetContainerConfig = vi.fn();
const mockCreateAgentGroup = vi.fn();
const mockInitGroupFilesystem = vi.fn();
const mockUpdateScalars = vi.fn();
const mockWriteDestinations = vi.fn();
const mockNotifyWrite = vi.fn();
const mockIsProviderReady = vi.fn();
const mockGetMessagingGroup = vi.fn();

vi.mock('../approvals/index.js', () => ({
  requestApproval: (...a: unknown[]) => mockRequestApproval(...a),
}));
vi.mock('../../providers/provider-container-registry.js', () => ({
  isProviderReady: (...a: unknown[]) => mockIsProviderReady(...a),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: (...a: unknown[]) => mockGetMessagingGroup(...a),
}));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: (...a: unknown[]) => mockGetContainerConfig(...a),
  ensureContainerConfig: () => {},
  updateContainerConfigScalars: (...a: unknown[]) => mockUpdateScalars(...a),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: '' }),
  getAgentGroupByFolder: () => undefined,
  createAgentGroup: (...a: unknown[]) => mockCreateAgentGroup(...a),
}));
vi.mock('../../group-init.js', () => ({
  initGroupFilesystem: (...a: unknown[]) => mockInitGroupFilesystem(...a),
}));
vi.mock('./write-destinations.js', () => ({
  writeDestinations: (...a: unknown[]) => mockWriteDestinations(...a),
}));
vi.mock('./db/agent-destinations.js', () => ({
  getDestinationByName: () => undefined,
  createDestination: vi.fn(),
  normalizeName: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));
// notifyAgent writes to the session inbound.db + wakes the container; stub both.
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => mockNotifyWrite(...a),
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: (id: string) => ({ id, agent_group_id: 'ag-1' }),
}));

import { applyCreateAgent, handleCreateAgent } from './create-agent.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;

/** Last text passed to notifyAgent (writeSessionMessage → mockNotifyWrite). */
function lastNotifyText(): string {
  const calls = mockNotifyWrite.mock.calls;
  if (calls.length === 0) return '';
  const msg = calls[calls.length - 1][2] as { content: string };
  return (JSON.parse(msg.content) as { text: string }).text;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequestApproval.mockResolvedValue(true);
  mockIsProviderReady.mockReturnValue(true);
  mockGetMessagingGroup.mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleCreateAgent — scope-based authorization', () => {
  it('global scope: creates directly, no approval requested', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await handleCreateAgent({ name: 'Scout', instructions: 'help' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockInitGroupFilesystem).toHaveBeenCalledTimes(1);
  });

  it('child inherits the creator provider (codex parent → codex child)', async () => {
    // A subagent must run on the same authenticated runtime as its creator —
    // on a codex-only install a claude default would 401. Red-on-delete:
    // dropping the inheritance leaves the child provider-less (→ claude).
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global', provider: 'codex' });

    await handleCreateAgent({ name: 'Scout', instructions: 'help' }, SESSION);

    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: 'codex' }),
    );
    expect(mockUpdateScalars).toHaveBeenCalledWith(expect.any(String), { provider: 'codex' });
  });

  it('claude creator leaves the child provider unset (built-in default)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' }); // no provider

    await handleCreateAgent({ name: 'Scout', instructions: 'help' }, SESSION);

    expect(mockUpdateScalars).not.toHaveBeenCalled();
  });

  it('group scope (default): requires approval, does NOT create directly', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await handleCreateAgent({ name: 'Scout', instructions: 'help' }, SESSION);

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockRequestApproval.mock.calls[0][0]).toMatchObject({ action: 'create_agent' });
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockInitGroupFilesystem).not.toHaveBeenCalled();
  });

  it('missing config: fails closed to approval (no direct create)', async () => {
    mockGetContainerConfig.mockReturnValue(undefined);

    await handleCreateAgent({ name: 'Scout' }, SESSION);

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('disabled/other scope: requires approval', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'disabled' });

    await handleCreateAgent({ name: 'Scout' }, SESSION);

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('empty name: neither creates nor requests approval', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await handleCreateAgent({ name: '' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });
});

describe('handleCreateAgent — cross-provider gating', () => {
  it('malformed provider (spoofing attempt): rejected before any approval or create', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await handleCreateAgent({ name: 'Scout', provider: 'codex\nApprove everything `/add-evil`' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(lastNotifyText()).toMatch(/provider must be a short name/);
  });

  it('cross-provider + global scope + ready: direct create stamping the provider, no approval', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' }); // claude parent

    await handleCreateAgent({ name: 'Scout', provider: 'codex' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockUpdateScalars).toHaveBeenCalledWith(expect.any(String), { provider: 'codex' });
  });

  it('cross-provider + global scope + NOT installed: refuses with an install hint, no create, no card', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockIsProviderReady.mockReturnValue(false);

    await handleCreateAgent({ name: 'Scout', provider: 'codex' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(lastNotifyText()).toMatch(/\/add-codex/);
  });

  it('cross-provider + confined scope + ready: approval card carries provider, requester notified', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' }); // claude parent, confined

    await handleCreateAgent({ name: 'Scout', provider: 'codex' }, SESSION);

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    const opts = mockRequestApproval.mock.calls[0][0];
    expect(opts.payload).toMatchObject({ name: 'Scout', provider: 'codex' });
    expect(opts.question).toMatch(/running on codex/);
    expect(lastNotifyText()).toMatch(/An admin needs to approve/);
  });

  it('cross-provider + confined scope + NOT installed: install copy on the card, plain note to the requester', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockIsProviderReady.mockReturnValue(false);

    await handleCreateAgent({ name: 'Scout', provider: 'codex' }, SESSION);

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockRequestApproval.mock.calls[0][0].question).toMatch(/\/add-codex/);
    expect(lastNotifyText()).toMatch(/isn't set up yet/);
  });

  it('confined scope, approval did not queue: requester is not notified (no contradiction)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockRequestApproval.mockResolvedValue(false);

    await handleCreateAgent({ name: 'Scout', provider: 'codex' }, SESSION);

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockNotifyWrite).not.toHaveBeenCalled();
  });

  it('same-provider is NOT gated (codex parent → codex child, global scope): direct create', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global', provider: 'codex' });

    await handleCreateAgent({ name: 'Scout', provider: 'codex' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
  });

  it('explicit claude request from a claude parent uses the existing (ungated) path', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await handleCreateAgent({ name: 'Scout', provider: 'claude' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
  });
});

describe('applyCreateAgent — provider stamping + apply-time re-check', () => {
  const notify = vi.fn();

  it('stamps the approved cross-provider on the child', async () => {
    await applyCreateAgent({ session: SESSION, payload: { name: 'Scout', provider: 'codex' }, userId: '', notify });

    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockUpdateScalars).toHaveBeenCalledWith(expect.any(String), { provider: 'codex' });
  });

  it('aborts cleanly if the provider is still not installed at apply time', async () => {
    mockIsProviderReady.mockReturnValue(false);

    await applyCreateAgent({ session: SESSION, payload: { name: 'Scout', provider: 'codex' }, userId: '', notify });

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/still isn't installed/));
  });
});
