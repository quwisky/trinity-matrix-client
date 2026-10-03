#!/usr/bin/env bash
# Native Synapse (SQLite) on :8008 behind Caddy TLS on :8448. Throwaway spike for #863.
set -euo pipefail
OUT=$1
D="$RUNNER_TEMP/synapse"
mkdir -p "$D"
t0=$(date +%s)
python3 -m venv "$D/venv"
"$D/venv/bin/pip" install -q matrix-synapse
t1=$(date +%s)
"$D/venv/bin/python" -m synapse.app.homeserver --server-name localhost \
  --config-path "$D/homeserver.yaml" --data-directory "$D" --generate-config --report-stats=no
sed -i '' 's/^registration_shared_secret:.*$/registration_shared_secret: "trinity-e2e-shared-secret"/' "$D/homeserver.yaml"
"$D/venv/bin/python" -m synapse.app.homeserver -c "$D/homeserver.yaml" --daemonize
for _ in $(seq 60); do curl -fsS http://localhost:8008/_matrix/client/versions >/dev/null && break; sleep 1; done
t2=$(date +%s)
brew install caddy >/dev/null
caddy start --config "$GITHUB_WORKSPACE/spike/863/Caddyfile" --adapter caddyfile
for _ in $(seq 30); do curl -fsSk https://localhost:8448/_matrix/client/versions >/dev/null && break; sleep 1; done
t3=$(date +%s)
{
  echo "synapse_install_s=$((t1 - t0))"
  echo "synapse_ready_s=$((t2 - t1))"
  echo "caddy_ready_s=$((t3 - t2))"
  echo "synapse_$("$D/venv/bin/pip" show matrix-synapse | grep ^Version)"
  echo "caddy_version=$(caddy version)"
  echo "tls_from_host=$(curl -fsSk https://localhost:8448/_matrix/client/versions | head -c 120)"
} | tee "$OUT/homeserver.txt"
cp "$HOME/Library/Application Support/Caddy/pki/authorities/local/root.crt" "$OUT/caddy-root.crt"
