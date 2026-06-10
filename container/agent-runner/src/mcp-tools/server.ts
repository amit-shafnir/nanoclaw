/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

/**
 * Tool-call middleware. Modules register wrappers around every tool
 * dispatch — one seam covers all registered tools, present and future, so a
 * cross-cutting concern (e.g. an output content filter) never edits a tool module.
 * Registration order = chain order (first registered runs outermost). A
 * middleware that doesn't call `next` decides the call's result itself.
 */
export type ToolMiddleware = (
  name: string,
  args: Record<string, unknown>,
  next: () => Promise<CallToolResult>,
) => Promise<CallToolResult>;

const middlewares: ToolMiddleware[] = [];

export function registerToolMiddleware(mw: ToolMiddleware): void {
  middlewares.push(mw);
}

/** Dispatch one tool call through the middleware chain to its handler. */
export async function dispatchToolCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const tool = toolMap.get(name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
  const invoke = middlewares.reduceRight<() => Promise<CallToolResult>>(
    (next, mw) => () => mw(name, args, next),
    () => tool.handler(args),
  );
  return invoke();
}

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return dispatchToolCall(name, args ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(', ')}`);
}
