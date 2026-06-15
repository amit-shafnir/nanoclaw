import { describe, expect, it } from 'vitest';

import { BACKENDS, buildSecretArgs, verifyOpenCodeInstall } from './opencode.js';

// The backend table is the only non-trivial logic in the opencode auth flow:
// each pick must map to the right provider id, base URL, and key-injection
// shape. These assertions go red if a mapping drifts.
describe('opencode backend table', () => {
  const byValue = Object.fromEntries(BACKENDS.map((b) => [b.value, b]));

  it('routes OpenRouter through a Bearer header', () => {
    const b = byValue.openrouter;
    expect(b.providerId).toBe('openrouter');
    expect(b.baseUrl).toBe('https://openrouter.ai/api/v1');
    const args = buildSecretArgs(b, 'sk-test');
    expect(args).toEqual(expect.arrayContaining(['--host-pattern', 'openrouter.ai']));
    expect(args).toEqual(
      expect.arrayContaining(['--header-name', 'Authorization', '--value-format', 'Bearer {value}']),
    );
  });

  it('routes Zen through x-api-key with a bare value', () => {
    const b = byValue.zen;
    expect(b.providerId).toBe('opencode');
    const args = buildSecretArgs(b, 'sk-test');
    expect(args).toEqual(expect.arrayContaining(['--header-name', 'x-api-key', '--value-format', '{value}']));
  });

  it('lets OneCLI own injection for the anthropic backend (no custom header)', () => {
    const b = byValue.anthropic;
    expect(b.baseUrl).toBeUndefined();
    const args = buildSecretArgs(b, 'sk-test');
    expect(args).toEqual(expect.arrayContaining(['--type', 'anthropic', '--host-pattern', 'api.anthropic.com']));
    expect(args).not.toContain('--header-name');
  });
});

// Structural guard for the payload wiring: provider files, both runtime
// barrels, and the pinned CLI manifest entry. Green on a tree with the
// opencode payload installed (trunk + add-opencode).
describe('verifyOpenCodeInstall', () => {
  it('passes on a tree with the opencode payload wired', () => {
    const { ok, problems } = verifyOpenCodeInstall();
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });
});
