# NanoClaw sbx kit

Boots NanoClaw inside a Docker Sandbox micro-VM from a pre-baked host image. The
image contains a clean upstream NanoClaw checkout, `node_modules`, compiled
`dist`, and the OneCLI CLI. First boot only seeds the inner Docker daemon, starts
OneCLI/Postgres, starts NanoClaw, and enters setup.

Nothing here patches NanoClaw source. The image clones `nanocoai/nanoclaw` at
build time from `NANOCLAW_REF`.

## One-time prerequisites

```console
$ sbx --version
$ sbx login
```

NanoClaw credentials are configured through OneCLI during setup.

## Build the images

```console
# Optional: build and push the nested agent image used by NanoClaw sessions.
$ AGENT_IMAGE=docker.io/<you>/nanoclaw-agent:dev TARGET=agent ./scripts/build-image.sh

# Build the host sandbox image and load it into sbx's template store.
$ IMAGE=nanoclaw-sbx:local AGENT_IMAGE=docker.io/<you>/nanoclaw-agent:dev TARGET=sbx ./scripts/build-image.sh
$ docker save nanoclaw-sbx:local -o /tmp/nanoclaw-sbx.tar && sbx template load /tmp/nanoclaw-sbx.tar
```

`AGENT_IMAGE` must be pullable from inside the sandbox. It is tagged inside the
sandbox as `nanoclaw-agent:latest`. Override `NANOCLAW_REF`, `AGENT_IMAGE`,
`ONECLI_IMAGE`, or `POSTGRES_IMAGE` when needed.

## Boot

```console
$ sbx run -m 12g --cpus 6 --kit ./sbx-kit nanoclaw
```

## Smoke checks

- `node dist/index.js` is up and `data/cli.sock` exists.
- OneCLI health: `curl -sf http://127.0.0.1:10254/api/health`.
- `docker images` inside the VM shows the seeded agent image (and OneCLI stack).
- A real CLI chat returns a reply.

## Publish

For public distribution, build and push the host image and nested agent image,
update `spec.yaml` to point at the published host image, then publish the kit as
an OCI artifact with `sbx kit push`.
