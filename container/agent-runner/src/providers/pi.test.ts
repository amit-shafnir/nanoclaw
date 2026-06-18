import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { listProviderNames } from './provider-registry.js';
import type { ProviderEvent, QueryInput } from './types.js';
import {
  classifyPiError,
  composeAppendedSystemPrompt,
  createToolKeepalive,
  PiProvider,
  type PiSession,
  translatePiEvent,
} from './pi.js';

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('classifyPiError', () => {
  it('flags quota/rate-limit as non-retryable quota', () => {
    expect(classifyPiError(new Error('429 rate limit exceeded'))).toEqual({
      retryable: false,
      classification: 'quota',
    });
    expect(classifyPiError(new Error('overloaded'))).toEqual({ retryable: false, classification: 'quota' });
  });

  it('flags auth failures as non-retryable auth', () => {
    expect(classifyPiError(new Error('401 Unauthorized'))).toEqual({ retryable: false, classification: 'auth' });
    expect(classifyPiError(new Error('invalid api key'))).toEqual({ retryable: false, classification: 'auth' });
  });

  it('marks transient transport errors retryable', () => {
    expect(classifyPiError(new Error('socket hang up'))).toEqual({ retryable: true });
    expect(classifyPiError(new Error('503 Service Unavailable'))).toEqual({ retryable: true });
  });

  it('fails closed (non-retryable) on anything else', () => {
    expect(classifyPiError(new Error('weird internal thing'))).toEqual({ retryable: false });
  });
});

describe('translatePiEvent', () => {
  it('maps a text_delta message_update to a progress event', () => {
    const event = {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hi' },
    } as unknown as AgentSessionEvent;
    expect(translatePiEvent(event)).toEqual({ type: 'progress', message: 'hi' });
  });

  it('maps tool lifecycle and turn/agent ends to activity — never to a result', () => {
    for (const type of ['tool_execution_start', 'tool_execution_end', 'turn_end', 'agent_end', 'message_end']) {
      const ev = translatePiEvent({ type } as unknown as AgentSessionEvent);
      expect(ev).toEqual({ type: 'activity' });
      expect(ev.type).not.toBe('result');
    }
  });
});

describe('createToolKeepalive', () => {
  it('ticks while a tool runs and stops once no tool remains', async () => {
    let ticks = 0;
    const ka = createToolKeepalive(() => (ticks += 1), 15);

    ka.onEvent({ type: 'tool_execution_start' } as AgentSessionEvent);
    await Bun.sleep(50);
    expect(ticks).toBeGreaterThan(0);

    ka.onEvent({ type: 'tool_execution_end' } as AgentSessionEvent);
    const settled = ticks;
    await Bun.sleep(50);
    expect(ticks).toBe(settled); // stopped — no further ticks
  });

  it('keeps ticking until the LAST parallel tool ends (depth-counted)', async () => {
    let ticks = 0;
    const ka = createToolKeepalive(() => (ticks += 1), 15);
    ka.onEvent({ type: 'tool_execution_start' } as AgentSessionEvent);
    ka.onEvent({ type: 'tool_execution_start' } as AgentSessionEvent);
    ka.onEvent({ type: 'tool_execution_end' } as AgentSessionEvent); // one of two ends
    await Bun.sleep(40);
    expect(ticks).toBeGreaterThan(0); // still ticking — one tool remains
    ka.stop();
  });

  it('stop() halts an active ticker unconditionally', async () => {
    let ticks = 0;
    const ka = createToolKeepalive(() => (ticks += 1), 15);
    ka.onEvent({ type: 'tool_execution_start' } as AgentSessionEvent);
    ka.stop();
    const settled = ticks;
    await Bun.sleep(40);
    expect(ticks).toBe(settled);
  });
});

describe('composeAppendedSystemPrompt', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sysprompt-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('includes the destinations wrapping rule (the load-bearing addendum)', () => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'BASE INSTRUCTIONS');
    const appended = composeAppendedSystemPrompt({
      prompt: 'x',
      cwd: dir,
      systemContext: { instructions: 'Wrap output in <message to="name">…</message>' },
    });
    expect(appended).toContain('BASE INSTRUCTIONS');
    expect(appended.some((p) => p.includes('<message to="name">'))).toBe(true);
  });

  it('is empty when there are no instruction files and no addendum', () => {
    expect(composeAppendedSystemPrompt({ prompt: 'x', cwd: dir })).toEqual([]);
  });
});

