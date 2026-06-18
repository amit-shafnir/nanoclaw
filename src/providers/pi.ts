/**
 * Host-side container config for the `pi` provider — vault-only auth, no mount.
 *
 * Pi's default anthropic provider reads `ANTHROPIC_API_KEY`; OneCLI swaps the
 * real key on the wire for `api.anthropic.com`, so the container only carries a
 * placeholder. That placeholder is load-bearing beyond the proxy: Pi gates
 * model availability/selection on a provider having auth, so without it no
 * anthropic model is selectable. `PI_TELEMETRY=0` is belt-and-suspenders under
 * egress lockdown (the SDK path makes no pi.dev calls anyway). No credential
 * file, no mount — exactly like a standard Anthropic install.
 *
 * No `providesAgentSurfaces`: Pi uses the host's default agent surfaces, so
 * long-term memory is the shared `CLAUDE.local.md` (Claude ↔ Pi share one file).
 */
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('pi', () => ({
  env: { ANTHROPIC_API_KEY: 'placeholder', PI_TELEMETRY: '0' },
}));
