/**
 * Guardrails quarantine — block-but-retain audit store.
 *
 * Every blocked/flagged message is written in full (original content + rule +
 * reason) to data/guardrails/<agent-group-id>/quarantine.jsonl. This path is
 * host-only and never mounted into a container: if the agent could read it,
 * it could read the very injection a guardrail just blocked.
 *
 * Growth is bounded: the file rotates at `max_file_mb` to a dated archive and
 * at most `max_files` archives are kept. Oversized message content is
 * truncated per line.
 *
 * Container-side blocks can't reach data/ — they emit a `kind:'system'`
 * outbound row with action 'guardrail_quarantine' and the delivery-action
 * handler registered here persists it to the same file.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import type { QuarantineLimits } from './config.js';

const DEFAULT_LIMITS: QuarantineLimits = { max_file_mb: 10, max_files: 5 };
const MAX_CONTENT_CHARS = 64_000;

export interface QuarantineRecord {
  ts: string;
  source: 'host' | 'container';
  direction: 'input' | 'output';
  ruleId: string;
  ruleType: string;
  action: 'block' | 'flag';
  reason?: string;
  sessionId?: string | null;
  channelType?: string | null;
  platformId?: string | null;
  userId?: string | null;
  /**
   * Full original message content (JSON blob as stored in the session DB).
   * Absent on container-emitted input-direction records: outbound.db is
   * agent-readable, so blocked input text never travels through it — those
   * records carry `messageId` instead (the text stays in inbound.db).
   */
  content?: string;
  /** messages_in id of the blocked row, when `content` is omitted. */
  messageId?: string;
  truncated?: boolean;
}

export function quarantineFilePath(agentGroupId: string, baseDir: string = DATA_DIR): string {
  return path.join(baseDir, 'guardrails', agentGroupId, 'quarantine.jsonl');
}

/** Append one quarantine record. Never throws — audit failure must not break message flow. */
export function appendQuarantine(
  agentGroupId: string,
  record: QuarantineRecord,
  limits: QuarantineLimits = DEFAULT_LIMITS,
  baseDir: string = DATA_DIR,
): void {
  try {
    const file = quarantineFilePath(agentGroupId, baseDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file, limits);
    let content = record.content;
    let truncated = false;
    if (typeof content === 'string' && content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS);
      truncated = true;
    }
    // JSON.stringify drops `content` when undefined — no empty-string coercion.
    const line = JSON.stringify({ ...record, content, ...(truncated ? { truncated: true } : {}) });
    fs.appendFileSync(file, line + '\n');
  } catch (err) {
    log.error('Guardrails quarantine append failed', { agentGroupId, err });
  }
}

function rotateIfNeeded(file: string, limits: QuarantineLimits): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // no file yet
  }
  if (size < limits.max_file_mb * 1024 * 1024) return;

  const dir = path.dirname(file);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(file, path.join(dir, `quarantine-${stamp}.jsonl`));

  // Prune oldest archives beyond max_files. Names embed the rotation
  // timestamp, so lexicographic order is chronological.
  const archives = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('quarantine-') && f.endsWith('.jsonl'))
    .sort();
  while (archives.length > limits.max_files) {
    const oldest = archives.shift();
    if (oldest) fs.rmSync(path.join(dir, oldest), { force: true });
  }
}

/**
 * Wire the container→host quarantine path: containers emit a system action
 * row ('guardrail_quarantine') because they cannot write under data/; the
 * delivery poll hands it here. Errors are swallowed (with a log) so a bad
 * record can never wedge the delivery loop in a retry cycle.
 */
export function registerGuardrailsDeliveryAction(): void {
  registerDeliveryAction('guardrail_quarantine', async (content, session) => {
    const record = content.record as QuarantineRecord | undefined;
    if (!record || typeof record !== 'object' || typeof record.ruleId !== 'string') {
      log.warn('guardrail_quarantine action missing/invalid record', { sessionId: session.id });
      return;
    }
    appendQuarantine(session.agent_group_id, {
      ...record,
      source: 'container',
      sessionId: record.sessionId ?? session.id,
      // Input-direction container records legitimately omit content (they
      // carry messageId); anything non-string is dropped, not coerced.
      content: typeof record.content === 'string' ? record.content : undefined,
    });
  });
}
