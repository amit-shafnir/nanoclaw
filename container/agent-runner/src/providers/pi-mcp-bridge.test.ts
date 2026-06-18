import { describe, expect, it } from 'bun:test';

import { buildPiToolBridge, toPiContent, type McpCallOptions, type McpToolConnection } from './pi-mcp-bridge.js';
import type { McpServerConfig } from './types.js';

interface CallRecord {
  name: string;
  args: Record<string, unknown>;
  options: McpCallOptions;
}

/** A fake MCP connection that records calls instead of spawning a process. */
function fakeConnection(
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>,
  result: unknown,
): McpToolConnection & { calls: CallRecord[]; closed: number } {
  const calls: CallRecord[] = [];
  return {
    calls,
    closed: 0,
    async listTools() {
      return tools;
    },
    async callTool(name, args, options) {
      calls.push({ name, args, options });
      return { content: result };
    },
    async close() {
      this.closed += 1;
    },
  };
}

const SERVER: McpServerConfig = { command: 'node', args: ['server.js'], env: {} };

// A minimal ExtensionContext stand-in — execute() ignores it in the bridge.
const CTX = {} as never;

describe('buildPiToolBridge', () => {
  it('exposes each tool under its Claude-SDK name (mcp__<server>__<tool>) so instruction references resolve', async () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } } };
    const conn = fakeConnection([{ name: 'send_message', description: 'send it', inputSchema: schema }], []);
    const bridge = await buildPiToolBridge({ nanoclaw: SERVER }, async () => conn);

    expect(bridge.customTools).toHaveLength(1);
    const tool = bridge.customTools[0];
    expect(tool.name).toBe('mcp__nanoclaw__send_message');
    expect(tool.label).toBe('mcp__nanoclaw__send_message');
    expect(tool.description).toBe('send it');
    expect(tool.parameters).toBe(schema as never);
  });

  it('sanitizes the server segment of the exposed name', async () => {
    const conn = fakeConnection([{ name: 'do_it', inputSchema: {} }], []);
    const bridge = await buildPiToolBridge({ 'my.server:1': SERVER }, async () => conn);
    expect(bridge.customTools[0].name).toBe('mcp__my_server_1__do_it');
  });

  it('forwards execute() to callTool with the 300s timeout and passes the signal through', async () => {
    const conn = fakeConnection([{ name: 'ask_user_question', inputSchema: {} }], [{ type: 'text', text: 'reply' }]);
    const bridge = await buildPiToolBridge({ nanoclaw: SERVER }, async () => conn);
    const controller = new AbortController();

    const res = await bridge.customTools[0].execute('call-1', { question: 'hi?' }, controller.signal, undefined, CTX);

    expect(conn.calls).toHaveLength(1);
    expect(conn.calls[0].name).toBe('ask_user_question');
    expect(conn.calls[0].args).toEqual({ question: 'hi?' });
    expect(conn.calls[0].options.timeout).toBe(300_000);
    expect(conn.calls[0].options.signal).toBe(controller.signal);
    // MCP text content passes straight through to Pi tool-result content.
    expect(res.content).toEqual([{ type: 'text', text: 'reply' }]);
  });

  it('empty/missing description becomes an empty string', async () => {
    const conn = fakeConnection([{ name: 't', inputSchema: {} }], []);
    const bridge = await buildPiToolBridge({ s: SERVER }, async () => conn);
    expect(bridge.customTools[0].description).toBe('');
  });

  it('aggregates tools across multiple servers and skips one that fails to connect', async () => {
    const ok = fakeConnection([{ name: 'a', inputSchema: {} }], []);
    const bridge = await buildPiToolBridge({ good: SERVER, bad: SERVER }, async (name) => {
      if (name === 'bad') throw new Error('spawn failed');
      return ok;
    });
    // The broken server is skipped; the working one's tool still loads.
    expect(bridge.customTools.map((t) => t.name)).toEqual(['mcp__good__a']);
  });

  it('close() tears down every connection', async () => {
    const a = fakeConnection([{ name: 'a', inputSchema: {} }], []);
    const b = fakeConnection([{ name: 'b', inputSchema: {} }], []);
    const conns = [a, b];
    let i = 0;
    const bridge = await buildPiToolBridge({ one: SERVER, two: SERVER }, async () => conns[i++]);

    await bridge.close();
    expect(a.closed).toBe(1);
    expect(b.closed).toBe(1);
  });
});

describe('toPiContent', () => {
  it('passes text blocks through', () => {
    expect(toPiContent([{ type: 'text', text: 'hello' }])).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('JSON-stringifies non-text blocks rather than dropping them', () => {
    const out = toPiContent([{ type: 'image', data: 'xyz' }]);
    expect(out).toEqual([{ type: 'text', text: JSON.stringify({ type: 'image', data: 'xyz' }) }]);
  });

  it('wraps a non-array result into a single block', () => {
    expect(toPiContent('raw')).toEqual([{ type: 'text', text: '"raw"' }]);
  });
});
