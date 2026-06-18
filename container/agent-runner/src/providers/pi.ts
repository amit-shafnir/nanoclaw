/**
 * Pi coding-agent provider (in-process SDK embed).
 *
 * Runs `@earendil-works/pi-coding-agent` as a NanoClaw provider. Pi keeps its
 * own builtin coding tools (read/bash/edit/write/…) AND gets NanoClaw's MCP
 * tools on top, bridged to Pi custom tools (pi-mcp-bridge.ts). Auth is
 * vault-only: a placeholder `ANTHROPIC_API_KEY` gates model availability while
 * OneCLI swaps the real key on the wire (see host src/providers/pi.ts).
 *
 * This file's single secret is how Pi's in-process session is driven to satisfy
 * NanoClaw's provider contract: event stream → `ProviderEvent`, prompt/push/
 * abort, instruction + memory delivery, DB-replay, archive, teardown. The
 * lifecycle mirrors the ACP provider — Pi is NOT ACP, but the contract is the
 * same. The container is ephemeral, so the session is in-memory and cross-wake
 * context comes from DB-replay, not a resumed Pi session.
 *
 * All Pi-SDK calls live behind the `PiSessionOpener` seam (the real third-party
 * edge) so the driver — queues, keepalive ticker, replay, event mapping,
 * teardown — is unit-testable without a live model.
 */
import { getModel } from '@earendil-works/pi-ai';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSessionEvent,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { buildReplayHistory } from '../db/replay.js';
import { readComposedInstructions } from './agent-instructions.js';
import { archiveProviderExchange } from './exchange-archive.js';
import { buildPiToolBridge, type PiToolBridge } from './pi-mcp-bridge.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderExchange,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[pi-provider] ${msg}`);
}

/**
 * Model pinned to Sonnet 4.6 (§5): predictable + known-cost, not Pi's opaque
 * "first available". Per-group override is later work.
 */
const PI_MODEL_ID = 'claude-sonnet-4-6';

/**
 * Pi's builtin coding tools to enable — mirrors Claude's allowlist. NanoClaw's
 * MCP has no shell/file tools, so Pi MUST keep its own; `customTools` adds
 * NanoClaw's on top. Never `noTools: 'builtin'` — that would leave Pi unable to
 * run commands or edit files.
 */
const PI_CODING_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

/**
 * Fixed DB-replay window (turns) for the resume-less Pi session; matches the
 * default prompt batch size. Deliberately fixed, not token-budgeted.
 */
const REPLAY_WINDOW = 10;

/**
 * Keepalive ticker interval while a tool runs (§4.2). 5s < the 6s typing-
 * indicator staleness threshold and well under the 60s SIGKILL, so the
 * container stays alive and the "Pi is typing…" dots stay smooth during a long
 * tool — for Pi-native AND bridged tools.
 */
const KEEPALIVE_MS = 5_000;

// ── Pure helpers (unit-tested directly) ──────────────────────────────────────

const QUOTA_RE = /quota|rate[ _-]?limit|429|resource[ _-]?exhausted|too many requests|overloaded/i;
const AUTH_RE = /401|403|unauthorized|invalid[ _-]?api[ _-]?key|authentication|forbidden/i;
const RETRYABLE_RE = /timeout|etimedout|econnreset|enotfound|socket hang up|503|502|504/i;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Classify a thrown Pi error for the `error` event. Quota and auth fail closed
 * (non-retryable); transient network/transport errors retry; anything else fails
 * closed so nothing retries forever. `await session.prompt()` absorbs Pi's own
 * auto-retry, so what surfaces here is already a terminal failure.
 */
export function classifyPiError(err: unknown): { retryable: boolean; classification?: string } {
  const msg = errorMessage(err);
  if (QUOTA_RE.test(msg)) return { retryable: false, classification: 'quota' };
  if (AUTH_RE.test(msg)) return { retryable: false, classification: 'auth' };
  if (RETRYABLE_RE.test(msg)) return { retryable: true };
  return { retryable: false };
}

/**
 * Map one Pi session event to a `ProviderEvent`. Streamed assistant text becomes
 * `progress`; everything else (thinking, tool lifecycle, turn/agent end, retries)
 * is an `activity` ping so the host idle timer stays honest. The turn's *result*
 * is NOT read from any event — it comes from `session.getLastAssistantText()`
 * after `prompt()` resolves (`turn_end` fires every LLM turn; `agent_end` carries
 * `willRetry`, neither is the final answer).
 */
