/**
 * Conversation-replay history for providers that can't resume their own session
 * across container restarts. The Pi provider opens a fresh in-memory session
 * every wake (the container is ephemeral, so there is no Pi session to resume),
 * so cross-wake context has to come from somewhere else.
 *
 * NanoClaw's two session DBs are the authoritative, provider-independent
 * transcript: read the last few completed turns from `messages_in` +
 * `messages_out`, interleave by the global `seq` (host even / container odd →
 * chronological when sorted), and render a compact preamble Pi prepends to the
 * fresh prompt.
 *
 * Deliberately a fixed window, not token-budgeted or summarizing compaction —
 * that would re-implement, worse, what capable harnesses do internally. The
 * `conversations/` archive (written via `onExchangeComplete`) covers deep recall.
 */
import { openInboundDb, getOutboundDb } from './connection.js';

interface HistoryTurn {
  seq: number;
  role: 'user' | 'assistant';
  /** Speaker label for user turns; omitted for assistant turns. */
  sender?: string;
  text: string;
}

function parseContent(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { text: json };
  } catch {
    return { text: json };
  }
}

function inboundText(content: Record<string, unknown>): string {
  return typeof content.text === 'string' ? content.text : '';
}

function inboundSender(content: Record<string, unknown>): string {
  if (typeof content.sender === 'string' && content.sender) return content.sender;
  const author = content.author as { fullName?: string; userName?: string } | undefined;
  return author?.fullName || author?.userName || 'User';
}

/**
 * Build a fixed-window transcript preamble of the most recent ANSWERED turns,
 * oldest first. Returns `null` when there is no prior history to replay.
 *
 * Only inbound messages the container has marked `completed` in processing_ack
 * count as history; everything else is omitted — the current in-flight batch
 * (still `processing`) AND any unanswered `pending` messages (batch-cap overflow
 * while the container was down, or arrivals mid-handshake). Those must be fed as
 * live prompts, never replayed back as "do not re-answer" history (replaying an
 * unanswered message there double-feeds it: history + live prompt). See below
 * for why processing_ack — not the lazily-synced, host-owned messages_in.status
 * — is the authoritative signal.
 *
 * @param maxMessages - hard cap on turns included (the fixed window).
 */
export function buildReplayHistory(maxMessages: number): string | null {
  if (maxMessages <= 0) return null;

  // A turn is history only once the container has answered it: markCompleted
  // writes processing_ack `completed` (container-owned, persisted in outbound.db
  // across restarts, never cleared once completed). Selecting the completed set
  // excludes both the current `processing` batch and any never-claimed `pending`
  // messages, so an unanswered message can never be replayed as history and then
  // also fed live. (messages_in.status is host-owned and sweep-synced lazily, so
  // a row that is not `completed` in processing_ack is authoritatively not yet
  // history.)
  const answeredRows = getOutboundDb()
    .prepare("SELECT message_id FROM processing_ack WHERE status = 'completed'")
    .all() as Array<{ message_id: string }>;
  const answered = new Set(answeredRows.map((r) => r.message_id));
  const turns: HistoryTurn[] = [];

  const inbound = openInboundDb();
  try {
    const rows = inbound
      .prepare(
        `SELECT id, seq, content FROM messages_in
         WHERE kind != 'system' AND seq IS NOT NULL
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(maxMessages * 2) as Array<{ id: string; seq: number; content: string }>;
    for (const row of rows) {
      if (!answered.has(row.id)) continue;
      const content = parseContent(row.content);
      const text = inboundText(content);
      if (text) turns.push({ seq: row.seq, role: 'user', sender: inboundSender(content), text });
    }
  } finally {
    inbound.close();
  }

  const outRows = getOutboundDb()
    .prepare(
      `SELECT seq, content FROM messages_out
       WHERE kind = 'chat' AND seq IS NOT NULL
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(maxMessages * 2) as Array<{ seq: number; content: string }>;
  for (const row of outRows) {
    const text = inboundText(parseContent(row.content));
    if (text) turns.push({ seq: row.seq, role: 'assistant', text });
  }

  if (turns.length === 0) return null;

  // Chronological order, then keep only the most recent window.
  turns.sort((a, b) => a.seq - b.seq);
  const window = turns.slice(-maxMessages);
  if (window.length === 0) return null;

  const lines = window.map((t) => (t.role === 'user' ? `[${t.sender}] ${t.text}` : `[assistant] ${t.text}`));

  return [
    '<conversation_history note="Recent prior messages in this conversation, oldest first. Use them for context; do not re-answer them.">',
    ...lines,
    '</conversation_history>',
  ].join('\n');
}
