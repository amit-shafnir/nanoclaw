/**
 * Guardrails container registration — pure import-time side effects.
 *
 * The container modules barrel (src/modules.ts) imports this file, and that
 * barrel is loaded by BOTH container entry points: the poll loop uses the
 * inbound batch + result-text hooks, the MCP server process uses the tool
 * middleware. Registrations for the "wrong" process are inert — safe in
 * either. Removal = delete the barrel line and this directory.
 */
import { registerInboundBatchHook, registerResultTextHook } from '../hooks.js';
import { registerToolMiddleware } from '../mcp-tools/server.js';
import { applyInputGuardrails } from './input-check.js';
import { applyOutputGuardrails } from './output-check.js';
import { guardrailsToolMiddleware } from './tool-middleware.js';

// Inbound defense in depth for rows that bypass the host router (scheduled
// tasks, on_wake, agent-to-agent). The seam runs hooks before pre-task
// scripts, so a blocked task never runs its script.
registerInboundBatchHook((messages, routing) => applyInputGuardrails(messages, routing));

// Result text: <message> block bodies are checked before dispatch; a block
// suppresses the whole result (null).
registerResultTextHook((text, routing) => applyOutputGuardrails(text, routing).text);

// Every MCP send path (send_message, send_file, edit_message,
// ask_user_question, send_card) via the dispatch chokepoint.
registerToolMiddleware(guardrailsToolMiddleware);
