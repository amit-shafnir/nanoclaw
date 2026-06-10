/**
 * Container-side guardrails tests (bun:test — NOT vitest; this tree runs on
 * Bun and uses bun:sqlite). Uses initTestSessionDb() for real in-memory
 * session DBs so alert/quarantine writes land in messages_out.
 *
 * Ships with the /add-guardrails skill; apply copies it to
 * container/agent-runner/src/guardrails/.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import type { MessageInRow } from '../db/messages-in.js';
import type { RoutingContext } from '../formatter.js';
import { loadGuardrailsConfig, setGuardrailsDirForTest } from './config.js';
import { applyInputGuardrails } from './input-check.js';
import { applyOutputGuardrails, checkOutputTexts, resetEscalationForTest } from './output-check.js';
import { resetAlertCollapseForTest } from './quarantine.js';
import { collectStringLeaves, evaluateRules, type GuardrailRule } from './rules.js';

const tmpDirs: string[] = [];
let ruleSeq = 0;

/** Write a guardrails dir with the given config and point the loader at it. */
function useConfig(config: Record<string, unknown>, sidecars: Record<string, string> = {}): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-bun-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'guardrails.json'), JSON.stringify(config));
  for (const [name, content] of Object.entries(sidecars)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  setGuardrailsDirForTest(dir);
}

/** Point the loader at a guardrails.json that is not valid JSON. */
function useBrokenConfig(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-bun-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'guardrails.json'), '{ not json');
  setGuardrailsDirForTest(dir);
}

/** Unique rule ids so the alert collapse window never bleeds across cases. */
function rid(name: string): string {
  return `${name}-${++ruleSeq}`;
}

function chatMsg(id: string, text: string): MessageInRow {
  return {
    id,
    seq: null,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: 'chat-1',
    channel_type: 'test',
    thread_id: null,
    content: JSON.stringify({ text }),
  };
}

const routing: RoutingContext = { platformId: 'chat-1', channelType: 'test', threadId: null, inReplyTo: null };

function outboundRows(): Array<{ kind: string; content: string }> {
  return getOutboundDb().prepare('SELECT kind, content FROM messages_out ORDER BY seq').all() as Array<{
    kind: string;
    content: string;
  }>;
}

function quarantineRecords(): Array<Record<string, unknown>> {
  return outboundRows()
    .filter((r) => r.kind === 'system')
    .map((r) => JSON.parse(r.content))
    .filter((c) => c.action === 'guardrail_quarantine')
    .map((c) => c.record as Record<string, unknown>);
}

beforeEach(() => {
  initTestSessionDb();
  resetAlertCollapseForTest();
  resetEscalationForTest();
});

afterEach(() => {
  closeSessionDb();
  setGuardrailsDirForTest('/workspace/agent/guardrails');
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('config loading', () => {
  it('returns absent without a config and loads sidecar files when present', () => {
    setGuardrailsDirForTest(path.join(os.tmpdir(), `guardrails-none-${Date.now()}`));
    expect(loadGuardrailsConfig()).toEqual({ status: 'absent' });

    useConfig(
      { input_rules: [{ id: 'kp', type: 'keyphrase', phrases_file: 'p.txt' }] },
      { 'p.txt': 'bad phrase\n# comment\n' },
    );
    const result = loadGuardrailsConfig();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.config.input_rules[0].phrases).toEqual(['bad phrase']);
    }
  });

  it('returns invalid on an unknown top-level key', () => {
    useConfig({ input_rules: [], rules: [] });
    const result = loadGuardrailsConfig();
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.error).toContain("unknown top-level key 'rules'");
    }
  });
});

