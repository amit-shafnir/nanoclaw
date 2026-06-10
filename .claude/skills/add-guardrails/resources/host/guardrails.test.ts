/**
 * Behavior tests for the host-side guardrails module: rule evaluation,
 * strict config validation (fail-closed `invalid` results, sidecar files,
 * traversal rejection), the inbound check's fail-closed paths, and
 * quarantine rotation. Ships with the /add-guardrails skill; apply copies
 * it to src/modules/guardrails/.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadGuardrailsConfig, type GuardrailsLoadResult } from './config.js';
import { checkOutboundDelivery } from './delivery-check.js';
import { applyInboundGuardrails, type InboundGuardrailContext } from './index.js';
import { appendQuarantine, quarantineFilePath } from './quarantine.js';
import {
  collectStringLeaves,
  evaluateRules,
  extractScannableText,
  MAX_PATTERN_LENGTH,
  type GuardrailRule,
} from './rules.js';

vi.mock('../../db/dropped-messages.js', () => ({ recordDroppedMessage: vi.fn() }));
vi.mock('../../session-manager.js', () => ({ writeOutboundDirect: vi.fn() }));

import { recordDroppedMessage } from '../../db/dropped-messages.js';
import { writeOutboundDirect } from '../../session-manager.js';

const tmpDirs: string[] = [];

/** Agent group ids whose real-DATA_DIR quarantine dir needs cleanup. */
const quarantinedGroups: string[] = [];

