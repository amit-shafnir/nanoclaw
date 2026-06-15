/**
 * Setup-side registration guard for the opencode provider (the third barrel of
 * the multi-point archetype): imports the REAL setup/providers barrel and
 * asserts the registry carries opencode with its auth + install check. Red if
 * the barrel line is deleted, the barrel fails to evaluate, or the payload
 * module breaks. (Importing ./opencode.js directly would self-register and
 * stay green when the barrel line is deleted.)
 */
import { describe, expect, it } from 'vitest';

import { getSetupProvider } from './registry.js';
import './index.js'; // the real setup provider barrel

describe('opencode setup registration', () => {
  it('registers opencode with auth + install check via the barrel', () => {
    const opencode = getSetupProvider('opencode');
    expect(opencode).toBeDefined();
    expect(typeof opencode!.runAuth).toBe('function');
    expect(typeof opencode!.runInstallCheck).toBe('function');
  });
});
