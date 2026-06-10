/**
 * Container-side input guardrails.
 *
 * Invoked from the poll-loop MODULE-HOOKs (initial batch + follow-up poll)
 * BEFORE messages are formatted into the prompt — a blocked message never
 * becomes part of any prompt, so the agent cannot see it. The poll loop is
 * the only path messages take to the model, which is what makes this
 * ordering structural rather than timing-based.
 *
 * Re-runs the same regex/keyphrase rules the host router applies, as defense
 * in depth: rows that bypass the router (scheduled tasks, on_wake,
 * agent-to-agent) get the same coverage. Fully synchronous — no network, no
 * credentials, no async gap between check and use.
 *
 * Fail CLOSED by design: an invalid config or any internal error blocks the
 * affected messages. Quarantine records for blocked INPUT omit the content —
 * outbound.db is agent-readable, so they carry messageId instead (the text
 * stays in inbound.db).
 */
import type { MessageInRow } from '../db/messages-in.js';
import type { RoutingContext } from '../formatter.js';
import { loadGuardrailsConfig } from './config.js';
import { emitQuarantine, sendGuardrailAlert, sendGuardrailConfigAlert, type AlertRouting } from './quarantine.js';
import { evaluateRules, extractScannableText } from './rules.js';

function log(msg: string): void {
  console.error(`[guardrails] ${msg}`);
}

export interface InputGuardrailsOutcome {
  keep: MessageInRow[];
  blockedIds: string[];
}

/**
 * Partition a batch into messages the agent may see and blocked ids.
 * Flag-mode matches stay in `keep` but are alerted + quarantined.
 * No-ops instantly (pass-through) when the group has no guardrails config.
 */
export function applyInputGuardrails(messages: MessageInRow[], routing: RoutingContext): InputGuardrailsOutcome {
  if (messages.length === 0) return { keep: [], blockedIds: [] };
  try {
    const loaded = loadGuardrailsConfig();
    if (loaded.status === 'absent') return { keep: messages, blockedIds: [] };

    if (loaded.status === 'invalid') {
      for (const msg of messages) {
        emitQuarantine({
          ts: new Date().toISOString(),
          direction: 'input',
          ruleId: '(config-invalid)',
          ruleType: 'config',
          action: 'block',
          reason: loaded.error,
          channelType: msg.channel_type,
          platformId: msg.platform_id,
          messageId: msg.id,
        });
      }
      sendGuardrailConfigAlert(alertRouting(messages[0], routing), loaded.error);
      log(`config invalid — blocked ALL ${messages.length} inbound message(s): ${loaded.error}`);
      return { keep: [], blockedIds: messages.map((m) => m.id) };
    }

    const config = loaded.config;
    const keep: MessageInRow[] = [];
    const blockedIds: string[] = [];
    for (const msg of messages) {
      let match;
      try {
        const text = extractScannableText(msg.kind, msg.content);
        match = text ? evaluateRules(config.input_rules, text) : null;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        emitQuarantine({
          ts: new Date().toISOString(),
          direction: 'input',
          ruleId: '(error)',
          ruleType: 'error',
          action: 'block',
          reason: error,
          channelType: msg.channel_type,
          platformId: msg.platform_id,
          messageId: msg.id,
        });
        log(`input check error for ${msg.id} — blocking (failing CLOSED): ${error}`);
        blockedIds.push(msg.id);
        continue;
      }
      if (!match) {
        keep.push(msg);
        continue;
      }

      const { rule, reason } = match;
      emitQuarantine({
        ts: new Date().toISOString(),
        direction: 'input',
        ruleId: rule.id,
        ruleType: rule.type,
        action: rule.action,
        reason,
        channelType: msg.channel_type,
        platformId: msg.platform_id,
        messageId: msg.id,
      });
      sendGuardrailAlert(alertRouting(msg, routing), 'input', rule, config.alerts.prefix);
      log(`input rule '${rule.id}' ${rule.action === 'block' ? 'blocked' : 'flagged'} message ${msg.id} (${reason})`);

      if (rule.action === 'block') {
        blockedIds.push(msg.id);
      } else {
        keep.push(msg);
      }
    }
    return { keep, blockedIds };
  } catch (err) {
    log(`input guardrails failed — blocking ALL messages (failing CLOSED): ${err instanceof Error ? err.message : String(err)}`);
    return { keep: [], blockedIds: messages.map((m) => m.id) };
  }
}

function alertRouting(msg: MessageInRow, routing: RoutingContext): AlertRouting {
  return {
    channel_type: msg.channel_type ?? routing.channelType,
    platform_id: msg.platform_id ?? routing.platformId,
    thread_id: msg.thread_id ?? routing.threadId,
  };
}
