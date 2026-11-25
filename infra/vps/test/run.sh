#!/usr/bin/env bash
# Static checks for infra/vps: shellcheck, the compose guard on the real file, and the
# guard against a fixture that must be rejected. Needs docker compose and jq; shellcheck
# runs when installed (CI has it).
set -euo pipefail
cd "$(dirname "$0")/.."

scripts=(harden.sh bin/check-compose bin/push-firewall bin/push-watchdog bin/push-deploy test/run.sh test/real-logrotate.sh)
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

# bin/service-healthy reads the table `push-deploy ps` prints and passes only when the named service's
# container is up and healthy. A container that exited is not in the table at all.
ps_table() {
  cat <<EOF
NAME                   IMAGE              COMMAND                  SERVICE      CREATED         STATUS                   PORTS
push-ai-dispatcher-1   push-bot:local     "python -m app.worke…"   dispatcher   2 minutes ago   Up 2 minutes (healthy)   8091/tcp
push-ai-push-bot-1     push-bot:local     "python -m push_bot.…"   push-bot     2 minutes ago   Up 2 minutes (healthy)   8080/tcp
$1
EOF
}
agent_row() { echo "push-ai-push-agent-1   push-agent:local   \"python -m push_agen…\"   push-agent   2 minutes ago   $1   8080/tcp"; }
staging_agent_row() {
  echo "push-ai-staging-staging-push-agent-1   push-agent:staging   \"python -m push_agen…\"   staging-push-agent   2 minutes ago   $1   8080/tcp"
}
up="Up 2 minutes (healthy)"
down=("Up 5 seconds (health: starting)" "Up 3 minutes (unhealthy)" "Restarting (1) 4 seconds ago")
ps_table "$(agent_row "$up")" | bin/service-healthy push-agent >/dev/null
ps_table "$(staging_agent_row "$up")" | bin/service-healthy staging-push-agent >/dev/null
for status in "${down[@]}"; do
  ! ps_table "$(agent_row "$status")" | bin/service-healthy push-agent >/dev/null 2>&1 \
    || { echo "service-healthy accepted push-agent while: $status" >&2; exit 1; }
done
# Neither a healthy push-bot nor the other stack's agent stands in for the service asked about.
! ps_table "" | bin/service-healthy push-agent >/dev/null 2>&1 \
  || { echo "service-healthy passed with no push-agent container" >&2; exit 1; }
! ps_table "$(staging_agent_row "$up")" | bin/service-healthy push-agent >/dev/null 2>&1 \
  || { echo "service-healthy took staging-push-agent for push-agent" >&2; exit 1; }

