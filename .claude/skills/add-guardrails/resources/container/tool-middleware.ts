/**
 * Output-guardrail middleware for the MCP tool-dispatch chokepoint.
 *
 * One seam covers every tool: each EXTRACTORS entry names the deliverable
 * strings of one tool; `null` marks a tool exempt (no free text). Tools not
 * in the map pass through container-side — the host delivery checkpoint
 * remains the enforcement backstop for anything that reaches messages_out.
 * Covering a future tool = one map entry, zero core edits.
 *
 * The guard runs before the tool handler, so it fires ahead of the
 * handler's own validation (a guard error takes precedence over e.g. "File
 * not found" — deliberately, so a blocked send_file filename never leaks
 * whether a path exists). Block alerts route via the session's default
 * routing, not the resolved `to=` destination — the alert lands in the
 * conversation the agent is bound to.
 *
 * Fail CLOSED: an internal error in extraction or evaluation blocks the
 * call. On a block the handler never runs and the agent gets an actionable
 * tool error.
 */
import path from 'path';

import { getSessionRouting } from '../db/session-routing.js';
import type { ToolMiddleware } from '../mcp-tools/server.js';
import { checkOutputTexts } from './output-check.js';
import { collectStringLeaves } from './rules.js';

type TextExtractor = (args: Record<string, unknown>) => string[];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const EXTRACTORS: Record<string, TextExtractor | null> = {
  send_message: (a) => [str(a.text)],
  edit_message: (a) => [str(a.text)],
  // Caption and display filename are both delivered (shown in chat) — file
  // CONTENTS are a documented coverage gap. Runs even with an empty caption
  // so an invalid config still blocks.
  send_file: (a) => [str(a.text), str(a.filename) || path.basename(str(a.path))],
  // Each delivered field is its own entry — joining them would break
  // anchored regexes and could split keyphrases across fields.
  ask_user_question: (a) => [
    str(a.title),
    str(a.question),
    ...(Array.isArray(a.options)
      ? a.options.flatMap((o): string[] => {
          if (typeof o === 'string') return [o];
          if (o && typeof o === 'object') {
            const opt = o as Record<string, unknown>;
            return [str(opt.label), str(opt.selectedLabel), str(opt.value)];
          }
          return [];
        })
      : []),
  ],
  // The card's string leaves are scanned raw — scanning JSON.stringify(card)
  // would let JSON escaping defeat keyphrases containing quotes or newlines.
  send_card: (a) => [...collectStringLeaves(a.card), str(a.fallbackText)],
  // Exempt: add_reaction carries only an emoji name, no free text.
  add_reaction: null,
};

export const guardrailsToolMiddleware: ToolMiddleware = async (name, args, next) => {
  const extractor = name in EXTRACTORS ? EXTRACTORS[name] : undefined;
  if (extractor === undefined) return next(); // unmapped — host delivery gate backstops
  if (extractor === null) return next(); // exempt

  let blockedMessage: string | null = null;
  try {
    const r = getSessionRouting();
    const guard = checkOutputTexts(extractor(args), {
      channel_type: r.channel_type,
      platform_id: r.platform_id,
      thread_id: r.thread_id,
    });
    if (guard.blocked) blockedMessage = guard.message ?? 'Message blocked by output guardrail.';
  } catch {
    blockedMessage = 'Output guardrails check failed — message blocked (failing closed). Do not retry.';
  }

  if (blockedMessage !== null) {
    return { content: [{ type: 'text' as const, text: `Error: ${blockedMessage}` }], isError: true };
  }
  return next();
};
