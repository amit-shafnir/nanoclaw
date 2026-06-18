import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { Database } from 'bun:sqlite';

import { closeSessionDb, initTestSessionDb } from './connection.js';
import { buildReplayHistory } from './replay.js';

let inbound: Database;
let outbound: Database;

/** Set an inbound message's processing_ack (the container-owned answered/in-flight signal). */
function ack(messageId: string, status: 'processing' | 'completed'): void {
  outbound
    .prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, datetime('now'))",
    )
    .run(messageId, status);
}

/** An answered prior user turn: the inbound row plus its container-written completed ack. */
function addIn(id: string, seq: number, text: string, sender = 'Alice'): void {
  inbound
    .prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'completed', ?)",
    )
    .run(id, seq, JSON.stringify({ text, sender }));
  ack(id, 'completed');
}

/** An unanswered inbound message (no completed ack) — current batch or batch-cap overflow. */
function addPendingIn(id: string, seq: number, text: string, sender = 'Alice'): void {
  inbound
    .prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', ?)",
    )
    .run(id, seq, JSON.stringify({ text, sender }));
}

function addOut(id: string, seq: number, text: string): void {
  outbound
    .prepare("INSERT INTO messages_out (id, seq, kind, timestamp, content) VALUES (?, ?, 'chat', datetime('now'), ?)")
    .run(id, seq, JSON.stringify({ text }));
}

beforeEach(() => {
  ({ inbound, outbound } = initTestSessionDb());
});

afterEach(() => {
  closeSessionDb();
});

describe('buildReplayHistory', () => {
  it('returns null when there is no history', () => {
    expect(buildReplayHistory(10)).toBeNull();
  });

  it('interleaves answered inbound and outbound turns chronologically by seq', () => {
    addIn('in-2', 2, 'hello');
    addOut('out-3', 3, 'hi there');
    addIn('in-4', 4, 'how are you');
    addOut('out-5', 5, 'great');

    const history = buildReplayHistory(10)!;
    expect(history).toContain('<conversation_history');
    const body = history.split('\n').filter((l) => l.startsWith('['));
    expect(body).toEqual(['[Alice] hello', '[assistant] hi there', '[Alice] how are you', '[assistant] great']);
  });

  it('respects the fixed window, keeping the most recent turns', () => {
    addIn('in-2', 2, 'oldest');
    addOut('out-3', 3, 'mid');
    addIn('in-4', 4, 'newest');

    const body = buildReplayHistory(2)!
      .split('\n')
      .filter((l) => l.startsWith('['));
    expect(body).toEqual(['[assistant] mid', '[Alice] newest']);
  });

  it('excludes the current in-flight batch (marked processing, not yet answered)', () => {
    addIn('in-2', 2, 'prior');
    addPendingIn('in-4', 4, 'current message');
    ack('in-4', 'processing');

    const body = buildReplayHistory(10)!
      .split('\n')
      .filter((l) => l.startsWith('['));
    expect(body).toEqual(['[Alice] prior']);
  });

  it('excludes unanswered pending messages with no ack (batch-cap overflow / mid-handshake — the double-feed guard)', () => {
    addIn('in-2', 2, 'prior answered');
    // A higher-seq message that was never claimed (e.g. the 11th message while the
    // batch cap is 10). Without filtering to the answered set it would be replayed
    // as "do not re-answer" history AND later fed as a live prompt.
    addPendingIn('in-6', 6, 'surplus never claimed');

    const body = buildReplayHistory(10)!
      .split('\n')
      .filter((l) => l.startsWith('['));
    expect(body).toEqual(['[Alice] prior answered']);
  });

  it('skips empty-text and system messages', () => {
    addIn('in-2', 2, '');
    inbound
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('sys-4', 4, 'system', datetime('now'), 'completed', ?)",
      )
      .run(JSON.stringify({ action: 'x' }));
    addOut('out-3', 3, 'only this');

    const body = buildReplayHistory(10)!
      .split('\n')
      .filter((l) => l.startsWith('['));
    expect(body).toEqual(['[assistant] only this']);
  });
});
