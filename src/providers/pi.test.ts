import { describe, it, expect } from 'vitest';

import './pi.js'; // self-registers the pi container config
import { getProviderContainerConfig, type ProviderContainerContext } from './provider-container-registry.js';

// pi's config fn ignores the spawn context; a bare cast is enough.
const CTX = {} as ProviderContainerContext;

describe('pi provider container config', () => {
  it('contributes the vault-only placeholder env and no mount', () => {
    const fn = getProviderContainerConfig('pi');
    expect(fn).toBeDefined();

    const contribution = fn!(CTX);
    expect(contribution.env).toEqual({ ANTHROPIC_API_KEY: 'placeholder', PI_TELEMETRY: '0' });
    expect(contribution.mounts).toBeUndefined();
  });
});
