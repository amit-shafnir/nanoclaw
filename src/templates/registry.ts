/**
 * Fixed NanoClaw template registry: how a template ref becomes a local
 * directory (clone/copy/cache mechanics). Shared by the setup wizard, the
 * `ncl templates list` verb, and the create_agent delivery action. Fs + git
 * only — no central-DB access.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { TEMPLATES_DIR } from '../config.js';
import { isValidTemplateRef, resolveLocalTemplate } from './local-dir.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_TEMPLATES_SOURCE = 'https://github.com/nanocoai/nanoclaw-templates';
export const REGISTRY_INDEX_URL = 'https://raw.githubusercontent.com/nanocoai/nanoclaw-templates/main/index.json';
export const REGISTRY_INDEX_TTL_MS = 5 * 60_000;
export const REGISTRY_INDEX_FAILURE_TTL_MS = 30_000;
export const REGISTRY_CLONE_TIMEOUT_MS = 60_000;
export const REGISTRY_INDEX_FETCH_TIMEOUT_MS = 10_000;

export interface TemplateEntry {
  ref: string;
  name: string;
}

export interface ClonedRegistry {
  dir: string;
  commit: string;
  cleanup: () => void;
}

export interface EnsureTemplateResult {
  ref: string;
  dir: string;
  source: 'local' | 'registry';
  /** Clone HEAD; absent when the existing local copy won. */
  commit?: string;
}

export interface RegistryIndexEntry {
  ref: string;
  name: string;
  version: string;
  description: string;
}

/**
 * Parsed registry index. On the wire, index.json groups entries by category
 * (`{ schema, categories: { sales: [entry, …] } }`, keys and entries sorted);
 * parsing flattens to one array — category stays derivable as the ref's first
 * segment, so consumers filter on the ref exactly as they do for local refs.
 */
export interface RegistryIndex {
  schema: 1;
  templates: RegistryIndexEntry[];
}

export interface LocalTemplateEntry {
  ref: string;
  name: string;
  description?: string;
}

// A directory is a template iff it is an Agent Plugins directory — the
// manifest is the discovery marker. The pre-plugin layout is detected only to
// point the operator at a re-fetch.
const MARKER = 'plugin.json';
const LEGACY_MARKER = 'context/instructions.md';