describe('PiProvider registration', () => {
  it('registers under the name "pi" via the barrel side effect', () => {
    expect(listProviderNames()).toContain('pi');
  });
});

// ── Lifecycle (driven through the PiSession seam, no live model) ─────────────

/** A fake Pi session that records prompts and lets the test fire events. */
class FakeSession implements PiSession {
  readonly sessionId = 'sess-1';
  readonly prompts: string[] = [];
  lastText: string | undefined = 'final answer';
  disposed = 0;
  private listener: ((event: AgentSessionEvent) => void) | null = null;

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(event: AgentSessionEvent): void {
    this.listener?.(event);
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    // A turn fires LLM turn_end events; the provider must NOT treat them as the
    // result (the result comes from getLastAssistantText after this resolves).
    this.emit({ type: 'turn_end' } as AgentSessionEvent);
  }

  getLastAssistantText(): string | undefined {
    return this.lastText;
  }

  async abort(): Promise<void> {}

  dispose(): void {
    this.disposed += 1;
  }
}

/** Drive a query to completion: collect events, ending the query once a result lands. */
async function runToResult(provider: PiProvider, input: QueryInput): Promise<ProviderEvent[]> {
  const query = provider.query(input);
  const events: ProviderEvent[] = [];
  for await (const event of query.events) {
    events.push(event);
    if (event.type === 'result') query.end();
  }
  return events;
}

describe('PiProvider lifecycle', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cwd-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('emits init then a result read from getLastAssistantText after prompt() resolves', async () => {
    const fake = new FakeSession();
    const provider = new PiProvider({}, async () => fake);

    const events = await runToResult(provider, { prompt: 'hello', cwd });

    expect(events[0]).toEqual({ type: 'init', continuation: 'sess-1' });
    const results = events.filter((e) => e.type === 'result');
    expect(results).toEqual([{ type: 'result', text: 'final answer' }]);
    // The turn_end fired during prompt() became activity, not a second result.
    expect(events.some((e) => e.type === 'activity')).toBe(true);
    expect(fake.prompts).toEqual(['hello']);
    expect(fake.disposed).toBe(1);
  });

  it('emits result text null when the turn produced no assistant text', async () => {
    const fake = new FakeSession();
    fake.lastText = undefined;
    const provider = new PiProvider({}, async () => fake);

    const events = await runToResult(provider, { prompt: 'hi', cwd });
    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: null }]);
  });

  it('prepends DB-replay history to the first prompt on a resumed wake (completed rows only)', async () => {
    const { inbound, outbound } = initTestSessionDb();
    try {
      // One answered prior turn (inbound completed + its ack) and an unanswered
      // pending message that must NOT be replayed.
      inbound
        .prepare(
          "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('in-2', 2, 'chat', datetime('now'), 'completed', ?)",
        )
        .run(JSON.stringify({ text: 'earlier question', sender: 'Alice' }));
      outbound
        .prepare(
          "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES ('in-2', 'completed', datetime('now'))",
        )
        .run();
      outbound
        .prepare(
          "INSERT INTO messages_out (id, seq, kind, timestamp, content) VALUES ('out-3', 3, 'chat', datetime('now'), ?)",
        )
        .run(JSON.stringify({ text: 'earlier answer' }));

      const fake = new FakeSession();
      const provider = new PiProvider({}, async () => fake);

      // `continuation` truthy → a 2nd+ wake → replay is prepended.
      await runToResult(provider, { prompt: 'new question', cwd, continuation: 'prev-sess' });

      expect(fake.prompts).toHaveLength(1);
      const sent = fake.prompts[0];
      expect(sent).toContain('<conversation_history');
      expect(sent).toContain('earlier question');
      expect(sent).toContain('earlier answer');
      expect(sent.endsWith('new question')).toBe(true);
    } finally {
      closeSessionDb();
    }
  });

  it('does not prepend replay on a fresh wake (no continuation)', async () => {
    const { outbound } = initTestSessionDb();
    try {
      outbound
        .prepare(
          "INSERT INTO messages_out (id, seq, kind, timestamp, content) VALUES ('out-1', 1, 'chat', datetime('now'), ?)",
        )
        .run(JSON.stringify({ text: 'stale prior answer' }));

      const fake = new FakeSession();
      const provider = new PiProvider({}, async () => fake);

      await runToResult(provider, { prompt: 'first ever message', cwd });
      expect(fake.prompts).toEqual(['first ever message']);
    } finally {
      closeSessionDb();
    }
  });
});
