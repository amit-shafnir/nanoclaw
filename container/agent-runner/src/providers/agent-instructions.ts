/**
 * Instruction-file flattening for non-Claude providers.
 *
 * NanoClaw composes its system prompt as a `CLAUDE.md` of Claude-Code
 * `@<path>` import directives (see host `claude-md-compose.ts`), plus a
 * per-group `CLAUDE.local.md`. The Claude provider gets these for free — the
 * Agent SDK loads `CLAUDE.md` from the cwd and expands the imports natively.
 *
 * A provider whose SDK does neither (no `@`-import expansion, system prompt
 * delivered out-of-band) needs the import tree flattened into a single string
 * it can hand to its own system-prompt channel. So this module resolves the
 * imports. Imports are resolved relative to the file that declares them; the
 * composed `CLAUDE.md`'s targets are symlinks to read-only container mounts
 * (`/app/...`), which resolve correctly inside the container.
 */
import fs from 'fs';
import path from 'path';

/**
 * Replace line-anchored `@<path>` import directives with the referenced file's
 * contents, resolved relative to `baseDir`, recursing so nested imports expand
 * too. Cycles and missing/unreadable files collapse to empty text rather than
 * leaking a literal `@path` line into the prompt (which would confuse the model).
 */
export function resolveClaudeImports(content: string, baseDir: string, seen: Set<string> = new Set()): string {
  return content.replace(/^@(\S+)\s*$/gm, (_match, importPath: string) => {
    try {
      const resolved = path.resolve(baseDir, importPath);
      if (seen.has(resolved)) return '';
      if (!fs.existsSync(resolved)) return '';
      const nextSeen = new Set(seen);
      nextSeen.add(resolved);
      const imported = fs.readFileSync(resolved, 'utf-8');
      return resolveClaudeImports(imported, path.dirname(resolved), nextSeen);
    } catch {
      return '';
    }
  });
}

/**
 * Read and flatten the agent's instruction files from `cwd` (the composed
 * `CLAUDE.md` and per-group `CLAUDE.local.md`), returning the combined system
 * prompt corpus, or `undefined` when neither file exists. Mirrors the effective
 * prompt the Claude provider gets natively.
 */
export function readComposedInstructions(cwd: string): string | undefined {
  const parts: string[] = [];
  for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
    const file = path.join(cwd, name);
    if (!fs.existsSync(file)) continue;
    const flattened = resolveClaudeImports(fs.readFileSync(file, 'utf-8'), cwd).trim();
    if (flattened) parts.push(flattened);
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}
