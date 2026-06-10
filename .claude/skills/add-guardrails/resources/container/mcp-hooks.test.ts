/**
 * Behavior tests for the guardrails MCP tool middleware (bun:test).
 *
 * Drives guardrailsToolMiddleware directly with a recording `next`: a block
 * must produce an isError result WITHOUT calling next (the handler never
 * runs), a pass must call next exactly once, exempt and unmapped tools must
 * pass untouched (the host delivery checkpoint backstops unmapped tools).
 *
 * Ships with the /add-guardrails skill; apply copies it to
 * container/agent-runner/src/guardrails/.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { setGuardrailsDirForTest } from './config.js';
import { resetEscalationForTest } from './output-check.js';
import { resetAlertCollapseForTest } from './quarantine.js';
import { guardrailsToolMiddleware } from './tool-middleware.js';

const tmpDirs: string[] = [];
let ruleSeq = 0;

function useConfig(config: Record<string, unknown>): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-mcp-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'guardrails.json'), JSON.stringify(config));
  setGuardrailsDirForTest(dir);
}

/** Unique rule ids so the alert collapse window never bleeds across cases. */
function rid(name: string): string {
  return `${name}-${++ruleSeq}`;
}

function useBlockRule(idName: string, phrases: string[]): string {
  const id = rid(idName);
  useConfig({ output_rules: [{ id, type: 'keyphrase', phrases }] });
  return id;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

/** Run the middleware with a recording next; returns result + handler call count. */
async function run(name: string, args: Record<string, unknown>): Promise<{ result: ToolResult; handlerCalls: number }> {
  let handlerCalls = 0;
  const result = (await guardrailsToolMiddleware(name, args, async () => {
    handlerCalls++;
    return { content: [{ type: 'text' as const, text: 'handler ran' }] };
  })) as ToolResult;
  return { result, handlerCalls };
}

/** Every chat-ish messages_out row's parsed content (alerts included). */
function deliverableContents(): Array<Record<string, unknown>> {
  return (
    getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind != 'system' ORDER BY seq").all() as Array<{
      content: string;
    }>
  ).map((r) => JSON.parse(r.content));
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

describe('send_message', () => {
  it('blocks a matching text: tool error, handler never runs, no deliverable row carries it', async () => {
    useBlockRule('canary', ['GUARDRAIL_CANARY']);
    const { result, handlerCalls } = await run('send_message', { text: 'leak GUARDRAIL_CANARY now' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('guardrail');
    expect(handlerCalls).toBe(0);
    // The alert row exists but no deliverable row contains the blocked text.
    for (const content of deliverableContents()) {
      expect(JSON.stringify(content)).not.toContain('GUARDRAIL_CANARY');
    }
  });

  it('lets clean text through to the handler', async () => {
    useBlockRule('canary', ['GUARDRAIL_CANARY']);
    const { result, handlerCalls } = await run('send_message', { text: 'all clear' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('handler ran');
    expect(handlerCalls).toBe(1);
  });
});

describe('send_file', () => {
  it('blocks on the display filename without the handler running (no path-exists leak)', async () => {
    useBlockRule('canary', ['sk-CANARY']);
    const { result, handlerCalls } = await run('send_file', {
      path: '/nonexistent/whatever.txt',
      text: '',
      filename: 'sk-CANARY.txt',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('guardrail');
    expect(handlerCalls).toBe(0);
  });

  it('falls back to the path basename when no filename arg is given', async () => {
    useBlockRule('canary', ['sk-CANARY']);
    const { result, handlerCalls } = await run('send_file', { path: '/tmp/sk-CANARY.txt' });
    expect(result.isError).toBe(true);
    expect(handlerCalls).toBe(0);
  });

  it('blocks on the caption', async () => {
    useBlockRule('canary', ['sk-CANARY']);
    const { result } = await run('send_file', { path: '/tmp/clean.txt', text: 'here is sk-CANARY' });
    expect(result.isError).toBe(true);
  });
});

describe('edit_message', () => {
  it('blocks smuggling blocked text into a previously sent message via edit', async () => {
    useBlockRule('canary', ['GUARDRAIL_CANARY']);
    const { result, handlerCalls } = await run('edit_message', { messageId: 1, text: 'now GUARDRAIL_CANARY' });
    expect(result.isError).toBe(true);
    expect(handlerCalls).toBe(0);
  });
});

describe('ask_user_question', () => {
  it('blocks on a matching option label (object form)', async () => {
    useBlockRule('canary', ['GUARDRAIL_CANARY']);
    const { result, handlerCalls } = await run('ask_user_question', {
      title: 'Pick one',
      question: 'Which?',
      options: ['fine', { label: 'GUARDRAIL_CANARY option' }],
    });
    expect(result.isError).toBe(true);
    expect(handlerCalls).toBe(0);
  });

  it('blocks on a matching string option', async () => {
    useBlockRule('canary', ['GUARDRAIL_CANARY']);
    const { result } = await run('ask_user_question', {
      title: 'Pick one',
      question: 'Which?',
      options: ['GUARDRAIL_CANARY'],
    });
    expect(result.isError).toBe(true);
  });
});

describe('send_card', () => {
  it('blocks a keyphrase containing quotes inside a nested card field (leaf scanning)', async () => {
    useBlockRule('quoted', ['say "magic word"']);
    // JSON.stringify(card) escapes the quotes (say \"magic word\"), which
    // would defeat the substring match — leaf scanning sees the raw string.
    const { result, handlerCalls } = await run('send_card', {
      card: { title: 'Outer', sections: [{ body: 'please say "magic word" twice' }] },
    });
    expect(result.isError).toBe(true);
    expect(handlerCalls).toBe(0);
  });

  it('scans the fallbackText too', async () => {
    useBlockRule('canary', ['GUARDRAIL_CANARY']);
    const { result } = await run('send_card', { card: { title: 'clean' }, fallbackText: 'GUARDRAIL_CANARY here' });
    expect(result.isError).toBe(true);
  });
});

describe('exemptions and backstop', () => {
  it('add_reaction is exempt — passes even with a block-everything rule', async () => {
    useConfig({ output_rules: [{ id: rid('all'), type: 'regex', pattern: '[\\s\\S]*' }] });
    const { result, handlerCalls } = await run('add_reaction', { messageId: 1, emoji: 'thumbs_up' });
    expect(result.isError).toBeUndefined();
    expect(handlerCalls).toBe(1);
  });

  it('unmapped tools pass through (host delivery checkpoint backstops them)', async () => {
    useConfig({ output_rules: [{ id: rid('all'), type: 'regex', pattern: '[\\s\\S]*' }] });
    const { result, handlerCalls } = await run('schedule_task', { prompt: 'anything at all' });
    expect(result.isError).toBeUndefined();
    expect(handlerCalls).toBe(1);
  });

  it('an invalid config blocks mapped tools (fail closed)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-mcp-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'guardrails.json'), '{ not json');
    setGuardrailsDirForTest(dir);

    const { result, handlerCalls } = await run('send_message', { text: 'anything' });
    expect(result.isError).toBe(true);
    expect(handlerCalls).toBe(0);
  });
});