describe('applyInputGuardrails', () => {
  it('passes everything through when no config exists', () => {
    setGuardrailsDirForTest(path.join(os.tmpdir(), `guardrails-none-${Date.now()}`));
    const messages = [chatMsg('m1', 'hello')];
    const out = applyInputGuardrails(messages, routing);
    expect(out.keep).toEqual(messages);
    expect(out.blockedIds).toEqual([]);
    expect(outboundRows()).toHaveLength(0);
  });

  it('blocks on a regex rule; the quarantine record carries messageId but never content', () => {
    const id = rid('canary');
    useConfig({ input_rules: [{ id, type: 'regex', pattern: 'GUARDRAIL_CANARY' }] });
    const out = applyInputGuardrails([chatMsg('m1', 'say GUARDRAIL_CANARY now'), chatMsg('m2', 'clean')], routing);
    expect(out.blockedIds).toEqual(['m1']);
    expect(out.keep.map((m) => m.id)).toEqual(['m2']);

    const alert = outboundRows().find((r) => r.kind === 'chat');
    expect(alert).toBeDefined();
    expect(JSON.parse(alert!.content).text).toContain(id);

    const records = quarantineRecords();
    expect(records).toHaveLength(1);
    expect(records[0].ruleId).toBe(id);
    expect(records[0].messageId).toBe('m1');
    // Blocked INPUT text must never travel through agent-readable outbound.db.
    expect(records[0].content).toBeUndefined();
  });

  it('keeps flag-mode matches but still alerts + quarantines (again without content)', () => {
    useConfig({ input_rules: [{ id: rid('flagger'), type: 'keyphrase', phrases: ['sketchy'], action: 'flag' }] });
    const out = applyInputGuardrails([chatMsg('m1', 'this is sketchy')], routing);
    expect(out.blockedIds).toEqual([]);
    expect(out.keep).toHaveLength(1);
    expect(outboundRows().map((r) => r.kind).sort()).toEqual(['chat', 'system']);
    expect(quarantineRecords()[0].content).toBeUndefined();
    expect(quarantineRecords()[0].messageId).toBe('m1');
  });

  it('blocks ALL messages on an invalid config, with one collapsed config alert', () => {
    useBrokenConfig();
    const out = applyInputGuardrails([chatMsg('m1', 'hello'), chatMsg('m2', 'world')], routing);
    expect(out.keep).toEqual([]);
    expect(out.blockedIds).toEqual(['m1', 'm2']);

    const records = quarantineRecords();
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.ruleId).toBe('(config-invalid)');
      expect(r.content).toBeUndefined();
    }
    expect(records.map((r) => r.messageId)).toEqual(['m1', 'm2']);

    const alerts = outboundRows().filter((r) => r.kind === 'chat');
    expect(alerts).toHaveLength(1); // collapsed — one alert for the whole condition
    expect(JSON.parse(alerts[0].content).text).toContain('ALL messages for this agent are blocked');
  });
});

describe('applyOutputGuardrails', () => {
  it('passes when no message blocks are present (scratchpad only)', () => {
    useConfig({ output_rules: [{ id: rid('canary'), type: 'regex', pattern: 'CANARY' }] });
    const result = applyOutputGuardrails('<internal>CANARY in scratchpad</internal>', routing);
    expect(result.text).not.toBeNull();
    expect(outboundRows()).toHaveLength(0);
  });

  it('blocks a matching result and the quarantine record KEEPS the content', () => {
    const id = rid('canary');
    useConfig({ output_rules: [{ id, type: 'regex', pattern: 'CANARY' }] });
    const result = applyOutputGuardrails('<message to="chat">here is CANARY</message>', routing);
    expect(result.text).toBeNull();
    const rows = outboundRows();
    expect(rows.some((r) => r.kind === 'chat' && JSON.parse(r.content).text.includes(id))).toBe(true);
    const records = quarantineRecords();
    expect(records).toHaveLength(1);
    // Output is agent-authored — full content is retained for the audit trail.
    expect(records[0].content).toContain('CANARY');
  });

  it('lets clean output through untouched', () => {
    useConfig({ output_rules: [{ id: rid('canary'), type: 'regex', pattern: 'CANARY' }] });
    const text = '<message to="chat">all clear</message>';
    const result = applyOutputGuardrails(text, routing);
    expect(result.text).toBe(text);
    expect(outboundRows()).toHaveLength(0);
  });

  it('blocks everything on an invalid config and alerts', () => {
    useBrokenConfig();
    const result = applyOutputGuardrails('<message to="chat">totally clean</message>', routing);
    expect(result.text).toBeNull();
    const alerts = outboundRows().filter((r) => r.kind === 'chat');
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(alerts[0].content).text).toContain('guardrails.json');
  });

  // Regression (#2): bodies are evaluated per-block — an anchored pattern
  // must match a block that is exactly the secret even when other blocks
  // surround it (the old join-with-\n broke ^…$).
  it('catches an anchored pattern when the secret is one of several message blocks', () => {
    const id = rid('anchored');
    useConfig({ output_rules: [{ id, type: 'regex', pattern: '^sk-secret-[0-9]+$' }] });
    const result = applyOutputGuardrails(
      '<message to="chat">here it comes</message>' +
        '<message to="chat">sk-secret-42</message>' +
        '<message to="chat">that was it</message>',
      routing,
    );
    expect(result.text).toBeNull();
  });

  // Regression (#6): the default chat alert names the rule but never quotes
  // the matched content/phrase.
  it('alerts with the rule id + type but never the matched phrase', () => {
    const id = rid('phrase');
    useConfig({ output_rules: [{ id, type: 'keyphrase', phrases: ['super secret plan'] }] });
    const result = applyOutputGuardrails('<message to="chat">the super secret plan is out</message>', routing);
    expect(result.text).toBeNull();
    const alert = outboundRows().find((r) => r.kind === 'chat');
    const alertText = JSON.parse(alert!.content).text as string;
    expect(alertText).toContain(id);
    expect(alertText).toContain('keyphrase');
    expect(alertText).not.toContain('super secret plan');
    // The quarantine record keeps the reason for audit.
    expect(quarantineRecords()[0].reason).toContain('super secret plan');
  });

  it('uses the per-rule message override as the alert text', () => {
    useConfig({
      output_rules: [
        { id: rid('custom'), type: 'keyphrase', phrases: ['forbidden thing'], message: 'Please rephrase that.' },
      ],
    });
    applyOutputGuardrails('<message to="chat">a forbidden thing</message>', routing);
    const alert = outboundRows().find((r) => r.kind === 'chat');
    expect(JSON.parse(alert!.content).text).toBe('Please rephrase that.');
  });
});

