/**
 * Guardrails config loader (container side).
 *
 * Reads /workspace/agent/guardrails/ — the host RO-mounts the group's
 * guardrails directory there, so the agent can never edit or delete its own
 * guardrails. Mirrors src/modules/guardrails/config.ts on the host (the two
 * trees share no modules by design); keep edits in sync.
 *
 * Returns a discriminated result:
 *   - 'absent'  — no guardrails.json: feature off, callers pass through.
 *   - 'ok'      — strictly validated config.
 *   - 'invalid' — configured but broken: callers must BLOCK everything for
 *     this group until the file is fixed. Strict validation means the FIRST
 *     violation (unknown key, bad regex, missing sidecar, duplicate id, …)
 *     invalidates the whole config — invalid rules are never silently
 *     dropped, because a dropped rule is a silently open gate.
 *
 * Results (including 'absent' and 'invalid') are cached and revalidated by
 * mtime at most once per CACHE_TTL_MS, so an unconfigured group costs one
 * Map lookup and a fixed config is picked up within ~5s.
 */
import fs from 'fs';
import path from 'path';

import { MAX_PATTERN_LENGTH, type GuardrailAction, type GuardrailRule } from './rules.js';

export interface QuarantineLimits {
  max_file_mb: number;
  max_files: number;
}

export interface GuardrailsConfig {
  input_rules: GuardrailRule[];
  output_rules: GuardrailRule[];
  alerts: { prefix: string };
  quarantine: QuarantineLimits;
}

export type GuardrailsLoadResult =
  | { status: 'absent' }
  | { status: 'ok'; config: GuardrailsConfig }
  | { status: 'invalid'; error: string };

const DEFAULT_DIR = '/workspace/agent/guardrails';
const CACHE_TTL_MS = 5_000;

let guardrailsBaseDir = DEFAULT_DIR;

/** Test seam — point the loader at a temp directory. */
export function setGuardrailsDirForTest(dir: string): void {
  guardrailsBaseDir = dir;
  cache.clear();
}

function log(msg: string): void {
  console.error(`[guardrails] ${msg}`);
}

interface CacheEntry {
  checkedAt: number;
  /** mtimeMs of every file the config depends on; -1 = "did not exist". */
  files: Array<{ path: string; mtimeMs: number }>;
  result: GuardrailsLoadResult;
}

const cache = new Map<string, CacheEntry>();

/** Load (with caching) this group's guardrails config. */
export function loadGuardrailsConfig(): GuardrailsLoadResult {
  const dir = guardrailsBaseDir;
  const now = Date.now();
  const cached = cache.get(dir);
  if (cached && now - cached.checkedAt < CACHE_TTL_MS) return cached.result;
  if (cached && filesUnchanged(cached.files)) {
    cached.checkedAt = now;
    return cached.result;
  }
  const fresh = loadFresh(dir);
  cache.set(dir, { checkedAt: now, files: fresh.files, result: fresh.result });
  return fresh.result;
}

function statMtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return -1;
  }
}

function filesUnchanged(files: Array<{ path: string; mtimeMs: number }>): boolean {
  return files.every((f) => statMtime(f.path) === f.mtimeMs);
}

/** Validation failure — translated to { status: 'invalid' } at the module boundary. */
class ConfigError extends Error {}

function loadFresh(dir: string): { result: GuardrailsLoadResult; files: CacheEntry['files'] } {
  const configPath = path.join(dir, 'guardrails.json');
  // Sidecar reads append to `files` before they can fail, so even an invalid
  // result tracks every file it touched — fixing any of them busts the cache.
  const files: CacheEntry['files'] = [{ path: configPath, mtimeMs: statMtime(configPath) }];
  if (files[0].mtimeMs === -1) return { result: { status: 'absent' }, files };

  try {
    const raw: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { result: { status: 'ok', config: validateConfig(raw, dir, files) }, files };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`config INVALID — all messages for this group will be blocked until fixed: ${error}`);
    return { result: { status: 'invalid', error }, files };
  }
}

const TOP_LEVEL_KEYS = new Set(['input_rules', 'output_rules', 'alerts', 'quarantine']);
const RULE_KEYS: Record<GuardrailRule['type'], Set<string>> = {
  regex: new Set(['id', 'type', 'action', 'message', 'pattern', 'flags']),
  keyphrase: new Set(['id', 'type', 'action', 'message', 'phrases', 'phrases_file']),
};

function validateConfig(raw: unknown, dir: string, files: CacheEntry['files']): GuardrailsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('guardrails.json must be a JSON object');
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new ConfigError(`unknown top-level key '${key}'`);
    }
  }
  return {
    input_rules: validateRules(o.input_rules, 'input_rules', dir, files),
    output_rules: validateRules(o.output_rules, 'output_rules', dir, files),
    alerts: validateAlerts(o.alerts),
    quarantine: validateQuarantine(o.quarantine),
  };
}

function validateRules(raw: unknown, field: string, dir: string, files: CacheEntry['files']): GuardrailRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError(`${field} must be an array`);
  const rules: GuardrailRule[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const rule = validateRule(entry, field, dir, files);
    // Uniqueness matters beyond hygiene: alert-collapse keys are built from ids.
    if (seen.has(rule.id)) throw new ConfigError(`${field}: duplicate rule id '${rule.id}'`);
    seen.add(rule.id);
    rules.push(rule);
  }
  return rules;
}

