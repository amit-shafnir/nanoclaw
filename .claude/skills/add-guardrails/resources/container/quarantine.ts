/**
 * Container-side guardrail reporting: quarantine emission + chat alerts.
 *
 * The container cannot reach the host's data/ directory, and quarantined
 * content must never be written to agent-readable paths (/workspace/agent/…)
 * — the agent could read the very injection a guardrail just blocked. So
 * quarantine records travel as `kind:'system'` outbound rows with action
 * 'guardrail_quarantine'; the host's delivery-action handler (registered by
 * src/modules/guardrails/quarantine.ts) persists them under
 * data/guardrails/<agent-group-id>/.
 *
 * Both writers are exempt from output guardrails by construction — the
 * output checks hook only the agent-authored output paths, never this
 * module's own writeMessageOut calls. An alert can't block itself.
 *
 * Every write is try/caught: reporting failure must never break the message
 * flow (also lets tests run without a real outbound.db).
 */
import { writeMessageOut } from '../db/messages-out.js';
import type { GuardrailRule } from './rules.js';

function log(msg: string): void {
  console.error(`[guardrails] ${msg}`);
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface ContainerQuarantineRecord {
  ts: string;
  direction: 'input' | 'output';
  ruleId: string;
  ruleType: string;
  action: 'block' | 'flag';
  reason?: string;
  channelType?: string | null;
  platformId?: string | null;
  /**
   * The blocked output text (output direction only). Input-direction records
   * must OMIT content — this record travels through agent-readable
   * outbound.db, and blocked input text must never be written where the
   * agent can read it. Input records carry `messageId` instead; the text
   * stays in inbound.db (messages_in, status 'completed').
   */
  content?: string;
  /** messages_in id of the blocked row (input direction). */
  messageId?: string;
}

/** Emit a quarantine record toward the host's quarantine sink. */
export function emitQuarantine(record: ContainerQuarantineRecord): void {
  try {
    writeMessageOut({
      id: generateId('guardq'),
      kind: 'system',
      content: JSON.stringify({ action: 'guardrail_quarantine', record }),
    });
  } catch (err) {
    log(`quarantine emit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface AlertRouting {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

/** Collapse repeated alerts: at most one per (direction, rule) per window. */
const ALERT_COLLAPSE_MS = 5 * 60 * 1000;
const lastAlertAt = new Map<string, number>();

/**
 * Post a guardrail alert into the chat the message came from / was headed to.
 * Alert text never quotes the blocked content — quoting it back would leak
 * what was blocked and could re-trigger keyphrase rules. That includes the
 * match REASON (a keyphrase reason quotes the matched phrase), so the default
 * names only the rule id + type; admins set the per-rule `message` field for
 * human-friendly wording. The quarantine record keeps the reason for audit.
 */
export function sendGuardrailAlert(
  routing: AlertRouting,
  direction: 'input' | 'output',
  rule: GuardrailRule,
  prefix: string,
): void {
  const key = `${direction}:${rule.id}`;
  const now = Date.now();
  const last = lastAlertAt.get(key);
  if (last && now - last < ALERT_COLLAPSE_MS) return;
  lastAlertAt.set(key, now);

  const verb = rule.action === 'block' ? 'blocked' : 'flagged';
  const text = rule.message ?? `${prefix} [${direction}] rule '${rule.id}' (${rule.type}) ${verb} a message.`;
  try {
    writeMessageOut({
      id: generateId('guarda'),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });
  } catch (err) {
    log(`alert write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Post the broken-config alert: the group is configured but guardrails.json
 * failed validation, so EVERYTHING is blocked until an admin fixes it. One
 * collapse key for the whole condition — per-message alerts would flood the
 * chat while every message is being blocked.
 */
export function sendGuardrailConfigAlert(routing: AlertRouting, error: string): void {
  const key = 'config-invalid';
  const now = Date.now();
  const last = lastAlertAt.get(key);
  if (last && now - last < ALERT_COLLAPSE_MS) return;
  lastAlertAt.set(key, now);

  const text = `⚠️ Guardrail config error — ALL messages for this agent are blocked until guardrails.json is fixed: ${error}`;
  try {
    writeMessageOut({
      id: generateId('guarda'),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });
  } catch (err) {
    log(`config alert write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Test seam — reset the alert collapse window between test cases. */
export function resetAlertCollapseForTest(): void {
  lastAlertAt.clear();
}