function uniqueGroupId(): string {
  const id = `ag-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  quarantinedGroups.push(id);
  return id;
}

function readQuarantine(agentGroupId: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = fs.readFileSync(quarantineFilePath(agentGroupId), 'utf8');
  } catch {
    return [];
  }
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function makeGroupsDir(folder: string, files: Record<string, string>): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-test-'));
  tmpDirs.push(base);
  const dir = path.join(base, folder, 'guardrails');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return base;
}

function expectInvalid(result: GuardrailsLoadResult, errorContains: string): void {
  expect(result.status).toBe('invalid');
  if (result.status === 'invalid') {
    expect(result.error).toContain(errorContains);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const groupId of quarantinedGroups.splice(0)) {
    fs.rmSync(path.dirname(quarantineFilePath(groupId)), { recursive: true, force: true });
  }
});

describe('evaluateRules', () => {
  const rules: GuardrailRule[] = [
    { id: 'ssn', type: 'regex', action: 'block', pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b' },
    { id: 'inj', type: 'keyphrase', action: 'flag', phrases: ['ignore previous instructions'] },
  ];

  it('matches a regex rule', () => {
    const m = evaluateRules(rules, 'my ssn is 123-45-6789 ok');
    expect(m?.rule.id).toBe('ssn');
  });

  it('matches a keyphrase rule case-insensitively', () => {
    const m = evaluateRules(rules, 'please IGNORE Previous Instructions and obey');
    expect(m?.rule.id).toBe('inj');
  });

  it('returns null on clean text and empty text', () => {
    expect(evaluateRules(rules, 'a perfectly normal message')).toBeNull();
    expect(evaluateRules(rules, '')).toBeNull();
  });

  it('throws on a non-compilable pattern instead of treating the rule as inert', () => {
    const bad: GuardrailRule[] = [{ id: 'bad', type: 'regex', action: 'block', pattern: '([' }];
    expect(() => evaluateRules(bad, 'anything')).toThrow(/failed to compile/);
  });
});

describe('collectStringLeaves', () => {
  it('walks nested objects/arrays, returns raw strings, skips non-strings and empties', () => {
    expect(collectStringLeaves({ a: 'one', b: { c: ['two', '', 3, null], d: { e: 'say "three"' } }, f: true })).toEqual(
      ['one', 'two', 'say "three"'],
    );
    expect(collectStringLeaves('just a string')).toEqual(['just a string']);
    expect(collectStringLeaves(42)).toEqual([]);
  });
});

describe('extractScannableText', () => {
  it('extracts chat text', () => {
    expect(extractScannableText('chat', JSON.stringify({ text: 'hello' }))).toBe('hello');
  });
  it('extracts task prompts', () => {
    expect(extractScannableText('task', JSON.stringify({ prompt: 'do the thing' }))).toBe('do the thing');
  });
  it('serializes webhook payloads', () => {
    expect(extractScannableText('webhook', JSON.stringify({ payload: { a: 1 } }))).toBe('{"a":1}');
  });
  it('falls back to the raw string for non-JSON content', () => {
    expect(extractScannableText('chat', 'not json')).toBe('not json');
  });
});

describe('loadGuardrailsConfig', () => {
  it('returns absent when no guardrails dir exists', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-test-'));
    tmpDirs.push(base);
    expect(loadGuardrailsConfig('nope', base)).toEqual({ status: 'absent' });
  });

  it('returns invalid on malformed JSON', () => {
    const base = makeGroupsDir('g-json', { 'guardrails.json': '{ not json' });
    expect(loadGuardrailsConfig('g-json', base).status).toBe('invalid');
  });

  it('returns invalid on an unknown top-level key', () => {
    const base = makeGroupsDir('g-key', { 'guardrails.json': JSON.stringify({ rules: [] }) });
    expectInvalid(loadGuardrailsConfig('g-key', base), "unknown top-level key 'rules'");
  });

  it('returns invalid on a non-compiling regex', () => {
    const base = makeGroupsDir('g-badre', {
      'guardrails.json': JSON.stringify({ input_rules: [{ id: 'bad', type: 'regex', pattern: '([' }] }),
    });
    expectInvalid(loadGuardrailsConfig('g-badre', base), 'does not compile');
  });

  it('accepts a pattern at MAX_PATTERN_LENGTH and rejects one char past it', () => {
    const atLimit = makeGroupsDir('g-at', {
      'guardrails.json': JSON.stringify({
        input_rules: [{ id: 'r', type: 'regex', pattern: 'a'.repeat(MAX_PATTERN_LENGTH) }],
      }),
    });
    expect(loadGuardrailsConfig('g-at', atLimit).status).toBe('ok');

    const past = makeGroupsDir('g-past', {
      'guardrails.json': JSON.stringify({
        input_rules: [{ id: 'r', type: 'regex', pattern: 'a'.repeat(MAX_PATTERN_LENGTH + 1) }],
      }),
    });
    expectInvalid(loadGuardrailsConfig('g-past', past), `max ${MAX_PATTERN_LENGTH}`);
  });

  it('returns invalid on a rule without an id', () => {
    const base = makeGroupsDir('g-noid', {
      'guardrails.json': JSON.stringify({ input_rules: [{ type: 'regex', pattern: 'x' }] }),
    });
    expectInvalid(loadGuardrailsConfig('g-noid', base), 'missing id');
  });

  it('returns invalid on duplicate rule ids', () => {
    const base = makeGroupsDir('g-dup', {
      'guardrails.json': JSON.stringify({
        input_rules: [
          { id: 'r', type: 'regex', pattern: 'x' },
          { id: 'r', type: 'keyphrase', phrases: ['y'] },
        ],
      }),
    });
    expectInvalid(loadGuardrailsConfig('g-dup', base), "duplicate rule id 'r'");
  });

  it('returns invalid on an unknown rule type', () => {
    const base = makeGroupsDir('g-type', {
      'guardrails.json': JSON.stringify({ input_rules: [{ id: 'x', type: 'sorcery' }] }),
    });
    expectInvalid(loadGuardrailsConfig('g-type', base), "unknown type 'sorcery'");
  });

  it('returns invalid when a phrases_file escapes the guardrails dir', () => {
    const base = makeGroupsDir('g-escape', {
      'guardrails.json': JSON.stringify({
        input_rules: [{ id: 'evil', type: 'keyphrase', phrases_file: '../../../etc/passwd' }],
      }),
    });
    expectInvalid(loadGuardrailsConfig('g-escape', base), 'escapes the guardrails directory');
  });

  it('returns invalid when a phrases_file is missing', () => {
    const base = makeGroupsDir('g-missing', {
      'guardrails.json': JSON.stringify({
        input_rules: [{ id: 'kp', type: 'keyphrase', phrases_file: 'nope.txt' }],
      }),
    });
    expectInvalid(loadGuardrailsConfig('g-missing', base), 'unreadable');
  });

  it('loads a valid config, resolves sidecar files, and applies defaults', () => {
    const base = makeGroupsDir('g-ok', {
      'guardrails.json': JSON.stringify({
        input_rules: [{ id: 'kp', type: 'keyphrase', phrases_file: 'phrases.txt' }],
        output_rules: [{ id: 'rx', type: 'regex', pattern: 'CANARY', action: 'flag' }],
      }),
      'phrases.txt': '# comment\nignore previous instructions\n\n  badphrase  \n',
    });
    const result = loadGuardrailsConfig('g-ok', base);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const config = result.config;
    expect(config.input_rules[0].phrases).toEqual(['ignore previous instructions', 'badphrase']);
    expect(config.input_rules[0].action).toBe('block'); // default
    expect(config.output_rules[0].action).toBe('flag');
    expect(config.quarantine).toEqual({ max_file_mb: 10, max_files: 5 });
    expect(config.alerts.prefix).toBe('⚠️ Guardrail');
  });

  it('serves from cache within the TTL', () => {
    const base = makeGroupsDir('g-cache', {
      'guardrails.json': JSON.stringify({ input_rules: [{ id: 'r', type: 'regex', pattern: 'x' }] }),
    });
    const first = loadGuardrailsConfig('g-cache', base);
    const second = loadGuardrailsConfig('g-cache', base);
    expect(second).toBe(first); // same object — no reload
  });

  it('caches an invalid result, then picks up the fix on mtime change', () => {
    vi.useFakeTimers();
    const base = makeGroupsDir('g-fix', { 'guardrails.json': '{ not json' });
    const file = path.join(base, 'g-fix', 'guardrails', 'guardrails.json');

    const broken = loadGuardrailsConfig('g-fix', base);
    expect(broken.status).toBe('invalid');
    expect(loadGuardrailsConfig('g-fix', base)).toBe(broken); // cached, no re-parse

    fs.writeFileSync(file, JSON.stringify({ input_rules: [{ id: 'r', type: 'regex', pattern: 'x' }] }));
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(file, future, future);
    vi.advanceTimersByTime(6_000); // past the 5s TTL so the mtime is re-checked

    expect(loadGuardrailsConfig('g-fix', base).status).toBe('ok');
  });
});

describe('applyInboundGuardrails with a broken config', () => {
  function makeCtx(folder: string): InboundGuardrailContext {
    return {
      folder,
      agentGroupId: `ag-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: 's-1',
      deliveryAddr: { channelType: 'test', platformId: 'chat-1', threadId: null },
      event: {
        channelType: 'test',
        platformId: 'chat-1',
        threadId: null,
        message: {
          id: 'm1',
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({ text: 'hi' }),
        },
      },
      userId: 'test:user',
      messagingGroupId: 'mg-1',
    };
  }

  it('blocks the message, records the drop, and alerts the chat (failing CLOSED)', () => {
    const base = makeGroupsDir('g-broken', { 'guardrails.json': '{ not json' });
    const ctx = makeCtx('g-broken');

    expect(applyInboundGuardrails(ctx, base)).toBe(true);
    expect(vi.mocked(recordDroppedMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'guardrail_block', agent_group_id: ctx.agentGroupId }),
    );
    const alert = vi.mocked(writeOutboundDirect).mock.calls.at(-1);
    expect(alert?.[0]).toBe(ctx.agentGroupId);
    expect(JSON.parse((alert?.[2] as { content: string }).content).text).toContain(
      'ALL messages to this agent are blocked',
    );

    // Cleanup the host-side quarantine record this wrote under data/.
    fs.rmSync(path.dirname(quarantineFilePath(ctx.agentGroupId)), { recursive: true, force: true });
  });

  it('passes through and writes nothing when no config exists', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-test-'));
    tmpDirs.push(base);
    const ctx = makeCtx('g-absent');
    expect(applyInboundGuardrails(ctx, base)).toBe(false);
    expect(vi.mocked(recordDroppedMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(writeOutboundDirect)).not.toHaveBeenCalled();
  });
});