export function translatePiEvent(event: AgentSessionEvent): ProviderEvent {
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
    return { type: 'progress', message: event.assistantMessageEvent.delta };
  }
  return { type: 'activity' };
}

/** A tool-scoped keepalive ticker. Its lifecycle is driven by Pi tool events. */
export interface ToolKeepalive {
  /** Feed each Pi event; starts the ticker on the first running tool, stops it when none remain. */
  onEvent(event: AgentSessionEvent): void;
  /** Stop unconditionally (teardown / abort). */
  stop(): void;
}

/**
 * Keepalive ticker (§4.2): while ≥1 tool is running, call `onTick` every
 * `intervalMs` so the provider can push an activity ping and keep the heartbeat
 * fresh during a long tool (Pi-native OR bridged). Depth-counted so parallel
 * tools don't stop it early; scoped to tool start/end so a Pi hung *outside* a
 * tool still goes silent and hits the host's SIGKILL.
 */
export function createToolKeepalive(onTick: () => void, intervalMs: number): ToolKeepalive {
  let depth = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  const start = (): void => {
    if (!ticker) ticker = setInterval(onTick, intervalMs);
  };
  const stop = (): void => {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
  return {
    onEvent(event) {
      if (event.type === 'tool_execution_start') {
        depth += 1;
        start();
      } else if (event.type === 'tool_execution_end') {
        depth = Math.max(0, depth - 1);
        if (depth === 0) stop();
      }
    },
    stop,
  };
}

// ── Pi-SDK seam ──────────────────────────────────────────────────────────────

/** The slice of a Pi `AgentSession` the provider drives. */
export interface PiSession {
  readonly sessionId: string;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  abort(): Promise<void>;
  dispose(): void;
}

/** Open a Pi session for a wake, given the bridged NanoClaw tools. */
export type PiSessionOpener = (input: QueryInput, customTools: ToolDefinition[]) => Promise<PiSession>;

/**
 * Build Pi's resource loader. NanoClaw composes the entire instruction corpus
 * (flattened `CLAUDE.md` + `CLAUDE.local.md`) and the runtime addendum (agent
 * name + live destinations + the `<message to=…>` wrapping rule); they ride Pi's
 * system prompt via `appendSystemPromptOverride`. Pi's own discovery is off so
 * nothing else leaks in. The addendum is load-bearing — without the wrapping
 * rule every reply misses `dispatchResultText` and is dropped.
 */
export function composeAppendedSystemPrompt(input: QueryInput): string[] {
  const corpus = readComposedInstructions(input.cwd);
  const addendum = input.systemContext?.instructions;
  return [corpus, addendum].filter((part): part is string => Boolean(part));
}

async function buildResourceLoader(input: QueryInput): Promise<DefaultResourceLoader> {
  const appended = composeAppendedSystemPrompt(input);
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: getAgentDir(),
    noContextFiles: true,
    noSkills: true,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    // Append to Pi's base coding-agent prompt (keep its tool guidance), like
    // Claude's `append`. The override also suppresses Pi's own APPEND_SYSTEM.md.
    appendSystemPromptOverride: (base) => [...base, ...appended],
  });
  await loader.reload();
  return loader;
}

/**
 * Real session opener: pinned model, Pi's builtins + the bridged NanoClaw tools,
 * an in-memory session/auth/registry (the container is ephemeral; the
 * placeholder ANTHROPIC_API_KEY is read from the env to gate model availability,
 * and OneCLI swaps the real key on the wire).
 */
const defaultSessionOpener: PiSessionOpener = async (input, customTools) => {
  const authStorage = AuthStorage.inMemory();
  const { session } = await createAgentSession({
    cwd: input.cwd,
    model: getModel('anthropic', PI_MODEL_ID),
    tools: PI_CODING_TOOLS,
    customTools,
    sessionManager: SessionManager.inMemory(input.cwd),
    resourceLoader: await buildResourceLoader(input),
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
  });
  return session;
};

// ── Internal queues (provider-agnostic; mirror the ACP provider) ─────────────

/**
 * Push-based event stream the poll-loop consumes. `fail()` lets the driver
 * surface a fatal error: queued events drain first, then the iterator throws
 * (so the poll-loop runs its user-facing error + session-recovery path).
 */
