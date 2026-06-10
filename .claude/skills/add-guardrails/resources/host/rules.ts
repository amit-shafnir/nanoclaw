/**
 * Guardrail rule evaluation — pure, synchronous, in-process.
 *
 * Two byte-identical copies live at src/modules/guardrails/rules.ts (host)
 * and container/agent-runner/src/guardrails/rules.ts (container) — the two
 * trees share no modules by design, so the /add-guardrails skill ships the
 * same source into both. src/guardrails-wiring.test.ts asserts byte identity,
 * so an edit to one copy goes red until mirrored to the other.
 */

export type GuardrailAction = 'block' | 'flag';

export interface GuardrailRule {
  id: string;
  type: 'regex' | 'keyphrase';
  /** 'block' drops the message; 'flag' lets it through but alerts + audits. */
  action: GuardrailAction;
  /** Optional alert-text override shown in the chat instead of the default. */
  message?: string;
  // regex rules
  pattern?: string;
  flags?: string;
  // keyphrase rules (a `phrases_file` is resolved into `phrases` by the config loader)
  phrases?: string[];
}

export interface RuleMatch {
  rule: GuardrailRule;
  reason: string;
}

/**
 * V8 regexes cannot be timed out synchronously, so a hostile pattern could
 * stall the process on attacker-controlled text. Capping pattern size is the
 * cheap mitigation; SKILL.md adds safe-pattern guidance (anchors, bounded
 * quantifiers, no nested quantifiers).
 */
export const MAX_PATTERN_LENGTH = 1024;

const regexCache = new Map<string, RegExp | null>();

function compileRegex(pattern: string, flags?: string): RegExp | null {
  // Strip stateful flags — a cached 'g'/'y' regex carries lastIndex across
  // calls and silently skips matches.
  const safeFlags = (flags ?? '').replace(/[gy]/g, '');
  const key = `${pattern} ${safeFlags}`;
  if (!regexCache.has(key)) {
    try {
      regexCache.set(key, new RegExp(pattern, safeFlags));
    } catch {
      regexCache.set(key, null);
    }
  }
  return regexCache.get(key) ?? null;
}

/**
 * Evaluate regex + keyphrase rules against a text; first match wins.
 *
 * Throws if a regex rule fails to compile: config validation guarantees every
 * pattern compiles, so a null compile here is a broken invariant — callers
 * catch and fail CLOSED (block) rather than treating the rule as inert.
 */
export function evaluateRules(rules: GuardrailRule[], text: string): RuleMatch | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const rule of rules) {
    if (rule.type === 'regex' && rule.pattern) {
      const re = compileRegex(rule.pattern, rule.flags);
      if (!re) {
        throw new Error(`guardrail rule '${rule.id}': pattern failed to compile post-validation`);
      }
      if (re.test(text)) {
        return { rule, reason: `regex /${rule.pattern}/ matched` };
      }
    } else if (rule.type === 'keyphrase' && Array.isArray(rule.phrases)) {
      const hit = rule.phrases.find((p) => p && lower.includes(p.toLowerCase()));
      if (hit) {
        return { rule, reason: `keyphrase "${hit}" matched` };
      }
    }
  }
  return null;
}

/**
 * Collect every string leaf in a JSON-ish value (strings inside objects and
 * arrays, at any depth). Structured content (cards, parsed message blobs) is
 * scanned leaf-by-leaf as raw strings — scanning the JSON.stringify'd form
 * instead would let escaping (\" and \n become literal backslash sequences)
 * defeat keyphrases containing quotes or newlines.
 */
export function collectStringLeaves(value: unknown): string[] {
  const leaves: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v) leaves.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v && typeof v === 'object') {
      for (const item of Object.values(v)) walk(item);
    }
  };
  walk(value);
  return leaves;
}

/**
 * Extract the scannable text from a message-content JSON blob.
 * Chat messages carry `.text`; tasks carry `.prompt`; webhooks are scanned
 * as their serialized payload (articles/events can carry injection too).
 */
export function extractScannableText(kind: string, contentJson: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return contentJson;
  }
  if (typeof parsed.text === 'string' && parsed.text) return parsed.text;
  if (kind === 'task' && typeof parsed.prompt === 'string') return parsed.prompt;
  if (kind === 'webhook') {
    try {
      return JSON.stringify(parsed.payload ?? parsed);
    } catch {
      return '';
    }
  }
  return '';
}
