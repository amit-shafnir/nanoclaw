/**
 * Integration test for the pi provider's SETUP-side reach-in: the
 * self-registration import in the setup/providers/index.ts barrel. Importing
 * the barrel runs pi.ts's top-level registerSetupProvider('pi', …); without
 * that line the picker and the provider-auth step never see Pi.
 *
 * Barrel-only by design: it imports the real barrel (./index.js), never
 * ./pi.js directly. Goes red if the barrel import drifts or fails to evaluate.
 */
import { describe, it, expect } from 'vitest';

import './index.js'; // the real setup provider barrel — triggers self-registration
import { listSetupProviders } from './registry.js';

describe('pi provider setup registration', () => {
  it('registers pi in the setup provider registry via the barrel', () => {
    expect(listSetupProviders().map((e) => e.value)).toContain('pi');
  });
});
