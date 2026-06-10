/**
 * Container-side output guardrails.
 *
 * Call sites cover every agent-authored output path:
 *   1. poll-loop.ts result branch (applyOutputGuardrails) — the agent's
 *      <message to="...">…</message> result text, checked before
 *      dispatchResultText writes anything to messages_out.
 *   2. mcp-tools/core.ts send_message / send_file (caption + filename) /
 *      edit_message and mcp-tools/interactive.ts ask_user_question / send_card
 *      (checkOutputTexts) — checked before writeMessageOut; on block the
 *      agent receives a tool error so it understands instead of failing
 *      silently.
 *
 * Only the sendable content is scanned (message-block bodies / tool text),
 * never <internal> scratchpad — scratchpad is not delivered, so blocking on
 * it would be a false positive.
 *
 * Every deliverable string is evaluated SEPARATELY — joining them first
 * would break anchored regexes (^…$ never matches a multi-block join) and
 * keyphrases spanning an artificial join boundary.
 *
 * Fully synchronous — no network, no async gap between check and send.
 * Fail CLOSED by design: an invalid config or any internal error blocks the
 * output. Output-direction quarantine records keep the content (the agent
 * authored it — there is nothing to hide from the agent).
 */
import type { RoutingContext } from '../formatter.js';
import { loadGuardrailsConfig, type GuardrailsConfig } from './config.js';
import { emitQuarantine, sendGuardrailAlert, sendGuardrailConfigAlert, type AlertRouting } from './quarantine.js';
import { evaluateRules, type GuardrailRule, type RuleMatch } from './rules.js';

function log(msg: string): void {
  console.error(`[guardrails] ${msg}`);
}

/** Consecutive blocked sends this process — escalates the tool-error wording. */
let consecutiveBlocks = 0;
const ESCALATE_AFTER = 3;

const CONFIG_INVALID_AGENT_MESSAGE =
  'Output guardrails for this group are misconfigured — all sends are blocked until an admin fixes guardrails.json. Do not retry.';

/**
 * Guard the poll-loop result text. Returns the text unchanged on pass/flag,
 * or null when blocked (the caller skips dispatch entirely).
 */
export function applyOutputGuardrails(text: string, routing: RoutingContext): { text: string | null } {
  const alertAddr: AlertRouting = {
    channel_type: routing.channelType,
    platform_id: routing.platformId,
    thread_id: routing.threadId,
  };
  try {
    const loaded = loadGuardrailsConfig();
    if (loaded.status === 'absent') return { text };

    if (loaded.status === 'invalid') {
      quarantineOutput('(config-invalid)', 'config', 'block', loaded.error, text, alertAddr);
      sendGuardrailConfigAlert(alertAddr, loaded.error);
      log(`config invalid — blocked result text: ${loaded.error}`);
      return { text: null };
    }

    const config = loaded.config;
    if (config.output_rules.length === 0) return { text };

    const bodies = extractSendableTexts(text);
    if (bodies.length === 0) return { text }; // nothing deliverable in this result — nothing to guard

    const winner = evaluateTexts(config.output_rules, bodies);
    if (!winner) {
      consecutiveBlocks = 0;
      return { text };
    }

    report(winner.verdict, winner.matched, config, alertAddr);
    if (winner.verdict.rule.action === 'block') {
      consecutiveBlocks++;
      return { text: null };
    }
    return { text };
  } catch (err) {
    log(`output guardrails failed — blocking result text (failing CLOSED): ${err instanceof Error ? err.message : String(err)}`);
    return { text: null };
  }
}

/**
 * Guard one MCP send (send_message, send_file caption + filename,
 * edit_message, ask_user_question, send_card). Each deliverable string is
 * passed as its own entry and evaluated separately. On block, the returned
 * message is meant for the agent as a tool error — it names the rule and
 * tells the agent not to retry verbatim, escalating after repeated blocks
 * in this process.
 */
