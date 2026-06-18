#!/bin/sh
set -eu

sudo -n chmod 666 /var/run/docker.sock 2>/dev/null || true

/usr/local/bin/nanoclaw-seed-images || exit 1

export PATH="$HOME/.local/bin:$PATH"
export ONECLI_BIND_HOST="${ONECLI_BIND_HOST:-0.0.0.0}"
export TZ="${TZ:-UTC}"
ONECLI_URL="${ONECLI_URL:-http://127.0.0.1:10254}"
ONECLI_VERSION="${ONECLI_VERSION:-1.36.0}"

if ! curl -sf "$ONECLI_URL/api/health" >/dev/null 2>&1; then
  echo "entrypoint: starting OneCLI gateway" >&2
  ONECLI_INSTALL_VERSION="$ONECLI_VERSION" sh -c "$(curl -fsSL https://onecli.sh/install)" \
    >/tmp/onecli-install.log 2>&1

  i=0
  until curl -sf "$ONECLI_URL/api/health" >/dev/null 2>&1; do
    sleep 1
    i=$((i+1))
    if [ "$i" -ge 90 ]; then
      echo "entrypoint: timed out waiting for OneCLI gateway" >&2
      cat /tmp/onecli-install.log >&2 || true
      exit 1
    fi
  done
fi

onecli config set api-host "$ONECLI_URL" >/dev/null 2>&1 || true

cd /home/agent/nanoclaw
mkdir -p logs data

stop_nanoclaw() {
  if [ -f nanoclaw.pid ]; then
    pid="$(cat nanoclaw.pid 2>/dev/null || true)"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  fi
  exit 0
}
trap stop_nanoclaw INT TERM

cat > "$HOME/.local/bin/systemctl" <<'EOF'
#!/bin/sh
case " $* " in
  *" restart "*)
    pid_file=/tmp/nanoclaw-service.pid
    project_pid_file=/home/agent/nanoclaw/nanoclaw.pid
    if [ -f "$pid_file" ]; then
      kill "$(cat "$pid_file")" 2>/dev/null || true
      rm -f "$pid_file"
    fi
    if [ -f "$project_pid_file" ]; then
      kill "$(cat "$project_pid_file")" 2>/dev/null || true
      rm -f "$project_pid_file"
    fi
    rm -f /home/agent/nanoclaw/data/cli.sock
    cd /home/agent/nanoclaw
    node dist/index.js > logs/nanoclaw.log 2>&1 &
    echo "$!" > "$pid_file"
    echo "$!" > "$project_pid_file"
    i=0
    until [ -S data/cli.sock ]; do
      sleep 1
      i=$((i+1))
      [ "$i" -lt 60 ] || exit 1
    done
    exit 0
    ;;
esac
exec /usr/bin/systemctl "$@"
EOF
chmod 0755 "$HOME/.local/bin/systemctl"

if [ ! -S data/cli.sock ]; then
  node dist/index.js > logs/nanoclaw.log 2>&1 &
  echo "$!" > /tmp/nanoclaw-service.pid
  echo "$!" > nanoclaw.pid
fi

i=0
until [ -S data/cli.sock ]; do
  sleep 1
  i=$((i+1))
  if [ "$i" -ge 60 ]; then
    echo "entrypoint: host never opened data/cli.sock" >&2
    tail -n 80 logs/nanoclaw.log >&2 || true
    exit 1
  fi
done

set +e
env \
  NANOCLAW_SKIP="${NANOCLAW_SKIP:-service,container,timezone}" \
  NANOCLAW_ONECLI_API_HOST="$ONECLI_URL" \
  pnpm run --silent setup:auto
setup_status=$?
set -e

if [ "$setup_status" -ne 0 ]; then
  exit "$setup_status"
fi

while :; do
  if [ -f nanoclaw.pid ]; then
    pid="$(cat nanoclaw.pid 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      sleep 5
      continue
    fi
  fi
  echo "entrypoint: NanoClaw service exited" >&2
  tail -n 80 logs/nanoclaw.log >&2 || true
  exit 1
done
