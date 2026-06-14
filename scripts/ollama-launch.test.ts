import { describe, expect, it } from 'vitest';

import {
  classifyPreflight,
  ollamaEnvOverrides,
  parseArgs,
  rewriteBaseUrlForContainer,
  selectPrimaryWiring,
} from './ollama-launch.js';
import type { MessagingGroupAgent } from '../src/types.js';

function wiring(overrides: Partial<MessagingGroupAgent>): MessagingGroupAgent {
  return {
    id: 'mga-0',
    messaging_group_id: 'mg-cli',
    agent_group_id: 'ag-0',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('parses the full CLI surface', () => {
    const r = parseArgs([
      '--model',
      'qwen3-coder:30b',
      '--base-url',
      'http://127.0.0.1:11434',
      '--display-name',
      'Amit',
    ]);
    expect(r).toEqual({
      ok: true,
      value: {
        model: 'qwen3-coder:30b',
        baseUrl: 'http://127.0.0.1:11434',
        displayName: 'Amit',
        group: undefined,
      },
    });
  });

  it('accepts --group', () => {
    const r = parseArgs(['--model', 'm', '--base-url', 'http://x', '--group', 'ag-1']);
    expect(r.ok && r.value.group).toBe('ag-1');
  });

  it('accepts --agent-name (distinct from --display-name)', () => {
    const r = parseArgs([
      '--model',
      'm',
      '--base-url',
      'http://x',
      '--display-name',
      'shafnir',
      '--agent-name',
      'Ollama',
    ]);
    expect(r.ok && r.value.displayName).toBe('shafnir');
    expect(r.ok && r.value.agentName).toBe('Ollama');
  });

  it('rejects a missing --model', () => {
    expect(parseArgs(['--base-url', 'http://x'])).toEqual({ ok: false, message: 'missing required argument: --model' });
  });

  it('rejects a missing --base-url', () => {
    expect(parseArgs(['--model', 'm'])).toEqual({ ok: false, message: 'missing required argument: --base-url' });
  });

  it('rejects an unknown argument', () => {
    expect(parseArgs(['--model', 'm', '--base-url', 'http://x', '--bogus'])).toEqual({
      ok: false,
      message: 'unknown argument: --bogus',
    });
  });

  it('rejects a flag whose value is missing (next token is another flag)', () => {
    expect(parseArgs(['--model', '--base-url', 'http://x'])).toEqual({
      ok: false,
      message: 'missing value for --model',
    });
  });
});

describe('rewriteBaseUrlForContainer', () => {
  it.each([
    ['http://127.0.0.1:11434', 'http://host.docker.internal:11434'],
    ['http://localhost:11434', 'http://host.docker.internal:11434'],
    ['http://0.0.0.0:11434', 'http://host.docker.internal:11434'],
    ['https://localhost:8443', 'https://host.docker.internal:8443'],
  ])('rewrites loopback host %s', (input, expected) => {
    expect(rewriteBaseUrlForContainer(input)).toBe(expected);
  });

  it('preserves a non-root path', () => {
    expect(rewriteBaseUrlForContainer('http://127.0.0.1:11434/v1')).toBe('http://host.docker.internal:11434/v1');
  });

  it('leaves an already-routable host untouched', () => {
    expect(rewriteBaseUrlForContainer('http://host.docker.internal:11434')).toBe('http://host.docker.internal:11434');
    expect(rewriteBaseUrlForContainer('http://ollama.example.com:11434')).toBe('http://ollama.example.com:11434');
  });

  it('passes an unparseable value through verbatim', () => {
    expect(rewriteBaseUrlForContainer('not a url')).toBe('not a url');
  });
});

describe('ollamaEnvOverrides', () => {
  it('points the base URL at the container endpoint and supplies a placeholder token', () => {
    expect(ollamaEnvOverrides('http://host.docker.internal:11434')).toEqual({
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
      ANTHROPIC_AUTH_TOKEN: 'placeholder',
    });
  });
});

describe('classifyPreflight', () => {
  it('passes a launch with egress lockdown off', () => {
    expect(classifyPreflight({ egressLockdownOn: false })).toEqual({ ok: true });
  });

  it('refuses egress lockdown with exit 3', () => {
    const r = classifyPreflight({ egressLockdownOn: true });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.exitCode).toBe(3);
  });
});

describe('selectPrimaryWiring', () => {
  it('returns undefined for no wirings', () => {
    expect(selectPrimaryWiring([])).toBeUndefined();
  });

  it('returns the single wiring', () => {
    const only = wiring({ id: 'mga-1', agent_group_id: 'ag-1' });
    expect(selectPrimaryWiring([only])).toBe(only);
  });

  it('prefers the highest priority regardless of input order', () => {
    const low = wiring({ id: 'mga-low', agent_group_id: 'ag-low', priority: 0 });
    const high = wiring({ id: 'mga-high', agent_group_id: 'ag-high', priority: 5 });
    expect(selectPrimaryWiring([low, high])?.agent_group_id).toBe('ag-high');
  });

  it('breaks equal-priority ties by oldest created_at (deterministic)', () => {
    const newer = wiring({ id: 'mga-new', agent_group_id: 'ag-new', created_at: '2026-02-01T00:00:00.000Z' });
    const older = wiring({ id: 'mga-old', agent_group_id: 'ag-old', created_at: '2026-01-01T00:00:00.000Z' });
    expect(selectPrimaryWiring([newer, older])?.agent_group_id).toBe('ag-old');
    // same set, reversed input order -> same winner
    expect(selectPrimaryWiring([older, newer])?.agent_group_id).toBe('ag-old');
  });
});
