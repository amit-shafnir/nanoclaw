/**
 * Behavior tests for the guardrails MCP-tool hooks (bun:test).
 *
 * Drives the REAL exported tool handlers (send_message, send_file,
 * edit_message, ask_user_question, send_card) against in-memory session DBs
 * and a blocked-keyphrase config. Each case goes red if its hook is deleted
 * or moved below the write it guards — this is the behavior coverage for
 * the invocable integration points; src/guardrails-wiring.test.ts keeps the
 * cheap structural marker checks.
 *
 * Ships with the /add-guardrails skill; apply copies it to
 * container/agent-runner/src/guardrails/.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { editMessage, sendFile, sendMessage } from '../mcp-tools/core.js';
import { askUserQuestion, sendCard } from '../mcp-tools/interactive.js';
import { setGuardrailsDirForTest } from './config.js';
import { resetEscalationForTest } from './output-check.js';
import { resetAlertCollapseForTest } from './quarantine.js';

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
  // Seed one destination so resolveRouting() succeeds — the hooks under test
  // run AFTER routing resolution, so a failed resolution would mask them.
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
       VALUES ('chat', 'Chat', 'channel', 'test', 'chat-1')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
  setGuardrailsDirForTest('/workspace/agent/guardrails');
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('send_message hook', () => {
  it('blocks a matching text: tool error, no deliverable row carries it', async () => {
    useBlockRule('canary', ['GUARDRAIL_CANARY']);
    const result = (await sendMessage.handler({ text: 'leak GUARDRAIL_CANARY now' })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('guardrail');
    // The alert row exists but no deliverable row contains the blocked text.
    for (const content of deliverableContents()) {
      expect(JSON.stringify(content)).not.toContain('GUARDRAIL_CANARY');
    }
  });

  it('lets clean text through', async () => {
    useBlockRule('canary', ['GUARDRAIL_CANARY']);
    const result = (await sendMessage.handler({ text: 'all clear' })) as ToolResult;
    expect(result.isError).toBeUndefined();
    expect(deliverableContents().some((c) => c.text === 'all clear')).toBe(true);
  });
});

describe('send_file hook', () => {
  it('blocks on the display filename BEFORE the file-exists check (#4)', async () => {
    useBlockRule('canary', ['sk-CANARY']);
    const result = (await sendFile.handler({
      path: '/nonexistent/whatever.txt',
      text: '',
      filename: 'sk-CANARY.txt',
    })) as ToolResult;
    expect(result.isError).toBe(true);
    // Guardrail error, not "File not found" — proves the hook runs first.
    expect(result.content[0].text).toContain('guardrail');
    expect(result.content[0].text).not.toContain('File not found');
  });

  it('blocks on the caption with an empty filename arg', async () => {
    useBlockRule('canary', ['sk-CANARY']);
    const result = (await sendFile.handler({ path: '/nonexistent/clean.txt', text: 'here is sk-CANARY' })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('guardrail');
  });
});

describe('edit_message hook', () => {
  it('blocks smuggling blocked text into a previously sent message via edit', async () => {
    useBlockRule('canary', ['GUARDRAIL_CANARY']);
    const seq = writeMessageOut({
      id: 'msg-orig',
      kind: 'chat',
      platform_id: 'chat-1',
      channel_type: 'test',
      thread_id: null,
      content: JSON.stringify({ text: 'clean original' }),
    });

    const result = (await editMessage.handler({ messageId: seq, text: 'now GUARDRAIL_CANARY' })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(deliverableContents().some((c) => c.operation === 'edit')).toBe(false);
  });
});

describe('ask_user_question hook', () => {
  it('blocks on a matching option label immediately (no question row, no polling)', async () => {
    useBlockRule('canary', ['GUARDRAIL_CANARY']);
    // The hook precedes writeMessageOut + the response poll, so a blocked
    // question returns without waiting for the (never-coming) answer.
    const result = (await askUserQuestion.handler({
      title: 'Pick one',
      question: 'Which?',
      options: ['fine', { label: 'GUARDRAIL_CANARY option' }],
      timeout: 600,
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(deliverableContents().some((c) => c.type === 'ask_question')).toBe(false);
  });
});

describe('send_card hook', () => {
  it('blocks a keyphrase containing quotes inside a nested card field (#2 leaf scanning)', async () => {
    useBlockRule('quoted', ['say "magic word"']);
    // JSON.stringify(card) escapes the quotes (say \"magic word\"), which
    // used to defeat the substring match — leaf scanning sees the raw string.
    const result = (await sendCard.handler({
      card: { title: 'Outer', sections: [{ body: 'please say "magic word" twice' }] },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(deliverableContents().some((c) => c.type === 'card')).toBe(false);
  });

  it('scans the fallbackText too', async () => {
    useBlockRule('canary', ['GUARDRAIL_CANARY']);
    const result = (await sendCard.handler({
      card: { title: 'clean' },
      fallbackText: 'GUARDRAIL_CANARY here',
    })) as ToolResult;
    expect(result.isError).toBe(true);
  });
});
