/**
 * Seam tests for the container hook registries: empty registries are exact
 * pass-throughs, hooks chain on `keep` / text in registration order, and a
 * null result-text short-circuits.
 *
 * bun:test cannot reset module state between cases, so the empty-registry
 * tests run first (declaration order) and the hooks registered later are
 * keyed on message/text markers, making them inert for unrelated inputs.
 */
import { describe, expect, it } from 'bun:test';

import {
  registerInboundBatchHook,
  registerResultTextHook,
  runInboundBatchHooks,
  runResultTextHooks,
} from './hooks.js';
import type { MessageInRow } from './db/messages-in.js';
import type { RoutingContext } from './formatter.js';

function msg(id: string): MessageInRow {
  return {
    id,
    seq: 1,
    kind: 'chat',
    timestamp: '2026-01-01T00:00:00Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: 'chat-1',
    channel_type: 'test',
    thread_id: null,
    content: JSON.stringify({ text: id }),
  };
}

const routing: RoutingContext = { platformId: 'chat-1', channelType: 'test', threadId: null, inReplyTo: null };

describe('empty registries', () => {
  it('inbound batch passes through untouched', async () => {
    const batch = [msg('a'), msg('b')];
    const result = await runInboundBatchHooks(batch, routing, 'initial');
    expect(result.keep).toEqual(batch);
    expect(result.blockedIds).toEqual([]);
  });

  it('result text passes through unchanged', async () => {
    expect(await runResultTextHooks('<message to="chat">hi</message>', routing)).toBe(
      '<message to="chat">hi</message>',
    );
  });
});

describe('inbound batch hooks', () => {
  it('chains keep across hooks and accumulates blockedIds', async () => {
    const seenByB: string[][] = [];
    const phases: string[] = [];
    registerInboundBatchHook((messages, _routing, phase) => {
      phases.push(phase);
      return {
        keep: messages.filter((m) => !m.id.startsWith('blockA-')),
        blockedIds: messages.filter((m) => m.id.startsWith('blockA-')).map((m) => m.id),
      };
    });
    registerInboundBatchHook((messages) => {
      seenByB.push(messages.map((m) => m.id));
      return {
        keep: messages.filter((m) => !m.id.startsWith('blockB-')),
        blockedIds: messages.filter((m) => m.id.startsWith('blockB-')).map((m) => m.id),
      };
    });

    const result = await runInboundBatchHooks([msg('ok-1'), msg('blockA-1'), msg('blockB-1')], routing, 'followup');

    expect(result.keep.map((m) => m.id)).toEqual(['ok-1']);
    expect(result.blockedIds).toEqual(['blockA-1', 'blockB-1']);
    // The second hook only ever saw the first hook's keep — blocked rows
    // can't be resurrected downstream.
    expect(seenByB).toEqual([['ok-1', 'blockB-1']]);
    expect(phases).toEqual(['followup']);
  });
});

describe('result text hooks', () => {
  it('chains transforms and short-circuits on null', async () => {
    const seenBySecond: string[] = [];
    registerResultTextHook((text) => (text.includes('SUPPRESS') ? null : text.replace('foo', 'bar')));
    registerResultTextHook((text) => {
      seenBySecond.push(text);
      return text;
    });

    expect(await runResultTextHooks('say foo', routing)).toBe('say bar');
    expect(seenBySecond).toEqual(['say bar']);

    expect(await runResultTextHooks('SUPPRESS this', routing)).toBeNull();
    // null from the first hook means the second never ran for that text.
    expect(seenBySecond).toEqual(['say bar']);
  });
});