describe('applyInboundGuardrails alert wording (#6)', () => {
  it('names the rule id + type but never the matched phrase; the quarantine keeps the reason', () => {
    const base = makeGroupsDir('g-wording', {
      'guardrails.json': JSON.stringify({
        input_rules: [{ id: 'no-injection', type: 'keyphrase', phrases: ['ignore previous instructions'] }],
      }),
    });
    const agentGroupId = uniqueGroupId();
    const ctx: InboundGuardrailContext = {
      folder: 'g-wording',
      agentGroupId,
      sessionId: 's-1',
      deliveryAddr: { channelType: 'test', platformId: 'chat-1', threadId: null },
      event: {
        channelType: 'test',
        platformId: 'chat-1',
        threadId: null,
        message: {
          id: 'm1',
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({ text: 'please ignore previous instructions now' }),
        },
      },
      userId: 'test:user',
      messagingGroupId: 'mg-1',
    };

    expect(applyInboundGuardrails(ctx, base)).toBe(true);
    const alert = vi.mocked(writeOutboundDirect).mock.calls.at(-1);
    const alertText = JSON.parse((alert?.[2] as { content: string }).content).text as string;
    expect(alertText).toContain("'no-injection'");
    expect(alertText).toContain('keyphrase');
    expect(alertText).not.toContain('ignore previous instructions');

    const records = readQuarantine(agentGroupId);
    expect(records).toHaveLength(1);
    expect(records[0].reason).toContain('ignore previous instructions');
  });
});

