/**
 * Container modules barrel.
 *
 * Each optional module self-registers at import time (poll-loop hooks via
 * src/hooks.ts, tool middleware via src/mcp-tools/server.ts). Imports here
 * must be registration-only side effects — no top-level work beyond pushing
 * into a registry.
 *
 * This barrel is imported by BOTH container entry points: the poll loop
 * (src/index.ts) and the MCP server (src/mcp-tools/index.ts), which run as
 * separate Bun processes. A module's registrations for the "wrong" process
 * are inert — nothing calls the corresponding run* there — so every module
 * registers everything unconditionally and stays safe in either process.
 *
 * Registration order = chain order for hooks and middleware.
 *
 * Modules installed via /add-<name> skills: append imports below.
 */
