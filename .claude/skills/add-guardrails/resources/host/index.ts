/**
 * Guardrails module registration — pure import-time side effects.
 *
 * The src/modules/index.ts barrel imports this file; everything below runs
 * once at boot and the module never touches core again. Removal = delete
 * the barrel line and this directory.
 */
import fs from 'fs';
import path from 'path';

import {
  registerInboundMessageGate,
  registerMountContributor,
  registerOutboundMessageGate,
} from '../../module-hooks.js';
import { guardOutboundDelivery } from './delivery-gate.js';
import { applyInboundGuardrails } from './inbound.js';
import { registerGuardrailsDeliveryAction } from './quarantine.js';

// Host input gate: blocking here means the container never wakes — a blocked
// message costs no agent turn. The container's hooks re-check rows that
// bypass the router (scheduled tasks, on_wake, agent-to-agent).
registerInboundMessageGate(
  ({ event, userId, mg, agentGroup, session, deliveryAddr }) =>
    !applyInboundGuardrails({
      folder: agentGroup.folder,
      agentGroupId: agentGroup.id,
      sessionId: session.id,
      deliveryAddr,
      event,
      userId,
      messagingGroupId: mg.id,
    }),
);

// Host output checkpoint — the enforcement layer the agent cannot touch
// (container-side checks are bypassable via direct outbound.db INSERTs).
registerOutboundMessageGate(guardOutboundDelivery);

// guardrails/ — nested RO mount on top of the RW group dir so the agent can
// read but never edit or delete its own guardrails.
registerMountContributor(({ groupDir }) => {
  const dir = path.join(groupDir, 'guardrails');
  if (!fs.existsSync(dir)) return [];
  return [{ hostPath: dir, containerPath: '/workspace/agent/guardrails', readonly: true }];
});

// Container→host quarantine sink ('guardrail_quarantine' system action).
registerGuardrailsDeliveryAction();