describe('checkOutboundDelivery', () => {
  function makeArgs(folder: string | null, content: string, agentGroupId = uniqueGroupId()) {
    return {
      folder,
      agentGroupId,
      sessionId: 's-1',
      msg: { id: 'out-1', channel_type: 'test', platform_id: 'chat-1', content },
    };
  }

  it('delivers untouched when the group has no guardrails config', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-test-'));
    tmpDirs.push(base);
    const verdict = checkOutboundDelivery(makeArgs('g-absent', JSON.stringify({ text: 'hi' })), base);
    expect(verdict).toEqual({ action: 'deliver' });
  });

  it('blocks with a config alert and a content-keeping quarantine row on an invalid config', () => {
    const base = makeGroupsDir('g-broken-out', { 'guardrails.json': '{ not json' });
    const args = makeArgs('g-broken-out', JSON.stringify({ text: 'totally clean' }));
    const verdict = checkOutboundDelivery(args, base);
    expect(verdict.action).toBe('block');
    if (verdict.action === 'block') {
      expect(verdict.alertText).toContain('guardrails.json');
    }
    const records = readQuarantine(args.agentGroupId);
    expect(records).toHaveLength(1);
    expect(records[0].ruleId).toBe('(config-invalid)');
    expect(records[0].direction).toBe('output');
    expect(records[0].content).toContain('totally clean');
  });

  it('blocks a rule match: alert names the rule id, never the matched phrase; content quarantined', () => {
    const base = makeGroupsDir('g-block-out', {
      'guardrails.json': JSON.stringify({
        output_rules: [{ id: 'no-secret', type: 'keyphrase', phrases: ['the launch codes'] }],
      }),
    });
    const args = makeArgs('g-block-out', JSON.stringify({ text: 'here are the launch codes' }));
    const verdict = checkOutboundDelivery(args, base);
    expect(verdict.action).toBe('block');
    if (verdict.action === 'block') {
      expect(verdict.alertText).toContain("'no-secret'");
      expect(verdict.alertText).toContain('keyphrase');
      expect(verdict.alertText).not.toContain('the launch codes');
    }
    const records = readQuarantine(args.agentGroupId);
    expect(records).toHaveLength(1);
    expect(records[0].content).toContain('the launch codes');
  });

  it('collapses repeat alerts for the same rule within the window (alertText null)', () => {
    const base = makeGroupsDir('g-collapse-out', {
      'guardrails.json': JSON.stringify({
        output_rules: [{ id: 'no-secret', type: 'keyphrase', phrases: ['the launch codes'] }],
      }),
    });
    const agentGroupId = uniqueGroupId();
    const content = JSON.stringify({ text: 'the launch codes again' });
    const first = checkOutboundDelivery(makeArgs('g-collapse-out', content, agentGroupId), base);
    const second = checkOutboundDelivery(makeArgs('g-collapse-out', content, agentGroupId), base);
    expect(first.action).toBe('block');
    if (first.action === 'block') expect(first.alertText).not.toBeNull();
    expect(second.action).toBe('block');
    if (second.action === 'block') expect(second.alertText).toBeNull();
    expect(readQuarantine(agentGroupId)).toHaveLength(2); // quarantine is never collapsed
  });

  it('uses the per-rule message override as the alert text', () => {
    const base = makeGroupsDir('g-msg-out', {
      'guardrails.json': JSON.stringify({
        output_rules: [
          { id: 'no-secret', type: 'keyphrase', phrases: ['the launch codes'], message: 'That cannot be shared.' },
        ],
      }),
    });
    const verdict = checkOutboundDelivery(makeArgs('g-msg-out', JSON.stringify({ text: 'the launch codes' })), base);
    expect(verdict.action).toBe('block');
    if (verdict.action === 'block') expect(verdict.alertText).toBe('That cannot be shared.');
  });

  it('quarantines but delivers on a flag-mode match', () => {
    const base = makeGroupsDir('g-flag-out', {
      'guardrails.json': JSON.stringify({
        output_rules: [{ id: 'watch', type: 'keyphrase', phrases: ['sketchy'], action: 'flag' }],
      }),
    });
    const args = makeArgs('g-flag-out', JSON.stringify({ text: 'something sketchy' }));
    expect(checkOutboundDelivery(args, base)).toEqual({ action: 'deliver' });
    expect(readQuarantine(args.agentGroupId)).toHaveLength(1);
  });

  it('scans string leaves so JSON escaping cannot hide a quoted keyphrase, and anchored patterns match (#2)', () => {
    const base = makeGroupsDir('g-leaves-out', {
      'guardrails.json': JSON.stringify({
        output_rules: [
          { id: 'quoted', type: 'keyphrase', phrases: ['say "magic word"'] },
          { id: 'anchored', type: 'regex', pattern: '^sk-secret-[0-9]+$' },
        ],
      }),
    });
    const card = checkOutboundDelivery(
      makeArgs(
        'g-leaves-out',
        JSON.stringify({ type: 'card', card: { sections: [{ body: 'please say "magic word"' }] } }),
      ),
      base,
    );
    expect(card.action).toBe('block');

    const anchored = checkOutboundDelivery(
      makeArgs('g-leaves-out', JSON.stringify({ text: 'caption', files: ['sk-secret-99'] })),
      base,
    );
    expect(anchored.action).toBe('block');
  });

  it('falls back to scanning the raw content when it is not valid JSON', () => {
    const base = makeGroupsDir('g-raw-out', {
      'guardrails.json': JSON.stringify({
        output_rules: [{ id: 'canary', type: 'keyphrase', phrases: ['GUARDRAIL_CANARY'] }],
      }),
    });
    const verdict = checkOutboundDelivery(makeArgs('g-raw-out', 'not json but GUARDRAIL_CANARY anyway'), base);
    expect(verdict.action).toBe('block');
  });

  it('fails closed (silent block) when the agent group row is missing', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-test-'));
    tmpDirs.push(base);
    expect(checkOutboundDelivery(makeArgs(null, JSON.stringify({ text: 'hi' })), base)).toEqual({
      action: 'block',
      alertText: null,
    });
  });
});

