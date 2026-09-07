# Ollama NanoClaw final E2E

This worktree is an isolated, first-run user fixture for the reviewed Ollama
NanoClaw integration. It does not preselect a model.

## Run

1. Make sure Docker Desktop says **Running** and Ollama.app is installed with at
   least one local model.
2. Run `./run.sh`.
3. Choose the model and browsing option in the real `ollama launch nanoclaw`
   flow.

The script uses a short `/private/tmp` home to avoid macOS socket-length
failures, exposes Docker buildx inside that isolated home, and starts the
reviewed Ollama server on `127.0.0.1:11436` and serves the chat on port 3211, so
it coexists with other fixtures on this machine. The normal Ollama Desktop daemon
on 11434 is not replaced.

## Suggested checks

- Welcome appears automatically.
- Repeat a simple prompt; the warm turn should be much faster than the first
  cold prompt.
- Create an agent and confirm it appears in the sidebar.
- Chat directly with the child and confirm it answers the browser user.
- Ask the parent to give the child a task and relay the result exactly once.
- Use Ollama Web Search and Web Fetch.
- Ask the parent to delete a child with `ncl groups delete --id ...`; approve
  the card and confirm the child disappears.
- Use the sidebar delete button; cancel once, then confirm deletion.

The first prompt in a new agent evaluates the full Claude Code instruction/tool
prefix and is expected to be slower. Warm turns reuse the local prefix cache.

## Reset

Run `./reset.sh` to uninstall this NanoClaw copy, remove its isolated user data,
and stop the worktree-owned Ollama test server. Then `./run.sh` starts from the
beginning again.
