import { ClaudeProvider } from './claude.js';
import { findByName } from '../destinations.js';
import { registerProvider } from './provider-registry.js';
import type { AgentQuery, ProviderOptions, QueryInput } from './types.js';

export function withOllamaModelIdentity(input: QueryInput, sourceModel: string): QueryInput {
  const identity = `You are running through the local Ollama client with source model ${JSON.stringify(sourceModel)}. Report this source model, never the internal nanoclaw/* runtime alias.`;
  const instructions = [input.systemContext?.instructions, identity].filter(Boolean).join('\n\n');
  return { ...input, systemContext: { ...input.systemContext, instructions } };
}

export function resolveOllamaRuntimeModel(options: ProviderOptions): string | undefined {
  return options.env?.NANOCLAW_OLLAMA_RUNTIME_MODEL || options.model;
}

class OllamaProvider extends ClaudeProvider {
  readonly emitsMidTurnText = false;
  private readonly sourceModel?: string;

  constructor(options: ProviderOptions) {
    super({
      ...options,
      model: resolveOllamaRuntimeModel(options),
      // WebFetch's advisory domain-safety preflight calls api.anthropic.com, which this provider's cloud block
      // makes unreachable. Skipping only that check keeps the tool usable: the fetch itself is client-side and the
      // summarization pass runs against the local daemon.
      settings: { skipWebFetchPreflight: true },
    });
    this.sourceModel = options.model;
  }

  /** Finish the turn after a handoff the agent cannot observe the result of. */
  protected shouldStopAfterTool(toolName: string, toolInput: Record<string, unknown>): boolean {
    if (toolName === 'mcp__nanoclaw__create_agent') return true;
    if (toolName !== 'mcp__nanoclaw__send_message') return false;
    const to = toolInput.to;
    return typeof to === 'string' && findByName(to)?.type === 'agent';
  }

  override query(input: QueryInput): AgentQuery {
    return super.query(this.sourceModel ? withOllamaModelIdentity(input, this.sourceModel) : input);
  }
}

registerProvider('ollama', (options) => new OllamaProvider(options));
