import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readComposedInstructions, resolveClaudeImports } from './agent-instructions.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-instr-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveClaudeImports', () => {
  it('inlines a line-anchored @import relative to the base dir', () => {
    fs.writeFileSync(path.join(dir, 'frag.md'), 'FRAGMENT BODY');
    expect(resolveClaudeImports('before\n@./frag.md\nafter', dir)).toBe('before\nFRAGMENT BODY\nafter');
  });

  it('recurses into nested imports', () => {
    fs.writeFileSync(path.join(dir, 'a.md'), 'A\n@./b.md');
    fs.writeFileSync(path.join(dir, 'b.md'), 'B');
    expect(resolveClaudeImports('@./a.md', dir)).toBe('A\nB');
  });

  it('drops missing imports rather than leaking the @path directive', () => {
    expect(resolveClaudeImports('x\n@./nope.md\ny', dir)).toBe('x\n\ny');
  });

  it('breaks import cycles', () => {
    fs.writeFileSync(path.join(dir, 'a.md'), 'A\n@./b.md');
    fs.writeFileSync(path.join(dir, 'b.md'), 'B\n@./a.md');
    // a→b→a: the second a is a cycle and collapses to empty.
    expect(resolveClaudeImports('@./a.md', dir)).toBe('A\nB\n');
  });

  it('follows symlinks (mirrors the composed CLAUDE.md → /app mounts in-container)', () => {
    fs.writeFileSync(path.join(dir, 'real.md'), 'REAL');
    fs.symlinkSync(path.join(dir, 'real.md'), path.join(dir, 'link.md'));
    expect(resolveClaudeImports('@./link.md', dir)).toBe('REAL');
  });
});

describe('readComposedInstructions', () => {
  it('returns undefined when no instruction files exist', () => {
    expect(readComposedInstructions(dir)).toBeUndefined();
  });

  it('flattens CLAUDE.md imports and appends CLAUDE.local.md', () => {
    fs.writeFileSync(path.join(dir, 'shared.md'), 'SHARED');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '@./shared.md');
    fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), 'PER-GROUP MEMORY');
    const out = readComposedInstructions(dir)!;
    expect(out).toContain('SHARED');
    expect(out).toContain('PER-GROUP MEMORY');
    expect(out).not.toContain('@./shared.md');
  });
});
