import { describe, it, expect } from 'vitest';

import { verifyPiInstall } from './pi.js';

describe('verifyPiInstall', () => {
  it('reports the pi payload as fully wired in this checkout', () => {
    const { ok, problems } = verifyPiInstall();
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });
});
