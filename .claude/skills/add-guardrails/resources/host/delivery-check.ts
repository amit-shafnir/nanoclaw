/**
 * Host-side output guardrails — the delivery checkpoint.
 *
 * Called by deliverMessage() in src/delivery.ts for every non-system
 * outbound row, right before platform delivery. The container-side output
 * checks (container/agent-runner/src/guardrails/output-check.ts) give the
 * agent an actionable tool error, but they run inside the container — an
 * injected agent with Bash can bypass them by INSERTing into messages_out
 * directly. This check runs in the host process, which the agent cannot
 * touch, so it is the enforcement layer.
 *
 * There is deliberately NO exemption mechanism: every row field is
 * agent-writable, so nothing row-based can be trusted to mark a row exempt.
 * The module's own alerts never pass through outbound.db (the caller hands
 * the alert text straight to the delivery adapter), so a blocked alert can
 * never recurse through this check.
 *
 * Fail CLOSED by design: an invalid config, a missing agent group row, or
 * any internal error blocks the row. Every string leaf of the content JSON
 * is evaluated separately (raw string fallback when the content isn't JSON)
 * — joining would break anchored regexes, and scanning the serialized JSON
 * would let escaping defeat quote/newline keyphrases.
 */
import { GROUPS_DIR } from '../../config.js';
import { log } from '../../log.js';
import { loadGuardrailsConfig } from './config.js';
import { appendQuarantine } from './quarantine.js';
import { collectStringLeaves, evaluateRules, type RuleMatch } from './rules.js';

export interface OutboundDeliveryArgs {
  /** Agent group folder under GROUPS_DIR; null = group row vanished (fail closed). */
  folder: string | null;
  agentGroupId: string;
  sessionId: string;
  msg: {
    id: string;
    channel_type: string | null;
    platform_id: string | null;
    content: string;
  };
}

export type OutboundDeliveryVerdict = { action: 'deliver' } | { action: 'block'; alertText: string | null };

/** Collapse repeated alerts: at most one per collapse key per window. */
const ALERT_COLLAPSE_MS = 5 * 60 * 1000;
const lastAlertAt = new Map<string, number>();

/**
 * Decide whether an outbound row may be delivered. On 'block' the caller
 * must NOT deliver the row; when `alertText` is non-null it should deliver
 * that text to the row's chat instead (null = collapsed, stay silent).
 * Flag-mode matches quarantine but deliver — the container already alerted
 * for tool-mediated sends, so alerting here too would double up.
 *
 * `baseDir` overrides GROUPS_DIR for tests (mirrors the loader's seam).
 */
export function checkOutboundDelivery(
  args: OutboundDeliveryArgs,
  baseDir: string = GROUPS_DIR,
): OutboundDeliveryVerdict {
  const { folder, agentGroupId, sessionId, msg } = args;
  try {
    if (folder === null) {
      log.error('Guardrails delivery check: agent group row missing — blocking (failing CLOSED)', {
        agentGroupId,
        messageId: msg.id,
      });
      return { action: 'block', alertText: null };
    }

    const loaded = loadGuardrailsConfig(folder, baseDir);
    if (loaded.status === 'absent') return { action: 'deliver' };

    if (loaded.status === 'invalid') {
      quarantineOutbound(args, '(config-invalid)', 'config', 'block', loaded.error);
      log.error('Guardrails config invalid — outbound message blocked at delivery', {
        agentGroupId,
        sessionId,
        messageId: msg.id,
        error: loaded.error,
      });
      return {
        action: 'block',
        alertText: collapsedAlertText(
          `${agentGroupId}:config-invalid`,
          `⚠️ Guardrail config error — ALL messages for this agent are blocked until guardrails.json is fixed: ${loaded.error}`,
        ),
      };
    }

    const config = loaded.config;
    if (config.output_rules.length === 0) return { action: 'deliver' };

    // Block beats flag: a flag match in one leaf must not mask a block
    // match in another.
    let flagged: { verdict: RuleMatch; matched: string } | null = null;
    let winner: { verdict: RuleMatch; matched: string } | null = null;
    for (const text of scannableTexts(msg.content)) {
      const verdict = evaluateRules(config.output_rules, text);
      if (!verdict) continue;
      if (verdict.rule.action === 'block') {
        winner = { verdict, matched: text };
        break;
      }
      flagged ??= { verdict, matched: text };
    }
    winner ??= flagged;
    if (!winner) return { action: 'deliver' };

    const { rule, reason } = winner.verdict;
    quarantineOutbound(args, rule.id, rule.type, rule.action, reason, config.quarantine);
    log.info('Guardrail output rule matched at delivery (host)', {
      ruleId: rule.id,
      action: rule.action,
      agentGroupId,
      sessionId,
      messageId: msg.id,
    });
    if (rule.action === 'flag') return { action: 'deliver' };

    // Default alert names only the rule id + type — the match reason quotes
    // the blocked content for keyphrase rules, and alert text must never do
    // that. Admins set the per-rule `message` field for friendlier wording.
    const text = rule.message ?? `${config.alerts.prefix} [output] rule '${rule.id}' (${rule.type}) blocked a message.`;
    return { action: 'block', alertText: collapsedAlertText(`${agentGroupId}:${rule.id}`, text) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    quarantineOutbound(args, '(error)', 'error', 'block', error);
    log.error('Guardrails delivery check failed — blocking message (failing CLOSED)', {
      agentGroupId,
      messageId: msg.id,
      error,
    });
    return { action: 'block', alertText: null };
  }
}

/**
 * The strings to evaluate for an outbound row: every string leaf of the
 * content JSON (text, filenames, card fields, …), or the raw content when
 * it isn't valid JSON — a forged row's content must be scanned as-is, not
 * skipped.
 */
function scannableTexts(contentJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return [contentJson];
  }
  return collectStringLeaves(parsed);
}

function quarantineOutbound(
  args: OutboundDeliveryArgs,
  ruleId: string,
  ruleType: string,
  action: 'block' | 'flag',
  reason: string,
  limits?: { max_file_mb: number; max_files: number },
): void {
  // Output content is agent-authored — kept in full for the audit trail.
  appendQuarantine(
    args.agentGroupId,
    {
      ts: new Date().toISOString(),
      source: 'host',
      direction: 'output',
      ruleId,
      ruleType,
      action,
      reason,
      sessionId: args.sessionId,
      channelType: args.msg.channel_type,
      platformId: args.msg.platform_id,
      content: args.msg.content,
    },
    limits,
  );
}

function collapsedAlertText(key: string, text: string): string | null {
  const now = Date.now();
  const last = lastAlertAt.get(key);
  if (last && now - last < ALERT_COLLAPSE_MS) return null;
  lastAlertAt.set(key, now);
  return text;
}
