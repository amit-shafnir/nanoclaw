/**
 * Hardened plugin-directory walk + copy.
 *
 * Plugin content is DATA on the host: it gets validated and copied, never
 * executed. This module is the containment boundary for the copy half — every
 * file that leaves a plugin directory for a group workspace goes through
 * here, never through raw fs.cpSync (which follows symlinks).
 *
 * Fail closed: any violation (symlink, special file, path escape, cap
 * overrun) throws and rejects the whole plugin. This is deliberately stricter
 * than the Agent Plugins spec, which permits symlinks resolving within the
 * plugin root; a client MAY reject them, and we do.
 */
import fs from 'fs';
import path from 'path';

// Abuse bounds, not sizing guidance — the real templates are a few dozen
// files each.
export const MAX_PLUGIN_FILES = 2000;
export const MAX_PLUGIN_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_PLUGIN_DEPTH = 16;

export interface PluginFile {
  /** Path relative to the plugin root, '/'-separated. */
  rel: string;
  abs: string;
  size: number;
  mode: number;
}

/**
 * Walk a plugin directory, validating every entry. Returns the regular files
 * found. Throws on the first symlink, special file, path escape, or cap
 * violation — the caller must treat that as "reject the whole plugin".
 */
export function walkPluginDir(root: string): PluginFile[] {
  const resolvedRoot = path.resolve(root);
  const files: PluginFile[] = [];
  let totalBytes = 0;

  const visit = (relDir: string, depth: number): void => {
    const absDir = relDir ? path.join(resolvedRoot, relDir) : resolvedRoot;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const name = entry.name;
      // readdir never returns separators or dot-entries, but the whole point
      // of this module is to not trust the input tree.
      if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
        throw new Error(`Plugin rejected: entry name "${name}" in ${relDir || '.'} is not allowed`);
      }
      const rel = relDir ? `${relDir}/${name}` : name;
      const abs = path.join(absDir, name);
      if (path.relative(resolvedRoot, abs).startsWith('..')) {
        throw new Error(`Plugin rejected: "${rel}" escapes the plugin root`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Plugin rejected: "${rel}" is a symlink (symlinks are not allowed in plugins)`);
      }
      if (depth + 1 > MAX_PLUGIN_DEPTH) {
        throw new Error(`Plugin rejected: "${rel}" exceeds the maximum nesting depth of ${MAX_PLUGIN_DEPTH}`);
      }
      if (entry.isDirectory()) {
        visit(rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Plugin rejected: "${rel}" is not a regular file or directory`);
      }
      const stat = fs.lstatSync(abs);
      files.push({ rel, abs, size: stat.size, mode: stat.mode });
      totalBytes += stat.size;
      if (files.length > MAX_PLUGIN_FILES) {
        throw new Error(`Plugin rejected: more than ${MAX_PLUGIN_FILES} files`);
      }
      if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
        throw new Error(`Plugin rejected: total size exceeds ${MAX_PLUGIN_TOTAL_BYTES} bytes`);
      }
    }
  };

  visit('', 0);
  return files;
}

/** Validate a plugin directory without copying. Throws on any violation. */
export function assertSafePluginDir(root: string): void {
  walkPluginDir(root);
}

/**
 * Copy a validated plugin tree. `dest` is replaced wholesale so re-stamping
 * is idempotent. Re-walks `src` at copy time so the validation and the copy
 * see the same tree.
 */
export function copyPluginDir(src: string, dest: string): void {
  const files = walkPluginDir(src);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const file of files) {
    const target = path.join(dest, ...file.rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file.abs, target);
    // Preserve the executable bit — skills legitimately ship scripts.
    fs.chmodSync(target, file.mode & 0o777);
  }
}
