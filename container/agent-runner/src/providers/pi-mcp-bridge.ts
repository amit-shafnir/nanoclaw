/**
 * MCP-client tool bridge: NanoClaw's stdio MCP servers → Pi custom tools.
 *
 * Pi has no native MCP. NanoClaw's tools (`send_message`, `schedule_task`,
 * `ask_user_question`, `create_agent`, self-mod, plus any third-party server a
 * group wired) are exposed to Pi as Pi *custom tools* — additive to Pi's own
 * builtin coding tools, never a replacement. This module's single secret is how
 * one stdio MCP server becomes a set of `defineTool` proxies: connect → list →
 * wrap each tool so the model's call is forwarded back over MCP.
 *
 * One `listTools → defineTool` loop covers the built-in tools AND any
 * third-party MCP server with zero per-tool code, reusing each tool's canonical
 * schema. The heartbeat keepalive is NOT here — it lives at the provider level
 * (pi.ts) so it also covers Pi's own native bash/file tools.
 *
 * The MCP connection sits behind a factory seam (the real third-party edge) so
 * the wrap/forward/teardown logic is unit-testable without spawning processes.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defineTool, type AgentToolResult, type ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { McpServerConfig } from './types.js';

function log(msg: string): void {
  console.error(`[pi-mcp-bridge] ${msg}`);
}

// The MCP SDK's default per-request timeout is 60s; the interactive nanoclaw
// tools (ask_user_question blocks on a human reply) need far longer.
// fixed 300s ceiling — matches the longest blocking tool today; revisit if a tool blocks longer.
const CALL_TIMEOUT_MS = 300_000;

type PiContent = AgentToolResult<unknown>['content'];

/**
 * Pi-facing tool name. NanoClaw's instruction corpus documents every built-in
 * tool by its Claude-SDK name (`mcp__<server>__<tool>`, e.g.
 * `mcp__nanoclaw__create_agent`). Pi has no MCP namespace of its own, so the
 * bridge must register tools under that exact name or the model — following its
 * instructions — calls a name that isn't in the toolset and gets "not found".
 * Server-segment sanitization mirrors `mcpAllowPattern` in the Claude provider;
 * the wire call to the MCP server still uses the bare tool name.
 */
function piToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__${toolName}`;
}

// ── MCP connection seam ──────────────────────────────────────────────────────

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpCallOptions {
  timeout: number;
  signal?: AbortSignal;
}

/** The slice of an MCP client the bridge drives, plus teardown. */
export interface McpToolConnection {
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>, options: McpCallOptions): Promise<{ content: unknown }>;
  /** Close the client and force-kill its child process. */
  close(): Promise<void>;
}

export type McpConnectionFactory = (name: string, server: McpServerConfig) => Promise<McpToolConnection>;

/**
 * Real connection: spawn the MCP server over stdio and wrap its client. The
 * child inherits the container env (PATH, and HTTPS_PROXY for the OneCLI egress
 * path) plus the server's own overrides.
 */
const defaultMcpConnectionFactory: McpConnectionFactory = async (name, server) => {
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) baseEnv[key] = value;
  }
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...baseEnv, ...server.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: `nanoclaw-pi-bridge:${name}`, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools as McpToolDescriptor[];
    },
    async callTool(toolName, args, options) {
      // callTool's result union includes a legacy `{ toolResult }` shape with no
      // `content`; normalize to `{ content }` (absent → empty).
      const res = await client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: options.timeout,
        signal: options.signal,
      });
      return { content: (res as { content?: unknown }).content };
    },
    async close() {
      const { pid } = transport;
      try {
        await client.close();
      } catch (err) {
        log(`error closing MCP client "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
      // close() closes the transport which kills the child, but force-kill any
      // survivor. single-pid kill, not a process-group kill —
      // StdioClientTransport doesn't spawn detached, and the container is the
      // real sandbox (these servers die with it regardless).
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    },
  };
};

// ── Content mapping ──────────────────────────────────────────────────────────

/**
 * Flatten an MCP tool result's content blocks to Pi tool-result content.
 * text-only — the nanoclaw MCP tools return text; a non-text block
 * (e.g. an image from a third-party server) is JSON-stringified rather than
 * dropped. Upgrade path: pass image blocks through structurally if an
 * image-returning MCP tool is ever wired.
 */
export function toPiContent(content: unknown): PiContent {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map((block) => {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      return { type: 'text', text: typeof text === 'string' ? text : String(text ?? '') };
    }
    return { type: 'text', text: JSON.stringify(block) };
  }) as PiContent;
}

// ── Bridge ───────────────────────────────────────────────────────────────────

export interface PiToolBridge {
  /** NanoClaw's MCP tools as Pi custom tools, registered alongside Pi's builtins. */
  customTools: ToolDefinition[];
  /** Close every MCP client and force-kill any surviving child process. */
  close(): Promise<void>;
}

/**
 * Connect each configured MCP server and wrap its tools as Pi custom tools. A
 * server that fails to connect is logged and skipped — one broken third-party
 * server must not sink the whole turn (the built-in nanoclaw tools still load).
 */
export async function buildPiToolBridge(
  mcpServers: Record<string, McpServerConfig>,
  connect: McpConnectionFactory = defaultMcpConnectionFactory,
): Promise<PiToolBridge> {
  const connections: McpToolConnection[] = [];
  const customTools: ToolDefinition[] = [];

  for (const [name, server] of Object.entries(mcpServers)) {
    let connection: McpToolConnection;
    try {
      connection = await connect(name, server);
    } catch (err) {
      log(`failed to connect MCP server "${name}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    connections.push(connection);

    const tools = await connection.listTools();
    for (const tool of tools) {
      customTools.push(
        defineTool({
          name: piToolName(name, tool.name),
          label: piToolName(name, tool.name),
          description: tool.description ?? '',
          // The model receives this JSON Schema as-is. Pi types `parameters` as a
          // TypeBox schema; an MCP `inputSchema` is structurally JSON Schema and is
          // forwarded to the LLM without hard validation, so the cast is safe.
          // Fallback if Pi ever validates: a `prepareArguments` shim.
          parameters: tool.inputSchema as ToolDefinition['parameters'],
          execute: async (_id, params, signal): Promise<AgentToolResult<unknown>> => {
            const res = await connection.callTool(tool.name, (params ?? {}) as Record<string, unknown>, {
              timeout: CALL_TIMEOUT_MS,
              signal,
            });
            return { content: toPiContent(res.content), details: {} };
          },
        }),
      );
    }
  }

  return {
    customTools,
    async close() {
      for (const connection of connections) {
        try {
          await connection.close();
        } catch (err) {
          log(`teardown error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  };
}
