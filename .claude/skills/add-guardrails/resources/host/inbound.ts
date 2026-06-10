/**
 * Host-side inbound guardrails.
 *
 * Runs as an inbound message gate (registered by ./index.ts) in the router's
 * deliverToAgent(), just before writeSessionMessage().
 * Evaluates regex/keyphrase input rules — blocking here means the container
 * never wakes, so a blocked message costs no agent turn at all. The container
 * re-runs the same rules as defense in depth for rows that bypass the router
 * (scheduled tasks, on_wake, agent-to-agent).
 *
 * Fail CLOSED by design: a configured-but-broken guardrails.json blocks every
 * message for the group (with an admin alert) until fixed, and any internal
 * error blocks the message that triggered it. Only a group with no
 * guardrails/ config passes through untouched.
 */
import type { InboundEvent } from '../../channels/adapter.js';
import { recordDroppedMessage } from '../../db/dropped-messages.js';
import { log } from '../../log.js';
import { writeOutboundDirect } from '../../session-manager.js';
import { loadGuardrailsConfig, type GuardrailsConfig, type QuarantineLimits } from './config.js';
import { appendQuarantine } from './quarantine.js';
import { evaluateRules, extractScannableText, type GuardrailRule } from './rules.js';

export interface InboundGuardrailContext {
  /** Agent group folder under GROUPS_DIR (where guardrails/ lives). */
  folder: string;
  agentGroupId: string;
  sessionId: string;
  /** Where the alert reply is delivered (mirrors the inbound row's address). */
  deliveryAddr: { channelType: string | null; platformId: string | null; threadId: string | null };
  event: InboundEvent;
  userId: string | null;
  messagingGroupId: string;
}

/** Collapse repeated alerts: at most one per collapse key per window. */
const ALERT_COLLAPSE_MS = 5 * 60 * 1000;
const lastAlertAt = new Map<string, number>();

/**
 * Returns true when the message must be dropped (router returns without
 * writing it). Flag-mode matches alert + audit but return false.
 *
 * `baseDir` overrides GROUPS_DIR for tests (mirrors the loader's seam).
 */
export function applyInboundGuardrails(ctx: InboundGuardrailContext, baseDir?: string): boolean {
  try {
    const loaded = loadGuardrailsConfig(ctx.folder, baseDir);
    if (loaded.status === 'absent') return false;

    if (loaded.status === 'invalid') {
      blockForBrokenGuardrails(ctx, '(config-invalid)', 'config', loaded.error, undefined);
      sendAlertText(
        ctx,
        `${ctx.agentGroupId}:config-invalid`,
        `⚠️ Guardrail config error — ALL messages to this agent are blocked until guardrails.json is fixed: ${loaded.error}`,
      );
      log.error('Guardrails config invalid — inbound message blocked', {
        agentGroupId: ctx.agentGroupId,
        sessionId: ctx.sessionId,
        error: loaded.error,
      });
      return true;
    }

    const config = loaded.config;
    const text = extractScannableText(ctx.event.message.kind, ctx.event.message.content);
    if (!text) return false;

    let match;
    try {
      match = evaluateRules(config.input_rules, text);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      blockForBrokenGuardrails(ctx, '(error)', 'error', error, config.quarantine);
      sendAlertText(
        ctx,
        `${ctx.agentGroupId}:${ctx.sessionId}:(error)`,
        `${config.alerts.prefix} input check failed — message blocked (failing closed).`,
      );
      log.error('Guardrails input evaluation failed — blocking message (failing CLOSED)', {
        agentGroupId: ctx.agentGroupId,
        sessionId: ctx.sessionId,
        error,
      });
      return true;
    }
    if (!match) return false;

    const { rule, reason } = match;
    appendQuarantine(
      ctx.agentGroupId,
      {
        ts: new Date().toISOString(),
        source: 'host',
        direction: 'input',
        ruleId: rule.id,
        ruleType: rule.type,
        action: rule.action,
        reason,
        sessionId: ctx.sessionId,
        channelType: ctx.event.channelType,
        platformId: ctx.event.platformId,
        userId: ctx.userId,
        content: ctx.event.message.content,
      },
      config.quarantine,
    );

    if (rule.action === 'block') {
      recordDroppedMessage({
        channel_type: ctx.event.channelType,
        platform_id: ctx.event.platformId,
        user_id: ctx.userId,
        sender_name: null,
        reason: 'guardrail_block',
        messaging_group_id: ctx.messagingGroupId,
        agent_group_id: ctx.agentGroupId,
      });
    }

    sendRuleAlert(ctx, config, rule);
    log.info('Guardrail input rule matched (host)', {
      ruleId: rule.id,
      action: rule.action,
      agentGroupId: ctx.agentGroupId,
      sessionId: ctx.sessionId,
    });
    return rule.action === 'block';
  } catch (err) {
    log.error('Guardrails inbound check failed — blocking message (failing CLOSED)', {
      agentGroupId: ctx.agentGroupId,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/** Quarantine + drop bookkeeping for blocks not caused by a rule match. */
function blockForBrokenGuardrails(
  ctx: InboundGuardrailContext,
  ruleId: '(config-invalid)' | '(error)',
  ruleType: 'config' | 'error',
  reason: string,
  limits: QuarantineLimits | undefined,
): void {
  appendQuarantine(
    ctx.agentGroupId,
    {
      ts: new Date().toISOString(),
      source: 'host',
      direction: 'input',
      ruleId,
      ruleType,
      action: 'block',
      reason,
      sessionId: ctx.sessionId,
      channelType: ctx.event.channelType,
      platformId: ctx.event.platformId,
      userId: ctx.userId,
      content: ctx.event.message.content,
    },
    limits,
  );
  recordDroppedMessage({
    channel_type: ctx.event.channelType,
    platform_id: ctx.event.platformId,
    user_id: ctx.userId,
    sender_name: null,
    reason: 'guardrail_block',
    messaging_group_id: ctx.messagingGroupId,
    agent_group_id: ctx.agentGroupId,
  });
}

function sendRuleAlert(ctx: InboundGuardrailContext, config: GuardrailsConfig, rule: GuardrailRule): void {
  // Alert text never quotes the blocked content — quoting it back into the
  // chat would leak what was blocked and could re-trigger keyphrase rules.
  // That includes the match REASON (a keyphrase reason quotes the matched
  // phrase), so the default names only the rule id + type; admins set the
  // per-rule `message` field for human-friendly wording. The quarantine
  // record keeps the reason for audit.
  const verb = rule.action === 'block' ? 'blocked' : 'flagged';
  const text = rule.message ?? `${config.alerts.prefix} [input] rule '${rule.id}' (${rule.type}) ${verb} a message.`;
  sendAlertText(ctx, `${ctx.agentGroupId}:${ctx.sessionId}:${rule.id}`, text);
}

function sendAlertText(ctx: InboundGuardrailContext, collapseKey: string, text: string): void {
  const now = Date.now();
  const last = lastAlertAt.get(collapseKey);
  if (last && now - last < ALERT_COLLAPSE_MS) return;
  lastAlertAt.set(collapseKey, now);

  try {
    writeOutboundDirect(ctx.agentGroupId, ctx.sessionId, {
      id: `guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platformId: ctx.deliveryAddr.platformId,
      channelType: ctx.deliveryAddr.channelType,
      threadId: ctx.deliveryAddr.threadId,
      content: JSON.stringify({ text }),
    });
  } catch (err) {
    log.warn('Guardrail alert write failed', { agentGroupId: ctx.agentGroupId, sessionId: ctx.sessionId, err });
  }
}
