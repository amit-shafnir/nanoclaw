/**
 * Generic container-side module hook registries.
 *
 * Optional modules attach to the poll loop by registering hooks at import
 * time from the modules barrel (src/modules.ts). Core calls the run*
 * functions at fixed choke points; with nothing registered every run* is a
 * pass-through, so trunk behavior is unchanged until a module registers.
 *
 * The registries are deliberately dumb: no try/catch, no policy. A hook that
 * must fail open or closed implements that inside itself.
 *
 * This file must stay a leaf module (type-only imports) so modules can
 * import it without creating ESM cycles with poll-loop.
 */
import type { MessageInRow } from './db/messages-in.js';
import type { RoutingContext } from './formatter.js';

/**
 * Inbound batch hook. Runs on every batch the poll loop is about to hand to
 * the provider — the initial wake batch and each follow-up push — BEFORE the
 * scheduling pre-task scripts, so a message a hook drops never runs a script
 * or reaches any prompt. Hooks chain: each receives the previous hook's
 * `keep`; `blockedIds` accumulate across hooks (the caller marks them
 * completed).
 */
export type InboundBatchPhase = 'initial' | 'followup';

export interface InboundBatchResult {
  keep: MessageInRow[];
  blockedIds: string[];
}

export type InboundBatchHook = (
  messages: MessageInRow[],
  routing: RoutingContext,
  phase: InboundBatchPhase,
) => InboundBatchResult | Promise<InboundBatchResult>;

const inboundBatchHooks: InboundBatchHook[] = [];

export function registerInboundBatchHook(hook: InboundBatchHook): void {
  inboundBatchHooks.push(hook);
}

export async function runInboundBatchHooks(
  messages: MessageInRow[],
  routing: RoutingContext,
  phase: InboundBatchPhase,
): Promise<InboundBatchResult> {
  let keep = messages;
  const blockedIds: string[] = [];
  for (const hook of inboundBatchHooks) {
    const result = await hook(keep, routing, phase);
    keep = result.keep;
    blockedIds.push(...result.blockedIds);
  }
  return { keep, blockedIds };
}

/**
 * Result-text hook. Runs on the provider's final result text before
 * dispatchResultText parses it for <message> blocks. Hooks chain on the
 * text; returning null suppresses dispatch entirely (short-circuits any
 * remaining hooks).
 */
export type ResultTextHook = (text: string, routing: RoutingContext) => string | null | Promise<string | null>;

const resultTextHooks: ResultTextHook[] = [];

export function registerResultTextHook(hook: ResultTextHook): void {
  resultTextHooks.push(hook);
}

export async function runResultTextHooks(text: string, routing: RoutingContext): Promise<string | null> {
  let current = text;
  for (const hook of resultTextHooks) {
    const result = await hook(current, routing);
    if (result === null) return null;
    current = result;
  }
  return current;
}
