/**
 * Seam tests for the tool-call middleware chain in server.ts: no middleware
 * = direct handler dispatch, registration order = chain order (first
 * registered outermost), and a middleware that doesn't call next() owns the
 * result (the handler never runs).
 *
 * bun:test cannot reset module state, so the no-middleware test runs first
 * (declaration order) and middlewares registered later pass through for any
 * tool name they don't target.
 */
import { describe, expect, it } from 'bun:test';

import { dispatchToolCall, registerToolMiddleware, registerTools } from './server.js';

function fakeTool(name: string, calls: string[]) {
  return {
    tool: { name, description: name, inputSchema: { type: 'object' as const } },
    async handler(args: Record<string, unknown>) {
      calls.push(name);
      return { content: [{ type: 'text' as const, text: JSON.stringify(args) }] };
    },
  };
}

describe('dispatchToolCall', () => {
  it('dispatches straight to the handler with no middleware', async () => {
    const calls: string[] = [];
    registerTools([fakeTool('seam_echo', calls)]);
    const result = await dispatchToolCall('seam_echo', { x: 1 });
    expect(result.content).toEqual([{ type: 'text', text: '{"x":1}' }]);
    expect(calls).toEqual(['seam_echo']);
  });

  it('reports unknown tools', async () => {
    const result = await dispatchToolCall('seam_missing', {});
    expect(result.content).toEqual([{ type: 'text', text: 'Unknown tool: seam_missing' }]);
  });

  it('runs middleware around the handler, first registered outermost', async () => {
    const calls: string[] = [];
    registerTools([fakeTool('seam_chained', calls)]);
    registerToolMiddleware(async (name, _args, next) => {
      if (name !== 'seam_chained') return next();
      calls.push('outer:before');
      const result = await next();
      calls.push('outer:after');
      return result;
    });
    registerToolMiddleware(async (name, _args, next) => {
      if (name !== 'seam_chained') return next();
      calls.push('inner:before');
      return next();
    });

    await dispatchToolCall('seam_chained', {});
    expect(calls).toEqual(['outer:before', 'inner:before', 'seam_chained', 'outer:after']);
  });

  it('lets a middleware own the result without calling next()', async () => {
    const calls: string[] = [];
    registerTools([fakeTool('seam_blocked', calls)]);
    registerToolMiddleware(async (name, _args, next) => {
      if (name !== 'seam_blocked') return next();
      return { content: [{ type: 'text' as const, text: 'Error: refused' }], isError: true };
    });

    const result = await dispatchToolCall('seam_blocked', {});
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