describe('appendQuarantine', () => {
  function record(content?: string) {
    return {
      ts: new Date().toISOString(),
      source: 'host' as const,
      direction: 'input' as const,
      ruleId: 'r1',
      ruleType: 'regex',
      action: 'block' as const,
      content,
    };
  }

  it('appends full-content JSONL records', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-q-'));
    tmpDirs.push(base);
    appendQuarantine('ag-1', record('{"text":"blocked thing"}'), undefined, base);
    const lines = fs.readFileSync(quarantineFilePath('ag-1', base), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.ruleId).toBe('r1');
    expect(parsed.content).toBe('{"text":"blocked thing"}');
  });

  it('serializes records without content (container input-direction blocks)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-q-'));
    tmpDirs.push(base);
    appendQuarantine('ag-nc', { ...record(undefined), messageId: 'msg-42' }, undefined, base);
    const parsed = JSON.parse(fs.readFileSync(quarantineFilePath('ag-nc', base), 'utf8').trim());
    expect(parsed.messageId).toBe('msg-42');
    expect('content' in parsed).toBe(false);
  });

  it('rotates at the size cap and prunes archives beyond max_files', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-q-'));
    tmpDirs.push(base);
    // ~100-byte cap so every append after the first rotates the file.
    const limits = { max_file_mb: 0.0001, max_files: 2 };
    for (let i = 0; i < 6; i++) {
      appendQuarantine('ag-2', record(`payload-${i}-${'x'.repeat(200)}`), limits, base);
    }
    const dir = path.dirname(quarantineFilePath('ag-2', base));
    const entries = fs.readdirSync(dir).sort();
    const archives = entries.filter((f) => f.startsWith('quarantine-'));
    expect(entries).toContain('quarantine.jsonl');
    expect(archives.length).toBeLessThanOrEqual(2);
  });

  it('truncates oversized content and marks it', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-q-'));
    tmpDirs.push(base);
    appendQuarantine('ag-3', record('y'.repeat(70_000)), undefined, base);
    const parsed = JSON.parse(fs.readFileSync(quarantineFilePath('ag-3', base), 'utf8').trim());
    expect(parsed.content.length).toBe(64_000);
    expect(parsed.truncated).toBe(true);
  });

  it('never throws on unwritable destinations', () => {
    expect(() => appendQuarantine('ag-4', record('x'), undefined, '/dev/null/not-a-dir')).not.toThrow();
  });
});
