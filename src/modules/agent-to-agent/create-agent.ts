/**
 * `create_agent` delivery-action handler.
 *
 * SECURITY: `create_agent` writes to the CENTRAL DB (agent_groups,
 * container_configs, agent_destinations) and scaffolds host filesystem state —
 * a privileged operation a confined container is otherwise architecturally
 * barred from. The container's MCP tool gate is inside the (untrusted)
 * container and is trivially bypassed by writing the outbound system row
 * directly, so authorization MUST be enforced host-side. Trusted owner agent
 * groups (CLI scope 'global') create directly; every other (confined) group
 * requires admin approval via `requestApproval` — matching `ncl groups create`
 * (access: 'approval') and the self-mod actions. `applyCreateAgent` runs the
 * creation on approve; `performCreateAgent` is the shared body.
 */
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { isProviderReady } from '../../providers/provider-container-registry.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { requestApproval, type ApprovalHandler } from '../approvals/index.js';
import { createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

/**
 * Delivery-action entry.
 *
 * Authorization depends on the calling group's CLI scope:
 *   - `global` (set by init-first-agent for trusted owner agent groups):
 *     create immediately. create_agent is the intended primitive for these
 *     privileged agents, and an approval tap on every sub-agent spawn would be
 *     needless friction.
 *   - anything else (the default `group` scope — the realistic
 *     prompt-injection victim): require an admin to approve before any
 *     central-DB write. `applyCreateAgent` runs on approve.
 * Unknown/missing config fails closed to the approval path.
 */
export async function handleCreateAgent(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = typeof content.name === 'string' ? content.name : '';
  const instructions = typeof content.instructions === 'string' ? content.instructions : null;
  const providerRaw = typeof content.provider === 'string' ? content.provider.trim().toLowerCase() : '';
  const provider = providerRaw || undefined;

  // `provider` reaches a human via the approval card (and the `/add-<provider>`
  // hint). The container is untrusted, so restrict it to a bare provider-name
  // shape — no newlines/markdown to spoof or mislead the approver. Matches the
  // registry/folder naming the spawn path already assumes.
  if (provider !== undefined && !/^[a-z0-9-]+$/.test(provider)) {
    notifyAgent(session, 'create_agent failed: provider must be a short name like "codex" (letters, digits, hyphens).');
    return;
  }

  if (!name) {
    notifyAgent(session, 'create_agent failed: name is required.');
    return;
  }

  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    notifyAgent(session, 'create_agent failed: source agent group not found.');
    log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return;
  }

  const config = getContainerConfig(session.agent_group_id);
  const cliScope = config?.cli_scope ?? 'group';
  // Measure the request against the parent's OWN runtime: a codex parent
  // creating a codex child is same-provider (no new runtime is being adopted).
  // Cross-provider only changes the copy/readiness handling for confined
  // groups; authorization stays scope-based (global creates directly, confined
  // needs approval) exactly as it does for same-provider creates.
  const parentProvider = (config?.provider ?? 'claude').toLowerCase();
  const isCrossProvider = provider !== undefined && provider !== parentProvider;

  if (cliScope === 'global') {
    // Trusted owner agent group — create directly, same trust it already has
    // for same-provider creates and unrestricted ncl. No approval tap. A
    // cross-provider request still needs the target installed; there's no human
    // in this path to prompt, so fail with a clear instruction rather than
    // stamping a child on a runtime it can't boot.
    if (isCrossProvider && !isProviderReady(provider)) {
      notifyAgent(
        session,
        `Can't create "${name}" on ${provider}: it isn't installed. Run \`/add-${provider}\` on the host, then try again.`,
      );
      return;
    }
    await performCreateAgent(
      name,
      instructions,
      session,
      sourceGroup,
      (text) => notifyAgent(session, text),
      isCrossProvider ? provider : undefined,
    );
    return;
  }

  // Confined (non-global) agent group — the realistic prompt-injection victim.
  // Every create needs an admin to approve before any central-DB write.
  if (!isCrossProvider) {
    await requestApproval({
      session,
      agentName: sourceGroup.name,
      action: 'create_agent',
      payload: { name, instructions },
      title: `Create agent: ${name}`,
      question: `Agent "${sourceGroup.name}" wants to create a new sub-agent "${name}" (a new agent group with its own workspace and container). Approve?`,
    });
    return;
  }

  // Cross-provider from a confined group: a new agent on a runtime the parent
  // doesn't run on. Readiness-aware card + requester note.
  const ready = isProviderReady(provider);
  const requestedBy = describeRequester(sourceGroup.name, session);
  const title = ready ? `Create agent: ${name} (${provider})` : `Install ${provider} to create ${name}`;
  const question = ready
    ? `${requestedBy} wants to create a new sub-agent "${name}" running on ${provider} (a new agent group with its own workspace and container). Approve to create it; the requester is notified when it's ready.`
    : `${requestedBy} wants to create "${name}" on ${provider}, but ${provider} isn't installed yet. Install it first — run \`/add-${provider}\` on the host — then approve. Approving before install cancels the request. On approval, "${name}" is created and the requester is notified.`;

  const queued = await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: 'create_agent',
    payload: { name, instructions, provider },
    title,
    question,
  });

  if (queued) {
    notifyAgent(
      session,
      ready
        ? `Requested a new ${provider} agent "${name}". An admin needs to approve it — I'll let you know when it's created.`
        : `${provider} isn't set up yet, so I've asked an admin to enable it and approve creating "${name}". I'll let you know when it's ready.`,
    );
  }
}

