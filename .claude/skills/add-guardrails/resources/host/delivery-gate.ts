/**
 * Outbound message gate — adapts checkOutboundDelivery to the host's
 * outbound-gate seam and delivers the block alert.
 *
 * The alert goes straight through the delivery adapter, never via
 * outbound.db, so a blocked alert can never recurse through the gate. A
 * refusal resolves normally: the delivery loop marks the row delivered
 * without sending (no retry loop on blocked content).
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { OutboundGateContext } from '../../module-hooks.js';
import { checkOutboundDelivery } from './delivery-check.js';

/** Returns true when the row may be delivered. */
export async function guardOutboundDelivery({ msg, session }: OutboundGateContext): Promise<boolean> {
  const guard = checkOutboundDelivery({
    folder: getAgentGroup(session.agent_group_id)?.folder ?? null,
    agentGroupId: session.agent_group_id,
    sessionId: session.id,
    msg,
  });
  if (guard.action !== 'block') return true;

  if (guard.alertText && msg.channel_type && msg.channel_type !== 'agent' && msg.platform_id) {
    const adapter = getDeliveryAdapter();
    if (adapter) {
      try {
        await adapter.deliver(
          msg.channel_type,
          msg.platform_id,
          msg.thread_id,
          'chat',
          JSON.stringify({ text: guard.alertText }),
        );
      } catch (err) {
        log.warn('Guardrail block alert delivery failed', { messageId: msg.id, err });
      }
    }
  }
  return false;
}