/** Shallow-clone the template registry into a temp dir. Caller must cleanup(). */
export async function cloneRegistry(opts?: { timeoutMs?: number }): Promise<ClonedRegistry> {
  const timeout = opts?.timeoutMs ?? REGISTRY_CLONE_TIMEOUT_MS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tpl-'));
  let commit: string;
  try {
    await execFileAsync('git', ['clone', '--depth', '1', '--', DEFAULT_TEMPLATES_SOURCE, dir], {
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    commit = (await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout })).stdout.trim();
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('Could not clone the template library', { cause: err });
  }
  return { dir, commit, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function listTemplatesFromDir(dir: string): TemplateEntry[] {
  if (!fs.existsSync(dir)) return [];
  const rootName = path.basename(path.resolve(dir));
  const rels = (fs.readdirSync(dir, { recursive: true }) as string[]).map((entry) => entry.split(path.sep).join('/'));

  const refs = new Set<string>();
  for (const rel of rels) {
    if (rel === MARKER) refs.add('.');
    else if (rel.endsWith(`/${MARKER}`)) refs.add(rel.slice(0, -(MARKER.length + 1)));
  }

  // A context/instructions.md outside any plugin is the pre-plugin template
  // layout. Fail with a pointer instead of silently listing nothing. (The
  // same file INSIDE a plugin — e.g. ai.nanoco.nanoclaw/context/ — is fine.)
  const legacy = rels
    .filter((rel) => rel === LEGACY_MARKER || rel.endsWith(`/${LEGACY_MARKER}`))
    .map((rel) => (rel === LEGACY_MARKER ? '.' : rel.slice(0, -(LEGACY_MARKER.length + 1))))
    .filter((ref) => !isWithinTemplate(ref, refs));
  if (legacy.length > 0) {
    throw new Error(
      `Templates predate the plugin format (no ${MARKER}): ${legacy.join(', ')}. ` +
        'Re-fetch the template library (and update NanoClaw if fetching does not help).',
    );
  }

  return [...refs]
    .map((ref) => ({ ref, name: ref === '.' ? rootName : (ref.split('/').pop() ?? ref) }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

/** True when `ref` equals or sits anywhere below a discovered template ref. */
function isWithinTemplate(ref: string, templateRefs: Set<string>): boolean {
  if (templateRefs.has('.')) return true;
  for (let current = ref; ; ) {
    if (templateRefs.has(current)) return true;
    const cut = current.lastIndexOf('/');
    if (cut === -1) return false;
    current = current.slice(0, cut);
  }
}

/** Copy a list-derived registry template into the local template library. */
export function copyTemplate(srcDir: string, ref: string, destDir: string): string {
  if (ref === '.') throw new Error('Cannot copy the registry root as a template');
  const from = resolveLocalTemplate(ref, srcDir);
  const to = path.resolve(destDir, ref);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
  return to;
}

/**
 * List the local template library with each template's manifest description
 * (best-effort: an unreadable manifest just yields no description). The root
 * `.` entry is dropped — it is not a stampable ref.
 */
export function listLocalTemplates(base: string = TEMPLATES_DIR): LocalTemplateEntry[] {
  return listTemplatesFromDir(base)
    .filter((entry) => entry.ref !== '.')
    .map((entry) => {
      let description: string | undefined;
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(path.join(base, entry.ref, MARKER), 'utf8'));
        if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
          const value = (raw as Record<string, unknown>).description;
          if (typeof value === 'string') description = value;
        }
      } catch {
        // Best-effort: the listing must not fail on one bad manifest.
      }
      return { ...entry, ...(description !== undefined ? { description } : {}) };
    });
}

/** True when a well-formed ref already has a local copy. Never throws. */
export function hasLocalTemplate(ref: string, base: string = TEMPLATES_DIR): boolean {
  try {
    return isValidTemplateRef(ref) && fs.existsSync(path.join(base, ref));
  } catch {
    return false;
  }
}

const inFlightByRef = new Map<string, Promise<EnsureTemplateResult>>();

/**
 * Materialize a template ref into the local library, fetching it from the
 * registry when no local copy exists. The existing local copy always wins and
 * is never overwritten — even when it is not a valid plugin; validity surfaces
 * at stamp time. Returns the clone's HEAD commit when the registry was used.
 *
 * `opts.deps.clone` is the no-network-in-tests seam — do not inline the real
 * call.
 */
export async function ensureTemplateLocal(
  ref: string,
  opts?: { baseDir?: string; timeoutMs?: number; deps?: { clone?: typeof cloneRegistry } },
): Promise<EnsureTemplateResult> {
  if (!isValidTemplateRef(ref)) throw new Error(`Invalid template ref: "${ref}"`);

  // Join the in-flight fetch BEFORE the local-exists check — the ordering is
  // load-bearing: a second caller arriving mid-clone must await the first
  // caller's result, not observe a partially materialized templates/<ref> and
  // report it as 'local'. Pinned by the concurrent-callers test in
  // registry.test.ts.
  const inFlight = inFlightByRef.get(ref);
  if (inFlight) return inFlight;

  const task = fetchTemplateIntoBase(ref, opts);
  inFlightByRef.set(ref, task);
  try {
    return await task;
  } finally {
    inFlightByRef.delete(ref);
  }
}

async function fetchTemplateIntoBase(
  ref: string,
  opts?: { baseDir?: string; timeoutMs?: number; deps?: { clone?: typeof cloneRegistry } },
): Promise<EnsureTemplateResult> {
  const baseDir = opts?.baseDir ?? TEMPLATES_DIR;
  const dest = path.join(baseDir, ref);
  if (fs.existsSync(dest)) return { ref, dir: dest, source: 'local' };

  const clone = opts?.deps?.clone ?? cloneRegistry;
  const registry = await clone({ timeoutMs: opts?.timeoutMs });
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    // Stage inside the templates base (same filesystem) then rename, so a
    // crash mid-copy can never leave a partial templates/<ref> that "local
    // copy wins" would serve forever. Content hardening is enforced at stamp
    // time by copyPluginDir (src/templates/plugin-dir.ts), not here.
    const staging = fs.mkdtempSync(path.join(baseDir, '.tpl-staging-'));
    try {
      copyTemplate(registry.dir, ref, staging);
      if (fs.existsSync(dest)) return { ref, dir: dest, source: 'local' };
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(path.join(staging, ref), dest);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return { ref, dir: dest, source: 'registry', commit: registry.commit };
  } finally {
    registry.cleanup();
  }
}

let indexCache: { at: number; index: RegistryIndex } | undefined;
let indexFailure: { at: number; error: unknown } | undefined;

/**
 * Fetch and validate the registry's index.json, cached in-memory for
 * REGISTRY_INDEX_TTL_MS so repeated agent calls cannot turn into fetch spam.
 * Failures throw — a throw IS the "no registry access" signal — and are
 * negative-cached for REGISTRY_INDEX_FAILURE_TTL_MS so an offline retry loop
 * fails fast instead of paying the fetch timeout on every call.
 */
export async function fetchRegistryIndex(opts?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<RegistryIndex> {
  const now = opts?.now ?? Date.now;
  if (indexCache && now() - indexCache.at < REGISTRY_INDEX_TTL_MS) return indexCache.index;
  if (indexFailure && now() - indexFailure.at < REGISTRY_INDEX_FAILURE_TTL_MS) throw indexFailure.error;

  try {
    const fetchImpl = opts?.fetchImpl ?? fetch;
    const res = await fetchImpl(REGISTRY_INDEX_URL, { signal: AbortSignal.timeout(REGISTRY_INDEX_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Could not fetch the template registry index: HTTP ${res.status}`);
    const index = parseRegistryIndex(await res.json());
    indexCache = { at: now(), index };
    indexFailure = undefined;
    return index;
  } catch (err) {
    indexFailure = { at: now(), error: err };
    throw err;
  }
}

function parseRegistryIndex(raw: unknown): RegistryIndex {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Registry index is not an object');
  }
  const { schema, categories } = raw as Record<string, unknown>;
  if (schema !== 1) {
    throw new Error(`Registry index schema ${String(schema)} requires a newer NanoClaw`);
  }
  if (categories === null || typeof categories !== 'object' || Array.isArray(categories)) {
    throw new Error('Registry index has no categories object');
  }
  const templates: RegistryIndexEntry[] = [];
  for (const category of Object.keys(categories).sort()) {
    const entries = (categories as Record<string, unknown>)[category];
    if (!Array.isArray(entries)) {
      throw new Error(`Registry index category "${category}" is not an array`);
    }
    for (const entry of entries.map(parseRegistryIndexEntry)) {
      if (!entry.ref.startsWith(`${category}/`)) {
        throw new Error(`Registry index entry "${entry.ref}" is outside its category "${category}"`);
      }
      templates.push(entry);
    }
  }
  return { schema, templates };
}

function parseRegistryIndexEntry(raw: unknown): RegistryIndexEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Registry index entry is not an object');
  }
  const { ref, name, version, description } = raw as Record<string, unknown>;
  if (
    typeof ref !== 'string' ||
    typeof name !== 'string' ||
    typeof version !== 'string' ||
    typeof description !== 'string'
  ) {
    throw new Error('Registry index entry is malformed');
  }
  return { ref, name, version, description };
}

/** Test seam only: clears the index caches and the per-ref in-flight map. */
export function _resetRegistryStateForTest(): void {
  indexCache = undefined;
  indexFailure = undefined;
  inFlightByRef.clear();
}