/**
 * Human-readable attribution for the approval card — the source agent plus its
 * originating channel/group when cheaply resolvable. Lets an admin approving on
 * someone else's behalf see who asked. Full handle attribution is best-effort
 * and omitted when not available.
 */
function describeRequester(agentName: string, session: Session): string {
  const label = `Agent "${agentName}"`;
  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  if (!mg) return label;
  return `${label} (via ${mg.name ? `${mg.channel_type}, ${mg.name}` : mg.channel_type})`;
}

/**
 * Approval handler: performs the creation once an admin approves a request from
 * a confined (non-global) agent group. `session` is the requesting parent.
 */
export const applyCreateAgent: ApprovalHandler = async ({ session, payload, notify }) => {
  const name = typeof payload.name === 'string' ? payload.name : '';
  const instructions = typeof payload.instructions === 'string' ? payload.instructions : null;
  const provider = typeof payload.provider === 'string' ? payload.provider : undefined;

  if (!name) {
    notify('create_agent approved but the request had no name.');
    return;
  }

  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    notify('create_agent approved but the source agent group no longer exists.');
    log.warn('create_agent apply failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return;
  }

  await performCreateAgent(name, instructions, session, sourceGroup, notify, provider);
};

/**
 * Core creation: writes the new agent group + bidirectional destinations and
 * scaffolds its filesystem, then reports via `notify`. Authorization is the
 * CALLER's responsibility (the global-scope shortcut in handleCreateAgent or
 * admin approval via applyCreateAgent) — never call this from an unauthorized
 * path, as it performs privileged central-DB writes a confined container is
 * otherwise barred from.
 */
async function performCreateAgent(
  name: string,
  instructions: string | null,
  session: Session,
  sourceGroup: AgentGroup,
  notify: (text: string) => void,
  requestedProvider?: string,
): Promise<void> {
  // Re-check readiness at apply time (before any DB write): the operator may
  // have approved a cross-provider request without installing the provider, or
  // an install could have been removed between request and approval.
  if (requestedProvider && !isProviderReady(requestedProvider)) {
    notify(
      `Couldn't create "${name}": ${requestedProvider} still isn't installed. Ask an admin to enable it, then request again.`,
    );
    return;
  }

  const localName = normalizeName(name);

  // Collision in the creator's destination namespace
  if (getDestinationByName(sourceGroup.id, localName)) {
    notify(`Cannot create agent "${name}": you already have a destination named "${localName}".`);
    return;
  }

  // Derive a safe folder name, deduplicated globally across agent_groups.folder
  let folder = localName;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${localName}-${suffix}`;
    suffix++;
  }

  const groupPath = path.join(GROUPS_DIR, folder);
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
    notify(`Cannot create agent "${name}": invalid folder path.`);
    log.error('create_agent path traversal attempt', { folder, resolvedPath });
    return;
  }

  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const newGroup: AgentGroup = {
    id: agentGroupId,
    name,
    folder,
    agent_provider: null,
    created_at: now,
  };
  createAgentGroup(newGroup);
  // Provider is a DB property; the child is created provider-agnostic, then
  // stamped. An explicit cross-provider request stamps that provider; otherwise
  // the child inherits the creator's runtime so a single-provider install (e.g.
  // codex-only, where claude isn't authenticated) doesn't spawn a child on a
  // runtime it can't reach. The operator can still flip a child later with `ncl
  // groups config update --provider`. claude (the built-in default) leaves the
  // column unset — keeping an explicit `claude` request unstamped too.
  const providerToStamp = requestedProvider ?? getContainerConfig(sourceGroup.id)?.provider ?? undefined;
  initGroupFilesystem(newGroup, { instructions: instructions ?? undefined, provider: providerToStamp });
  if (providerToStamp && providerToStamp !== 'claude') {
    updateContainerConfigScalars(newGroup.id, { provider: providerToStamp });
  }

  // Insert bidirectional destination rows (= ACL grants).
  // Creator refers to child by the name it chose; child refers to creator as "parent".
  createDestination({
    agent_group_id: sourceGroup.id,
    local_name: localName,
    target_type: 'agent',
    target_id: agentGroupId,
    created_at: now,
  });
  // Handle the unlikely case where the child already has a "parent" destination
  // (shouldn't happen for a brand-new agent, but be safe).
  let parentName = 'parent';
  let parentSuffix = 2;
  while (getDestinationByName(agentGroupId, parentName)) {
    parentName = `parent-${parentSuffix}`;
    parentSuffix++;
  }
  createDestination({
    agent_group_id: agentGroupId,
    local_name: parentName,
    target_type: 'agent',
    target_id: sourceGroup.id,
    created_at: now,
  });

  // REQUIRED: project the new destination into the running container's
  // inbound.db. See the top-of-file invariant in db/agent-destinations.ts
  // — forgetting this causes "dropped: unknown destination" when the parent
  // tries to send to the newly-created child.
  writeDestinations(session.agent_group_id, session.id);

  notify(`Agent "${localName}" created. You can now message it with <message to="${localName}">...</message>.`);
  log.info('Agent group created', { agentGroupId, name, localName, folder, parent: sourceGroup.id });
}
