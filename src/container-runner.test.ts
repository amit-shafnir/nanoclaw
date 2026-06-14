import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { buildPerGroupOverrideArgs, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});

describe('buildPerGroupOverrideArgs', () => {
  it('returns no args for empty/absent overrides', () => {
    expect(buildPerGroupOverrideArgs()).toEqual([]);
    expect(buildPerGroupOverrideArgs({}, [])).toEqual([]);
  });

  it('emits -e KEY=VALUE per env entry', () => {
    expect(buildPerGroupOverrideArgs({ ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434' })).toEqual([
      '-e',
      'ANTHROPIC_BASE_URL=http://host.docker.internal:11434',
    ]);
  });

  it('emits --add-host HOST:0.0.0.0 per blocked host', () => {
    expect(buildPerGroupOverrideArgs({}, ['api.anthropic.com'])).toEqual(['--add-host', 'api.anthropic.com:0.0.0.0']);
  });

  it('emits env before blocked hosts', () => {
    expect(buildPerGroupOverrideArgs({ K: 'V' }, ['h'])).toEqual(['-e', 'K=V', '--add-host', 'h:0.0.0.0']);
  });
});

describe('per-group override emission ordering (structural)', () => {
  // Per-group env must be emitted AFTER the OneCLI apply so a group's own
  // ANTHROPIC_BASE_URL (e.g. a local Ollama endpoint) wins — Docker honors the
  // last -e for a repeated key. Driving buildContainerArgs needs a live gateway,
  // so this guards the invariant structurally.
  it('emits per-group overrides after the OneCLI gateway apply', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    const overrideEmit = src.indexOf('args.push(...buildPerGroupOverrideArgs(');
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(overrideEmit).toBeGreaterThan(-1);
    expect(overrideEmit).toBeGreaterThan(gatewayApply);
  });
});