function validateRule(entry: unknown, field: string, dir: string, files: CacheEntry['files']): GuardrailRule {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ConfigError(`${field}: every rule must be an object`);
  }
  const o = entry as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) throw new ConfigError(`${field}: rule missing id`);
  const id = o.id;
  if (o.type !== 'regex' && o.type !== 'keyphrase') {
    throw new ConfigError(`${field}: rule '${id}' has unknown type '${String(o.type)}' (expected regex|keyphrase)`);
  }
  const type = o.type;
  for (const key of Object.keys(o)) {
    if (!RULE_KEYS[type].has(key)) {
      throw new ConfigError(`${field}: rule '${id}' has unknown key '${key}' for type '${type}'`);
    }
  }
  if (o.action !== undefined && o.action !== 'block' && o.action !== 'flag') {
    throw new ConfigError(`${field}: rule '${id}' has invalid action '${String(o.action)}' (expected block|flag)`);
  }
  const action: GuardrailAction = o.action === 'flag' ? 'flag' : 'block';
  if (o.message !== undefined && (typeof o.message !== 'string' || !o.message)) {
    throw new ConfigError(`${field}: rule '${id}' message must be a non-empty string`);
  }
  const rule: GuardrailRule = { id, type, action };
  if (typeof o.message === 'string') rule.message = o.message;

  if (type === 'regex') {
    if (typeof o.pattern !== 'string' || !o.pattern) {
      throw new ConfigError(`${field}: regex rule '${id}' missing pattern`);
    }
    if (o.pattern.length > MAX_PATTERN_LENGTH) {
      throw new ConfigError(
        `${field}: regex rule '${id}' pattern is ${o.pattern.length} chars (max ${MAX_PATTERN_LENGTH})`,
      );
    }
    if (o.flags !== undefined && typeof o.flags !== 'string') {
      throw new ConfigError(`${field}: regex rule '${id}' flags must be a string`);
    }
    try {
      new RegExp(o.pattern, typeof o.flags === 'string' ? o.flags.replace(/[gy]/g, '') : undefined);
    } catch (err) {
      throw new ConfigError(
        `${field}: regex rule '${id}' pattern does not compile (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    rule.pattern = o.pattern;
    if (typeof o.flags === 'string') rule.flags = o.flags;
  } else {
    if (o.phrases !== undefined && (!Array.isArray(o.phrases) || o.phrases.some((p) => typeof p !== 'string' || !p))) {
      throw new ConfigError(`${field}: keyphrase rule '${id}' phrases must be an array of non-empty strings`);
    }
    const phrases = Array.isArray(o.phrases) ? [...(o.phrases as string[])] : [];
    if (o.phrases_file !== undefined) {
      if (typeof o.phrases_file !== 'string' || !o.phrases_file) {
        throw new ConfigError(`${field}: keyphrase rule '${id}' phrases_file must be a non-empty string`);
      }
      const text = readSidecar(dir, o.phrases_file, files, id, field);
      phrases.push(
        ...text
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#')),
      );
    }
    if (phrases.length === 0) throw new ConfigError(`${field}: keyphrase rule '${id}' has no phrases`);
    rule.phrases = phrases;
  }
  return rule;
}

function validateAlerts(raw: unknown): { prefix: string } {
  if (raw === undefined) return { prefix: '⚠️ Guardrail' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('alerts must be an object');
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== 'prefix') throw new ConfigError(`alerts: unknown key '${key}'`);
  }
  if (o.prefix !== undefined && (typeof o.prefix !== 'string' || !o.prefix)) {
    throw new ConfigError('alerts.prefix must be a non-empty string');
  }
  return { prefix: typeof o.prefix === 'string' ? o.prefix : '⚠️ Guardrail' };
}

function validateQuarantine(raw: unknown): QuarantineLimits {
  if (raw === undefined) return { max_file_mb: 10, max_files: 5 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('quarantine must be an object');
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== 'max_file_mb' && key !== 'max_files') throw new ConfigError(`quarantine: unknown key '${key}'`);
  }
  for (const key of ['max_file_mb', 'max_files'] as const) {
    const v = o[key];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
      throw new ConfigError(`quarantine.${key} must be a positive number`);
    }
  }
  return {
    max_file_mb: typeof o.max_file_mb === 'number' ? o.max_file_mb : 10,
    max_files: typeof o.max_files === 'number' ? o.max_files : 5,
  };
}

/**
 * Read a phrases_file sidecar relative to the guardrails dir, refusing
 * traversal outside it. Tracks the file in the cache-validation set (before
 * the read can fail) so edits are picked up.
 */
function readSidecar(dir: string, relPath: string, files: CacheEntry['files'], ruleId: string, field: string): string {
  const resolved = path.resolve(dir, relPath);
  const root = path.resolve(dir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ConfigError(`${field}: rule '${ruleId}' phrases_file '${relPath}' escapes the guardrails directory`);
  }
  files.push({ path: resolved, mtimeMs: statMtime(resolved) });
  try {
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `${field}: rule '${ruleId}' phrases_file '${relPath}' is unreadable (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
