/**
 * Tests for create_agent's template branch (templates-from-chat).
 *
 * The template ref rides the EXISTING agents.create authorization: no new
 * gate, the hold payload carries the ref, and the grant binding pins the
 * approved replay to the exact (name, template) pair that was approved.
 * These tests drive the REAL wrapped delivery action and the approve
 * continuation, with the registry module (fetch) and the stamping engine
 * mocked at their interfaces.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingApproval, Session } from '../../types.js';

// Mocks for the collaborators the branch decides between / depends on.
// vi.hoisted: the module barrel import below runs before this file's const
// initializers, and the mock factories close over this state.
const {
  mockRequestApproval,
  mockGetContainerConfig,
  mockCreateAgentGroup,
  mockInitGroupFilesystem,
  mockWriteDestinations,
  mockCreateDestination,
  mockNotifyWrite,
  mockEnsureTemplateLocal,
  mockHasLocalTemplate,
  mockCreateAgentFromTemplate,
  liveApprovals,
  approvalHandlers,
} = vi.hoisted(() => ({
  mockRequestApproval: vi.fn().mockResolvedValue(undefined),
  mockGetContainerConfig: vi.fn(),
  mockCreateAgentGroup: vi.fn(),
  mockInitGroupFilesystem: vi.fn(),
  mockWriteDestinations: vi.fn(),
  mockCreateDestination: vi.fn(),
  mockNotifyWrite: vi.fn(),
  mockEnsureTemplateLocal: vi.fn(),
  mockHasLocalTemplate: vi.fn(),
  mockCreateAgentFromTemplate: vi.fn(),
  liveApprovals: new Map<string, import('../../types.js').PendingApproval>(),
  approvalHandlers: new Map<string, (ctx: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock('../approvals/index.js', () => ({
  requestApproval: (...a: unknown[]) => mockRequestApproval(...a),
  notifyAgent: vi.fn(),
  registerApprovalHandler: (action: string, handler: (ctx: Record<string, unknown>) => Promise<void>) => {
    approvalHandlers.set(action, handler);
  },
}));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: (...a: unknown[]) => mockGetContainerConfig(...a),
  ensureContainerConfig: () => {},
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: '' }),
  getAgentGroupByFolder: () => undefined,
  createAgentGroup: (...a: unknown[]) => mockCreateAgentGroup(...a),
}));
vi.mock('../../group-init.js', () => ({
  initGroupFilesystem: (...a: unknown[]) => mockInitGroupFilesystem(...a),
}));
// The fetch seam (3b's registry module) and the stamping engine — mocked at
// their interfaces so no test touches git, the network, or the central DB.
vi.mock('../../templates/registry.js', () => ({
  ensureTemplateLocal: (...a: unknown[]) => mockEnsureTemplateLocal(...a),
  hasLocalTemplate: (...a: unknown[]) => mockHasLocalTemplate(...a),
}));
vi.mock('../../templates/create-agent.js', () => ({
  createAgentFromTemplate: (...a: unknown[]) => mockCreateAgentFromTemplate(...a),
}));
vi.mock('./write-destinations.js', () => ({
  writeDestinations: (...a: unknown[]) => mockWriteDestinations(...a),
}));
vi.mock('./db/agent-destinations.js', () => ({
  getDestinationByName: () => undefined,
  createDestination: (...a: unknown[]) => mockCreateDestination(...a),
  hasDestination: () => true,
  normalizeName: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));
// notifyAgent writes to the session inbound.db + wakes the container; stub both.
// delivery.ts and agent-route.ts pull more session-manager exports at import time.
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => mockNotifyWrite(...a),
  openInboundDb: vi.fn(),
  openOutboundDb: vi.fn(),
  clearOutbox: vi.fn(),
  readOutboxFiles: vi.fn().mockReturnValue([]),
  resolveSession: vi.fn(),
  sessionDir: vi.fn().mockReturnValue('/tmp/nowhere'),
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: (id: string) => ({ id, agent_group_id: 'ag-1' }),
  getPendingApproval: (id: string) => liveApprovals.get(id),
  getRunningSessions: () => [],
  getActiveSessions: () => [],
  createPendingQuestion: vi.fn(),
}));

// The a2a module barrel registers ./guard.js (catalog entries) and the
// guard-wrapped create_agent delivery action — the path under test.
import './index.js';
import { getDeliveryAction } from '../../delivery.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;
const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12';

async function runCreateAgent(content: Record<string, unknown>): Promise<void> {
  const wrapped = getDeliveryAction('create_agent');
  expect(wrapped).toBeDefined();
  await wrapped!(content, SESSION);
}

function liveGrant(approvalId: string, payload: Record<string, unknown>): PendingApproval {
  const row = {
    approval_id: approvalId,
    session_id: SESSION.id,
    request_id: approvalId,
    action: 'create_agent',
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    agent_group_id: 'ag-1',
    channel_type: null,
    platform_id: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    title: '',
    options_json: '[]',
    approver_user_id: null,
  } as PendingApproval;
  liveApprovals.set(approvalId, row);
  return row;
}

async function replay(payload: Record<string, unknown>, approval: PendingApproval): Promise<void> {
  const continuation = approvalHandlers.get('create_agent');
  expect(continuation).toBeDefined();
  await continuation!({ session: SESSION, payload, approval, userId: 'telegram:admin', notify: vi.fn() });
}

function notifyTexts(): string[] {
  return mockNotifyWrite.mock.calls.map((c) => JSON.parse((c[2] as { content: string }).content).text as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  liveApprovals.clear();
  mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
  mockEnsureTemplateLocal.mockResolvedValue({ ref: 'sales/sdr', dir: '/tmp/tpl', source: 'registry', commit: COMMIT });
  mockHasLocalTemplate.mockReturnValue(false);
  mockCreateAgentFromTemplate.mockImplementation(async (_ref: string, opts?: { name?: string }) => ({
    group: { id: 'ag-child', name: opts?.name ?? 'sdr', folder: 'scout', agent_provider: null, created_at: '' },
    report: [],
  }));
});

describe('create_agent — template branch (global scope)', () => {
  it('stamps and wires: bidirectional destinations + projection + notify names ref and short SHA', async () => {
    await runCreateAgent({ name: 'Scout', template: 'sales/sdr' });

    expect(mockEnsureTemplateLocal).toHaveBeenCalledWith('sales/sdr');
    expect(mockCreateAgentFromTemplate).toHaveBeenCalledWith('sales/sdr', expect.objectContaining({ name: 'Scout' }));
    // Plain-create machinery must not run — the stamping engine owns group + config.
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockInitGroupFilesystem).not.toHaveBeenCalled();

    // Bidirectional destination rows: creator→child under the chosen name,
    // child→creator as "parent".
    expect(mockCreateDestination).toHaveBeenCalledTimes(2);
    expect(mockCreateDestination.mock.calls[0][0]).toMatchObject({
      agent_group_id: 'ag-1',
      local_name: 'scout',
      target_type: 'agent',
      target_id: 'ag-child',
    });
    expect(mockCreateDestination.mock.calls[1][0]).toMatchObject({
      agent_group_id: 'ag-child',
      local_name: 'parent',
      target_type: 'agent',
      target_id: 'ag-1',
    });
    // Projection into the running container's inbound.db (destinations invariant).
    expect(mockWriteDestinations).toHaveBeenCalledWith('ag-1', 'sess-1');

    const done = notifyTexts().find((t) => t.includes('created from template'));
    expect(done).toContain('Agent "scout" created from template "sales/sdr"');
    expect(done).toContain(`commit ${COMMIT.slice(0, 7)}`);
  });

  it('local copy wins: notify says "local copy", no commit', async () => {
    mockEnsureTemplateLocal.mockResolvedValue({ ref: 'sales/sdr', dir: '/tmp/tpl', source: 'local' });

    await runCreateAgent({ name: 'Scout', template: 'sales/sdr' });

    const done = notifyTexts().find((t) => t.includes('created from template'));
    expect(done).toContain('(local copy)');
    expect(done).not.toContain('commit');
  });

  it('fetch failure creates nothing and answers the requester', async () => {
    mockEnsureTemplateLocal.mockRejectedValue(new Error('network unreachable'));

    await runCreateAgent({ name: 'Scout', template: 'sales/sdr' });

    expect(mockCreateAgentFromTemplate).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockCreateDestination).not.toHaveBeenCalled();
    expect(mockWriteDestinations).not.toHaveBeenCalled();
    expect(
      notifyTexts().some(
        (t) => t.includes('could not fetch template "sales/sdr"') && t.includes('Nothing was created.'),
      ),
    ).toBe(true);
  });

  it('stamp failure notifies the requester and wires nothing', async () => {
    mockCreateAgentFromTemplate.mockRejectedValue(new Error('invalid plugin.json'));

    await runCreateAgent({ name: 'Scout', template: 'sales/sdr' });

    expect(mockCreateDestination).not.toHaveBeenCalled();
    expect(mockWriteDestinations).not.toHaveBeenCalled();
    expect(
      notifyTexts().some(
        (t) => t.includes('template "sales/sdr" could not be stamped') && t.includes('invalid plugin.json'),
      ),
    ).toBe(true);
  });

  it('parent provider is inherited by the stamped group', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global', provider: 'codex' });

    await runCreateAgent({ name: 'Scout', template: 'sales/sdr' });

    expect(mockCreateAgentFromTemplate).toHaveBeenCalledWith(
      'sales/sdr',
      expect.objectContaining({ provider: 'codex' }),
    );
  });

  it('claude parent (no explicit provider) pins the child to claude', async () => {
    await runCreateAgent({ name: 'Scout', template: 'sales/sdr' });

    expect(mockCreateAgentFromTemplate).toHaveBeenCalledWith(
      'sales/sdr',
      expect.objectContaining({ provider: 'claude' }),
    );
  });

  it('surfaces the stamping report lines in the success notify', async () => {
    mockCreateAgentFromTemplate.mockResolvedValue({
      group: { id: 'ag-child', name: 'Scout', folder: 'scout', agent_provider: null, created_at: '' },
      report: ['unknown field "publisher" ignored'],
    });

    await runCreateAgent({ name: 'Scout', template: 'sales/sdr' });

    expect(notifyTexts().some((t) => t.includes('unknown field "publisher" ignored'))).toBe(true);
  });
});

describe('create_agent — template precheck', () => {
  it('malformed ref is rejected before any hold (group scope, no card)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runCreateAgent({ name: 'Scout', template: '../evil' });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockEnsureTemplateLocal).not.toHaveBeenCalled();
    expect(mockCreateAgentFromTemplate).not.toHaveBeenCalled();
    expect(notifyTexts().some((t) => t.includes('invalid template ref "../evil"'))).toBe(true);
  });

  it('non-string template is rejected the same way', async () => {
    await runCreateAgent({ name: 'Scout', template: 42 });

    expect(mockCreateAgentFromTemplate).not.toHaveBeenCalled();
    expect(notifyTexts().some((t) => t.includes('invalid template ref'))).toBe(true);
  });
});

describe('create_agent — template hold + approved replay', () => {
  it('hold payload carries the ref and the card says fetch vs local copy', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await runCreateAgent({ name: 'Scout', instructions: 'be thorough', template: 'sales/sdr' });

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    const req = mockRequestApproval.mock.calls[0][0] as { payload: Record<string, unknown>; question: string };
    expect(req.payload).toMatchObject({ name: 'Scout', template: 'sales/sdr' });
    // The template branch ignores instructions, so the templated hold must not
    // carry them — the admin only grants what will actually execute.
    expect(req.payload.instructions).toBeNull();
    expect(req.question).toContain('stamped from template "sales/sdr"');
    expect(req.question).toContain('fetched from the public template registry');
    expect(mockCreateAgentFromTemplate).not.toHaveBeenCalled();
  });

  it('hold card says "existing local copy" when the ref already exists locally', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockHasLocalTemplate.mockReturnValue(true);

    await runCreateAgent({ name: 'Scout', template: 'sales/sdr' });

    const req = mockRequestApproval.mock.calls[0][0] as { question: string };
    expect(req.question).toContain('using the existing local copy');
  });

  it('approved replay stamps the held template', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const payload = { name: 'Scout', instructions: null, template: 'sales/sdr' };
    const approval = liveGrant('appr-tpl-1', payload);

    await replay(payload, approval);

    expect(mockCreateAgentFromTemplate).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentFromTemplate).toHaveBeenCalledWith('sales/sdr', expect.objectContaining({ name: 'Scout' }));
    expect(mockRequestApproval).not.toHaveBeenCalled(); // no second card
  });

  it('grant-swap: a grant for another template does not cover the request', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const approval = liveGrant('appr-tpl-2', { name: 'Scout', template: 'sales/other' });

    await replay({ name: 'Scout', template: 'sales/sdr' }, approval);

    expect(mockCreateAgentFromTemplate).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockRequestApproval).not.toHaveBeenCalled(); // refused, not re-held
  });

  it('grant-swap: a grant approved for a plain create does not cover a templated request', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const approval = liveGrant('appr-tpl-3', { name: 'Scout', instructions: null });

    await replay({ name: 'Scout', template: 'sales/sdr' }, approval);

    expect(mockCreateAgentFromTemplate).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });

  it('grant-swap: a templated grant does not cover a plain replay', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    const approval = liveGrant('appr-tpl-4', { name: 'Scout', template: 'sales/sdr' });

    await replay({ name: 'Scout' }, approval);

    expect(mockCreateAgentFromTemplate).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });
});
