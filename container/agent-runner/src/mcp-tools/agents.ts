/**
 * Agent management MCP tools: create_agent.
 *
 * send_to_agent was removed — sending to another agent is now just
 * send_message(to="agent-name") since agents and channels share the
 * unified destinations namespace.
 *
 * create_agent writes central-DB state. The host authorizes it by CLI scope:
 * trusted owner agent groups (scope 'global') create directly; confined groups
 * require admin approval (see src/modules/agent-to-agent/create-agent.ts). This
 * tool just writes the outbound request; authorization is enforced host-side,
 * not here — the container is untrusted and cannot be relied on to gate itself.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const createAgent: McpToolDefinition = {
  tool: {
    name: 'create_agent',
    description:
      'Create a long-lived companion sub-agent (research assistant, task manager, specialist) — the name becomes your destination for it. May require admin approval before the agent is created. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable name (also becomes your destination name for this agent)',
        },
        instructions: {
          type: 'string',
          description: 'CLAUDE.md content for the new agent (personality, role, instructions)',
        },
        provider: {
          type: 'string',
          description:
            'Optional. Run the new agent on a different AI provider (e.g. "codex", "opencode") instead of inheriting yours. Cross-provider creation ALWAYS needs human approval, and the provider must already be installed on the host. Omit to inherit your own provider.',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!name) return err('name is required');

    const provider = typeof args.provider === 'string' && args.provider.trim() ? args.provider.trim() : undefined;
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_agent',
        requestId,
        name,
        instructions: (args.instructions as string) || null,
        ...(provider ? { provider } : {}),
      }),
    });

    log(`create_agent: ${requestId} → "${name}"${provider ? ` (${provider})` : ''}`);
    // For a cross-provider request the host decides the outcome (create now /
    // needs approval / provider not installed) and replies with a follow-up.
    // Don't let the agent assert an outcome here — it doesn't know which path
    // applies and "may need approval" reads as misleading when it doesn't.
    return ok(
      provider
        ? `Requested agent "${name}" on ${provider}. The system will follow up with the actual result — relay that; don't promise it's created or claim it needs approval.`
        : `Creating agent "${name}". You will be notified when it is ready.`,
    );
  },
};

registerTools([createAgent]);
