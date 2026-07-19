import fs from 'fs';
import path from 'path';

import { log } from './log.js';

/** Suffix identifying persistent per-group files composed before the shared instructions. */
export const GROUP_PREPEND_SUFFIX = '.prepend.md';

/** Primary per-group prepend, always composed before sibling prepend files. */
export const PERSONA_PREPEND_FILE = `instructions${GROUP_PREPEND_SUFFIX}`;

/**
 * Create a group's standing instructions without following or replacing an
 * existing path. Returns false when the content is empty or the path exists.
 */
export function stageGroupPersona(groupDir: string, instructions: string): boolean {
  const content = instructions.trimEnd();
  if (!content.trim()) return false;

  fs.mkdirSync(groupDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), `${content}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'EEXIST') return false;
    throw err;
  }
}

/** Read a group's prepend files without following symlinks. */
export function readGroupPersona(groupDir: string): string | null {
  let files: string[];
  try {
    files = fs
      .readdirSync(groupDir)
      .filter((file) => file.endsWith(GROUP_PREPEND_SUFFIX))
      .sort((a, b) => {
        if (a === PERSONA_PREPEND_FILE) return -1;
        if (b === PERSONA_PREPEND_FILE) return 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    // eslint-disable-next-line no-catch-all/no-catch-all -- standing instructions are best-effort; filesystem errors must not block agent spawn
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null;
    log.warn('Could not enumerate group standing instructions; omitting prepend files', {
      groupDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const content = files
    .map((file) => readPrependFile(path.join(groupDir, file)))
    .filter((part): part is string => part !== null)
    .join('\n\n');
  return content || null;
}

function readPrependFile(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return null;
    return fs.readFileSync(fd, 'utf-8').trim() || null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- one unreadable prepend must not block agent spawn or the remaining prepends
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null;
    log.warn('Could not read group standing instructions; omitting prepend file', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
