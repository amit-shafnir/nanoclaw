## Companion and collaborator agents (`create_agent`)

`mcp__nanoclaw__create_agent({ name, instructions })` spins up a new long-lived agent and wires it as a destination — bidirectional, so you can send it tasks and it can message you back.

### How it works

- Creates a new agent with its own container, workspace, and session. Your `instructions` string seeds the agent's `CLAUDE.local.md` — its starting role and personality.
- The agent's `name` becomes a destination on both sides: you address it via `send_message({ to: "<name>", ... })`, and its replies arrive as inbound messages with `from="<name>"`.
- Each agent has its own persistent workspace under `groups/<folder>/` — memory, conversation history, and notes all survive across sessions. This is a full standalone agent, not a stateless sub-query.
- **Fire-and-forget:** the call returns immediately without waiting for the agent to confirm it's ready. Messages you send will queue until it's up.

### When to use

- **Companions** — a long-running presence that accumulates context over time: a `Researcher` tracking an ongoing inquiry, a `Calendar` agent managing scheduling, an assistant that knows your preferences and history.
- **Collaborators** — a parallel specialist that works independently and reports back: a `Builder` handling code edits while you stay in conversation, a `Reviewer` running checks in the background.

The right frame is: does this agent need its own memory and context that builds over time, or does it need to work independently without blocking your turn? Either is a good reason to spawn one.

### When NOT to use

- **One-off lookups or short tasks** — use the SDK `Agent` tool instead. It's stateless, spins up and completes in one shot, and leaves no persistent footprint.
- **Work that finishes before the user's next message** — agents persist indefinitely. Don't create one for something you could do inline.

### Writing good `instructions`

Cover: the agent's role, who it takes tasks from (you, by name), how it should report back (on completion only? with milestones for long work?), and any domain-specific rules. Don't restate NanoClaw base behavior — the shared base is already loaded on the agent's end.

### Creating a teammate on a different AI (`provider`)

Pass `provider` (e.g. `"codex"`, `"opencode"`) to run the new agent on a different AI than you. Omit it and the teammate inherits yours.

You don't get to know the outcome when you make the request — the host decides and replies with a follow-up: the agent is created right away, an admin needs to approve it first, or the provider isn't installed and an admin has to enable it. The three paths look different to different callers, so **don't predict which one applies**. In particular, don't tell the user "request submitted, it'll spin up" or "this needs approval" — you don't know that yet, and promising approval that never happens is misleading.

So: a new cross-provider teammate is a real action — confirm with the user before requesting. Make the request. Then **relay the system's follow-up message** as the actual result. If it says the provider isn't installed, tell the user an admin needs to enable it first — in plain terms ("an admin would need to set up Codex first"), not "run `/add-codex`."