# The deploy step must not pass while push-agent is down. push-agent has no public host unless
# AGENT_HOST is set, and core queues company turns for it either way. This runs the step's own health
# phase from ci.yml against a stub VPS: every URL answers 200 and `ps` prints the given table.
health_phase="$(awk '
  /name: Deploy AI service to VPS/ { step = 1; next }
  step && /^      - name:/ { step = 0 }
  step && /^          urls=\(/ { phase = 1 }
  step && phase { sub(/^          /, ""); print }
' "$ci")"
[ -n "$health_phase" ] || { echo "ci.yml: the VPS deploy step has no health phase" >&2; exit 1; }
# No -u in the stub: macOS bash 3.2 rejects the step's empty "${stage_arg[@]}" under it; the runner's bash does not.
# shellcheck disable=SC2016
stub_vps='set -eo pipefail
ssh_vps() { [ "${*: -1}" != ps ] || printf "%s\n" "$PS_TABLE"; }
curl() { printf 200; }
sleep() { :; }
'
deploy_health() { # <stage> <AGENT_HOST> <ps table>
  local args="stage_arg=()"
  [ "$1" != staging ] || args="stage_arg=(staging)"
  (cd ../.. && STAGE="$1" AGENT_HOST="$2" PS_TABLE="$3" AI_HOST=bot.example DISPATCH_HOST=dispatch.example \
    bash -c "$stub_vps$args"$'\n'"$health_phase") >/dev/null 2>&1
}
deploy_health production "" "$(ps_table "$(agent_row "$up")")" \
  || { echo "the deploy health phase rejected a healthy production stack" >&2; exit 1; }
deploy_health staging "" "$(ps_table "$(staging_agent_row "$up")")" \
  || { echo "the deploy health phase rejected a healthy staging stack" >&2; exit 1; }
! deploy_health staging "" "$(ps_table "$(agent_row "$up")")" \
  || { echo "the staging deploy passed without staging-push-agent" >&2; exit 1; }
for host in "" agent.example; do
  for status in "${down[@]}"; do
    ! deploy_health production "$host" "$(ps_table "$(agent_row "$status")")" \
      || { echo "the deploy passed with push-agent '$status' (AGENT_HOST='$host')" >&2; exit 1; }
  done
  ! deploy_health production "$host" "$(ps_table "")" \
    || { echo "the deploy passed with no push-agent container (AGENT_HOST='$host')" >&2; exit 1; }
done

# The one-time purge in harden.sh: force-rotates the live IP-bearing logs (fake logrotate and
# systemctl below record their calls and leave the files a real rotation would), then drops every
# rotated file, keeps live files and other logs, writes no marker if a step fails, and does
# nothing once its marker exists. A rotation that never lands (no new audit.log.1 in time) stops it
# before the marker too, and an inactive auditd is not signalled.
die() { echo "harden.sh: $*" >&2; exit 1; }
eval "$(sed -n '/^purge_pre_14d_logs() {$/,/^}$/p' harden.sh)"
root="$(mktemp -d)"
fake="$(mktemp -d)"
trap 'rm -f "$env_file"; rm -rf "$root" "$fake"' EXIT
cat >"$fake/logrotate" <<'EOF'
#!/bin/sh
# $2 is the temporary global config: record its text and path, so the test can check both.
echo "logrotate $1 [$(cat "$2")] $3 $4" >>"$FAKE_ROOT/calls"
echo "$2" >"$FAKE_ROOT/su_conf"
[ -z "$FAKE_LOGROTATE_FAIL" ] || exit 1
touch "$FAKE_ROOT/var/log/auth.log.1" "$FAKE_ROOT/var/log/wtmp.1"
EOF
# Real auditd renames audit.log to .1 after the signal, so an old archive still on disk at USR1
# time would be indistinguishable from the new one.
cat >"$fake/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >>"$FAKE_ROOT/calls"
[ -z "$FAKE_AUDIT_INACTIVE" ] || [ "$1" != is-active ] || exit 3
[ "$1" = kill ] || exit 0
ls "$FAKE_ROOT"/var/log/audit/audit.log.[0-9]* >/dev/null 2>&1 && touch "$FAKE_ROOT/stale"
[ -n "$FAKE_AUDIT_NO_ROTATE" ] || touch "$FAKE_ROOT/var/log/audit/audit.log.1"
EOF
printf '#!/bin/sh\n' >"$fake/sleep"
chmod +x "$fake/logrotate" "$fake/systemctl" "$fake/sleep"
export FAKE_ROOT="$root"
PATH="$fake:$PATH"
mkdir -p "$root/var/log/audit" "$root/etc/logrotate.d"
touch "$root/etc/logrotate.d/rsyslog" "$root/etc/logrotate.d/wtmp"
for f in syslog syslog.1 kern.log kern.log.2.gz auth.log.4.gz wtmp wtmp.1 btmp.1 fail2ban.log.1 \
  daemon.log.1 debug.1 messages.2.gz mail.info.1 mail.warn.1 mail.err.1 lpr.log.1 \
  dpkg.log.1 audit/audit.log audit/audit.log.3; do
  touch "$root/var/log/$f"
done
fail() { echo "purge_pre_14d_logs: $*" >&2; exit 1; }
# A failed rotation stops the purge before the marker, so the next harden.sh run retries it.
set +e
(set -e; FAKE_LOGROTATE_FAIL=1 purge_pre_14d_logs "$root") 2>"$root/err"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "returned 0 after logrotate failed"
grep -q 'rerun harden.sh' "$root/err" || fail "no rerun hint: $(cat "$root/err")"
[ ! -e "$root/var/lib/push/retention-14d-v2" ] || fail "wrote its marker after logrotate failed"
[ -e "$root/var/log/kern.log.2.gz" ] || fail "deleted files after logrotate failed"
[ ! -e "$(cat "$root/su_conf")" ] || fail "left its su config behind after logrotate failed"
rm "$root/calls"
purge_pre_14d_logs "$root"
want="logrotate -f [su root adm] $root/etc/logrotate.d/rsyslog $root/etc/logrotate.d/wtmp
systemctl is-active --quiet auditd.service
systemctl kill --kill-whom=main --signal=USR1 auditd.service"
[ "$(cat "$root/calls")" = "$want" ] || fail "calls were: $(cat "$root/calls")"
[ ! -e "$(cat "$root/su_conf")" ] || fail "left its su config behind"
left="$(cd "$root/var/log" && find . -type f | sort | tr '\n' ' ')"
[ "$left" = "./audit/audit.log ./dpkg.log.1 ./kern.log ./syslog ./wtmp " ] || fail "left: $left"
[ -s "$root/var/lib/push/retention-14d-v2" ] || fail "wrote no marker"
[ ! -e "$root/stale" ] || fail "signalled auditd before deleting the old audit.log.N"
touch "$root/var/log/kern.log.1"
purge_pre_14d_logs "$root"
[ -e "$root/var/log/kern.log.1" ] || fail "ran again after its marker"
[ "$(cat "$root/calls")" = "$want" ] || fail "rotated again after its marker"

# No new audit.log.1 within the wait: stop before the marker, with the old archives already gone.
root="$(mktemp -d)"
export FAKE_ROOT="$root"
mkdir -p "$root/var/log/audit"
touch "$root/var/log/audit/audit.log.2"
set +e
(set -e; FAKE_AUDIT_NO_ROTATE=1 purge_pre_14d_logs "$root") 2>"$root/err"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "returned 0 though auditd never rotated"
grep -q 'rerun harden.sh' "$root/err" || fail "no rerun hint: $(cat "$root/err")"
[ ! -e "$root/var/lib/push/retention-14d-v2" ] || fail "wrote its marker though auditd never rotated"
rm -rf "$root"

# Inactive auditd: no signal, old archives still deleted.
root="$(mktemp -d)"
export FAKE_ROOT="$root"
mkdir -p "$root/var/log/audit"
touch "$root/var/log/audit/audit.log" "$root/var/log/audit/audit.log.2"
FAKE_AUDIT_INACTIVE=1 purge_pre_14d_logs "$root"
[ "$(cat "$root/calls")" = "systemctl is-active --quiet auditd.service" ] || fail "inactive calls: $(cat "$root/calls")"
[ "$(cd "$root/var/log" && find . -type f)" = "./audit/audit.log" ] || fail "inactive left files"
[ -s "$root/var/lib/push/retention-14d-v2" ] || fail "inactive: wrote no marker"
rm -rf "$root"
echo "infra/vps checks passed"
