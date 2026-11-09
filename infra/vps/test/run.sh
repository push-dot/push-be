#!/usr/bin/env bash
# Static checks for infra/vps: shellcheck, the compose guard on the real file, and the
# guard against a fixture that must be rejected. Needs docker compose and jq; shellcheck
# runs when installed (CI has it).
set -euo pipefail
cd "$(dirname "$0")/.."

scripts=(harden.sh bin/check-compose bin/push-firewall bin/push-watchdog bin/push-deploy test/run.sh)
for s in "${scripts[@]}"; do bash -n "$s"; done
if command -v shellcheck >/dev/null; then
  shellcheck -x "${scripts[@]}"
else
  echo "shellcheck not installed; skipped" >&2
fi

env_file="$(mktemp)"
trap 'rm -f "$env_file"' EXIT
for k in DATABASE_URL REDIS_PASSWORD AI_SHARED_SECRET DISPATCH_SECRET ADMIN_TOKEN; do
  echo "$k=placeholder" >>"$env_file"
done
printf 'AI_HOST=ai.example.com\nDISPATCH_HOST=dispatch.example.com\n' >>"$env_file"

docker compose --env-file "$env_file" -f compose.yaml config --quiet
docker compose --env-file "$env_file" --profile rerank -f compose.yaml config --format json | bin/check-compose
docker compose --env-file "$env_file" -f compose.staging.yaml config --format json | bin/check-compose

out="$(docker compose -f test/bad-compose.yaml config --format json | bin/check-compose 2>&1)" && {
  echo "check-compose accepted test/bad-compose.yaml" >&2
  exit 1
}
for want in "docker.sock" "Dokploy" "priv: privileged" "hostnet: network_mode=host" "exposed: publishes port" \
  "sock: runs as root" "rootuser: runs as root" "read_only" "apisock: use_api_socket" "priv: image busybox is not pinned" \
  "volume hostroot: driver_opts" "network hostnet: host network" "buildhost: build.network=host" "buildhost: build.privileged"; do
  grep -qF "$want" <<<"$out" || { echo "check-compose missed: $want" >&2; echo "$out" >&2; exit 1; }
done
# Container egress must use goto so allowed traffic (DNS, HTTPS) is not dropped by DOCKER-USER.
grep -q -- "-i docker0 -g PUSH-DOCKER-EGRESS" bin/push-firewall || { echo "push-firewall: DOCKER-USER must goto PUSH-DOCKER-EGRESS" >&2; exit 1; }
ci="$(cd ../.. && pwd)/.github/workflows/ci.yml"
python_worker="$(grep -E 'bundle-ai|pywrangler|push-be-python' "$ci" || true)"
if [ -n "$python_worker" ]; then
  echo "ci.yml still deploys the python worker" >&2
  printf '%s\n' "$python_worker" >&2
  exit 1
fi
if awk '
  /name: Deploy AI service to VPS/ { step = 1; next }
  step && /^      - name:/ { step = 0 }
  step && /if: needs\.changes\.outputs\.vps/ { found = 1 }
  END { exit found ? 0 : 1 }
' "$ci"; then
  echo "VPS deploy is still skipped unless the vps filter matches" >&2
  exit 1
fi

# The one-time purge in harden.sh: drops archives of the IP-bearing logs, keeps live files and
# other logs, and does nothing once its marker exists.
eval "$(sed -n '/^purge_pre_14d_logs() {$/,/^}$/p' harden.sh)"
root="$(mktemp -d)"
trap 'rm -f "$env_file"; rm -rf "$root"' EXIT
mkdir -p "$root/var/log/audit"
for f in syslog syslog.1 kern.log kern.log.2.gz auth.log.4.gz wtmp wtmp.1 btmp.1 fail2ban.log.1 \
  dpkg.log.1 audit/audit.log audit/audit.log.3; do
  touch "$root/var/log/$f"
done
purge_pre_14d_logs "$root"
left="$(cd "$root/var/log" && find . -type f | sort | tr '\n' ' ')"
[ "$left" = "./audit/audit.log ./dpkg.log.1 ./kern.log ./syslog ./wtmp " ] \
  || { echo "purge_pre_14d_logs left: $left" >&2; exit 1; }
[ -s "$root/var/lib/push/retention-14d-v1" ] || { echo "purge_pre_14d_logs wrote no marker" >&2; exit 1; }
touch "$root/var/log/kern.log.1"
purge_pre_14d_logs "$root"
[ -e "$root/var/log/kern.log.1" ] || { echo "purge_pre_14d_logs ran again after its marker" >&2; exit 1; }
echo "infra/vps checks passed"

