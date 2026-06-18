/**
 * Integration test for the pi provider's HOST-side reach-in: the
 * self-registration import in the src/providers/index.ts barrel. Importing the
 * barrel runs pi.ts's top-level registerProviderContainerConfig('pi', …);
 * without that line the host never injects pi's placeholder env at spawn.
 *
 * Barrel-only by design: it imports the real barrel (./index.js), never
 * ./pi.js directly (that would self-register and stay green even if the barrel
 * line were deleted). Goes red if the barrel import drifts or fails to evaluate.
 */
import { describe, it, expect } from 'vitest';

import './index.js'; // the real host provider barrel — triggers self-registration
import { listProviderContainerConfigNames } from './provider-container-registry.js';

describe('pi provider host registration', () => {
  it('registers pi host container-config via the barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('pi');
  });
});