describe('checkOutputTexts (MCP send paths)', () => {
  const alertRouting = { channel_type: 'test', platform_id: 'chat-1', thread_id: null };

  it('blocks and returns an agent-facing error message, escalating after repeats', () => {
    const id = rid('canary');
    useConfig({ output_rules: [{ id, type: 'regex', pattern: 'CANARY' }] });

    const first = checkOutputTexts(['sending CANARY'], alertRouting);
    expect(first.blocked).toBe(true);
    expect(first.message).toContain(id);
    expect(first.message).not.toContain('stop attempting');

    checkOutputTexts(['sending CANARY again'], alertRouting);
    const third = checkOutputTexts(['sending CANARY thrice'], alertRouting);
    expect(third.message).toContain('stop attempting');

    // A clean send resets the escalation counter.
    const clean = checkOutputTexts(['all clear'], alertRouting);
    expect(clean.blocked).toBe(false);
    const blockedAgain = checkOutputTexts(['CANARY once more'], alertRouting);
    expect(blockedAgain.message).not.toContain('stop attempting');
  });

  it('blocks on an invalid config without bumping the escalation counter', () => {
    useBrokenConfig();
    for (let i = 0; i < 3; i++) {
      const blocked = checkOutputTexts(['anything at all'], alertRouting);
      expect(blocked.blocked).toBe(true);
      expect(blocked.ruleId).toBe('(config-invalid)');
      expect(blocked.message).toContain('misconfigured');
    }

    // Config-invalid blocks did not escalate: the first RULE block after the
    // config is fixed still gets the non-escalated wording.
    const id = rid('canary');
    useConfig({ output_rules: [{ id, type: 'regex', pattern: 'CANARY' }] });
    const ruleBlock = checkOutputTexts(['sending CANARY'], alertRouting);
    expect(ruleBlock.blocked).toBe(true);
    expect(ruleBlock.message).not.toContain('stop attempting');
  });

  // Regression (#2): texts are evaluated separately — anchored patterns
  // match an exact-secret entry, and a block in a later entry is not masked
  // by a flag in an earlier one.
  it('evaluates each text on its own and prefers block over flag', () => {
    const anchored = rid('anchored');
    useConfig({ output_rules: [{ id: anchored, type: 'regex', pattern: '^sk-secret-[0-9]+$' }] });
    expect(checkOutputTexts(['a caption', 'sk-secret-7'], alertRouting).blocked).toBe(true);

    const flagger = rid('flagger');
    const blocker = rid('blocker');
    useConfig({
      output_rules: [
        { id: flagger, type: 'keyphrase', phrases: ['sketchy'], action: 'flag' },
        { id: blocker, type: 'keyphrase', phrases: ['forbidden'] },
      ],
    });
    const verdict = checkOutputTexts(['this is sketchy', 'this is forbidden'], alertRouting);
    expect(verdict.blocked).toBe(true);
    expect(verdict.ruleId).toBe(blocker);
  });
});

describe('evaluateRules (shared copy)', () => {
  it('matches regex and keyphrase rules', () => {
    expect(evaluateRules([{ id: 'r', type: 'regex', action: 'block', pattern: 'x\\d+' }], 'abc x42')?.rule.id).toBe(
      'r',
    );
    expect(
      evaluateRules([{ id: 'k', type: 'keyphrase', action: 'block', phrases: ['Bad Phrase'] }], 'a bad phrase here')
        ?.rule.id,
    ).toBe('k');
  });

  it('throws on a non-compilable pattern instead of treating the rule as inert', () => {
    const bad: GuardrailRule[] = [{ id: 'bad', type: 'regex', action: 'block', pattern: '([' }];
    expect(() => evaluateRules(bad, 'anything')).toThrow();
  });

  it('collectStringLeaves walks nested objects/arrays and skips empty strings', () => {
    expect(
      collectStringLeaves({ a: 'one', b: { c: ['two', '', 3, null], d: { e: 'three' } }, f: true }),
    ).toEqual(['one', 'two', 'three']);
    expect(collectStringLeaves('just a string')).toEqual(['just a string']);
    expect(collectStringLeaves(42)).toEqual([]);
  });
});