class EventQueue implements AsyncIterable<ProviderEvent> {
  private queue: ProviderEvent[] = [];
  private waiting: (() => void) | null = null;
  private done = false;
  private failure: unknown = null;

  push(event: ProviderEvent): void {
    this.queue.push(event);
    this.wake();
  }

  end(): void {
    this.done = true;
    this.wake();
  }

  fail(err: unknown): void {
    this.failure = err;
    this.done = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.failure) throw this.failure;
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}

/** Single-consumer queue of prompts to run as turns. `take()` blocks until a prompt arrives or the queue ends. */
class PromptQueue {
  private queue: string[] = [];
  private waiting: ((value: string | null) => void) | null = null;
  private ended = false;

  push(prompt: string): void {
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w(prompt);
    } else {
      this.queue.push(prompt);
    }
  }

  end(): void {
    this.ended = true;
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w(null);
    }
  }

  take(): Promise<string | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class PiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly mcpServers: Record<string, McpServerConfig>;
  private readonly openSession: PiSessionOpener;

  constructor(options: ProviderOptions = {}, openSession: PiSessionOpener = defaultSessionOpener) {
    this.mcpServers = options.mcpServers ?? {};
    this.openSession = openSession;
  }

  isSessionInvalid(): boolean {
    // The session is in-memory and recreated every wake — there is no stored
    // continuation whose transcript could be missing or stale.
    return false;
  }

  onExchangeComplete(exchange: ProviderExchange): void {
    archiveProviderExchange({
      provider: 'pi',
      prompt: exchange.prompt,
      result: exchange.result,
      continuation: exchange.continuation,
      status: exchange.status,
    });
  }

  query(input: QueryInput): AgentQuery {
    const events = new EventQueue();
    const prompts = new PromptQueue();
    prompts.push(input.prompt);

    let aborted = false;
    let session: PiSession | null = null;
    let bridge: PiToolBridge | null = null;
    let unsubscribe: (() => void) | null = null;
    const keepalive = createToolKeepalive(() => events.push({ type: 'activity' }), KEEPALIVE_MS);

    const driver = async (): Promise<void> => {
      try {
        bridge = await buildPiToolBridge(this.mcpServers);
        session = await this.openSession(input, bridge.customTools);

        unsubscribe = session.subscribe((event) => {
          keepalive.onEvent(event);
          events.push(translatePiEvent(event));
        });

        // Synthetic init: the in-memory session id is bookkeeping only (no
        // cross-wake resume), but emitting it lets the poll-loop persist a
        // continuation so the NEXT wake knows there is prior history to replay.
        events.push({ type: 'init', continuation: session.sessionId });

        // Fresh session each wake → prepend a DB-replay transcript of recent
        // ANSWERED turns to the first prompt only (completed-rows-only avoids
        // double-feeding the live batch). `input.continuation` is truthy only on
        // a 2nd+ wake — exactly when prior history exists.
        const replay = input.continuation ? buildReplayHistory(REPLAY_WINDOW) : null;
        let first = true;

        while (!aborted) {
          const text = await prompts.take();
          if (text === null || aborted) break;
          const promptText = first && replay ? `${replay}\n\n${text}` : text;
          first = false;
          await session.prompt(promptText);
          // Result = the turn's final assistant text, read AFTER prompt() resolves
          // (it resolves only at run-end and absorbs Pi's internal auto-retry).
          events.push({ type: 'result', text: session.getLastAssistantText() || null });
        }
        events.end();
      } catch (err) {
        if (aborted) {
          events.end();
          return;
        }
        const { retryable, classification } = classifyPiError(err);
        log(`query error: ${errorMessage(err)}`);
        events.push({ type: 'error', message: errorMessage(err), retryable, classification });
        events.fail(err instanceof Error ? err : new Error(errorMessage(err)));
      } finally {
        keepalive.stop();
        unsubscribe?.();
        await bridge?.close();
        session?.dispose();
      }
    };

    void driver();

    return {
      push: (message: string) => prompts.push(message),
      end: () => prompts.end(),
      events,
      abort: () => {
        aborted = true;
        keepalive.stop();
        // session.abort() is async and waits for idle — fire-and-forget, swallow
        // the rejection (an escaped rejection would kill the container). The
        // driver's finally still closes the bridge and disposes the session.
        session?.abort().catch(() => {});
        prompts.end();
        events.end();
      },
    };
  }
}

registerProvider('pi', (opts) => new PiProvider(opts));