export function checkOutputTexts(texts: string[], routing: AlertRouting): { blocked: boolean; ruleId?: string; message?: string } {
  try {
    const loaded = loadGuardrailsConfig();
    if (loaded.status === 'absent') return { blocked: false };

    if (loaded.status === 'invalid') {
      quarantineOutput('(config-invalid)', 'config', 'block', loaded.error, texts.join('\n'), routing);
      sendGuardrailConfigAlert(routing, loaded.error);
      // Not a rule block — deliberately does NOT bump consecutiveBlocks; the
      // agent can't word its way past a broken config.
      return { blocked: true, ruleId: '(config-invalid)', message: CONFIG_INVALID_AGENT_MESSAGE };
    }

    const config = loaded.config;
    if (config.output_rules.length === 0) return { blocked: false };

    const winner = evaluateTexts(config.output_rules, texts);
    if (!winner) {
      consecutiveBlocks = 0;
      return { blocked: false };
    }

    report(winner.verdict, winner.matched, config, routing);
    if (winner.verdict.rule.action !== 'block') return { blocked: false };

    consecutiveBlocks++;
    let message = `Message blocked by output guardrail '${winner.verdict.rule.id}' (${winner.verdict.reason}). Do not retry the same content verbatim.`;
    if (consecutiveBlocks >= ESCALATE_AFTER) {
      message += ' Multiple sends were blocked this turn — stop attempting to send this content.';
    }
    return { blocked: true, ruleId: winner.verdict.rule.id, message };
  } catch (err) {
    log(`output guardrails failed — blocking send (failing CLOSED): ${err instanceof Error ? err.message : String(err)}`);
    return {
      blocked: true,
      message: 'Output guardrails check failed — message blocked (failing closed). Do not retry.',
    };
  }
}

function report(verdict: RuleMatch, content: string, config: GuardrailsConfig, routing: AlertRouting): void {
  const { rule, reason } = verdict;
  quarantineOutput(rule.id, rule.type, rule.action, reason, content, routing);
  sendGuardrailAlert(routing, 'output', rule, config.alerts.prefix);
  log(`output rule '${rule.id}' ${rule.action === 'block' ? 'blocked' : 'flagged'} agent output (${reason})`);
}

function quarantineOutput(
  ruleId: string,
  ruleType: string,
  action: 'block' | 'flag',
  reason: string,
  content: string,
  routing: AlertRouting,
): void {
  emitQuarantine({
    ts: new Date().toISOString(),
    direction: 'output',
    ruleId,
    ruleType,
    action,
    reason,
    channelType: routing.channel_type,
    platformId: routing.platform_id,
    content,
  });
}

/**
 * Evaluate each text separately and pick the winning match: the first
 * 'block' verdict across all texts, else the first 'flag'. Texts are never
 * joined — joining breaks anchored regexes (^…$ can't match across an
 * artificial boundary). Block is preferred over flag so a flag match in an
 * early text can't mask a block match in a later one.
 */
function evaluateTexts(rules: GuardrailRule[], texts: string[]): { verdict: RuleMatch; matched: string } | null {
  let flagged: { verdict: RuleMatch; matched: string } | null = null;
  for (const text of texts) {
    const verdict = evaluateRules(rules, text);
    if (!verdict) continue;
    if (verdict.rule.action === 'block') return { verdict, matched: text };
    flagged ??= { verdict, matched: text };
  }
  return flagged;
}

/**
 * Pull the deliverable bodies out of a poll-loop result: the contents of
 * <message to="...">…</message> blocks, matching dispatchResultText's regex.
 * One entry per block — bodies are evaluated separately, never joined.
 */
function extractSendableTexts(text: string): string[] {
  const re = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const body = match[2].trim();
    if (body) bodies.push(body);
  }
  return bodies;
}

/** Test seam — reset the escalation counter between test cases. */
export function resetEscalationForTest(): void {
  consecutiveBlocks = 0;
}
