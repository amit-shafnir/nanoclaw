#!/bin/sh
set -eu

MANIFEST=/opt/nanoclaw/inner-images.txt
LOCK=/tmp/nanoclaw-seed-images.lock

[ -f "$MANIFEST" ] || exit 0

i=0
until docker info >/dev/null 2>&1; do
  sleep 1
  i=$((i+1))
  if [ "$i" -ge 60 ]; then
    echo "seed: Docker daemon not ready after 60s" >&2
    exit 1
  fi
done

seeded=1
while read -r ref tag; do
  [ -n "${ref:-}" ] || continue
  case "$ref" in \#*) continue ;; esac
  docker image inspect "${tag:-$ref}" >/dev/null 2>&1 || { seeded=0; break; }
done < "$MANIFEST"
[ "$seeded" -eq 1 ] && exit 0

if mkdir "$LOCK" 2>/dev/null; then
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
  echo "seed: pulling inner images" >&2
  status_dir="$(mktemp -d)"
  trap 'rm -rf "$status_dir"; rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
  n=0
  while read -r ref tag; do
    [ -n "${ref:-}" ] || continue
    case "$ref" in \#*) continue ;; esac
    tag="${tag:-$ref}"
    if docker image inspect "$tag" >/dev/null 2>&1; then
      continue
    fi
    n=$((n+1))
    (
      echo "seed: pulling $ref" >&2
      if docker pull "$ref" >&2; then
        : > "$status_dir/$n.ok"
      else
        echo "$ref" > "$status_dir/$n.fail"
      fi
    ) &
  done < "$MANIFEST"
  wait || true

  failed=0
  for fail in "$status_dir"/*.fail; do
    [ -e "$fail" ] || continue
    echo "seed: failed to pull $(cat "$fail")" >&2
    failed=1
  done
  [ "$failed" -eq 0 ] || exit 1

  while read -r ref tag; do
    [ -n "${ref:-}" ] || continue
    case "$ref" in \#*) continue ;; esac
    tag="${tag:-$ref}"
    docker image inspect "$tag" >/dev/null 2>&1 && continue
    [ "$ref" = "$tag" ] || docker tag "$ref" "$tag"
  done < "$MANIFEST"
  echo "seed: done" >&2
else
  echo "seed: waiting for image seed started by another process" >&2
  i=0
  while [ -d "$LOCK" ]; do
    sleep 2
    i=$((i+1))
    if [ "$i" -ge 300 ]; then
      echo "seed: timed out waiting for image seed" >&2
      exit 1
    fi
  done
fi
