// Structural guard for the OpenCode CLI install in container/cli-tools.json.
//
// opencode-ai ships a CLI binary (`opencode serve`) installed from the
// global-CLI manifest (a json-merge seam), separate from the importable
// @opencode-ai/sdk dep the provider code uses. The barrel-driven registration
// tests cover the SDK import; this test reads the real cli-tools.json and
// asserts the opencode-ai entry is present and pinned. It goes red if the
// manifest entry is dropped or unpins.
//
// Runs under bun (same suite as the container registration test):
//   cd container/agent-runner && bun test src/providers/opencode-cli-tools.test.ts

import { existsSync, readFileSync } from 'fs';
import path from 'path';

import { describe, it, expect } from 'bun:test';

// container/agent-runner/src/providers/ -> container/cli-tools.json
const MANIFEST = path.join(import.meta.dir, '..', '..', '..', 'cli-tools.json');
const manifestPresent = existsSync(MANIFEST);

const tools: Array<{ name: string; version: string }> = manifestPresent
  ? JSON.parse(readFileSync(MANIFEST, 'utf8'))
  : [];
const opencode = tools.find((t) => t.name === 'opencode-ai');

// cli-tools.json is a trunk file; on the bare providers branch it isn't
// present, so skip there. In an installed tree (trunk + this payload) it must
// carry the pinned opencode-ai entry.
describe.skipIf(!manifestPresent)('container/cli-tools.json opencode CLI install', () => {
  it('includes the opencode-ai entry', () => {
    expect(opencode).toBeDefined();
  });

  it('pins it to an exact semver (no latest, no ranges)', () => {
    expect(opencode?.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });
});
