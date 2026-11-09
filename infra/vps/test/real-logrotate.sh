#!/usr/bin/env bash
# The log retention edits and the one-time purge of harden.sh against the real logrotate, rsyslog,
# fail2ban and auditd of a throwaway Ubuntu 24.04 (the CI runner). It deletes logs under /var/log,
# so it refuses to run outside CI. test/run.sh only covers the purge with fake binaries.
#
#   sudo CI=true test/real-logrotate.sh [OLD_HARDEN]
#
# OLD_HARDEN: an older harden.sh. When its purge has no `su root adm`, it must fail here first.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ "${CI:-}" = true ] || { echo "CI only: this deletes files under /var/log" >&2; exit 1; }

die() { echo "harden.sh: $*" >&2; exit 1; }
fail() { echo "real-logrotate: $*" >&2; exit 1; }
marker=/var/lib/push/retention-14d-v2
live=(/var/log/syslog /var/log/fail2ban.log /var/log/wtmp /var/log/btmp)

echo "== /var/log is $(stat -c '%a %U:%G' /var/log)"
# What the rsyslog postinst does on noble, in case the runner image changed it.
chgrp syslog /var/log
chmod g+w /var/log
echo "== /var/log is $(stat -c '%a %U:%G' /var/log) (noble rsyslog postinst)"
systemctl is-active rsyslog fail2ban auditd || true
# Lines in the live files, and the files a purge must remove (dpkg.log.1 must stay).
logger -p auth.info "real-logrotate seed"
[ -e /var/log/btmp ] || install -m 0660 -o root -g utmp /dev/null /var/log/btmp
mkdir -p /var/log/audit
touch /var/log/{syslog.2.gz,auth.log.3.gz,kern.log.1,messages.1,fail2ban.log.4.gz,wtmp.1,btmp.1,dpkg.log.1} /var/log/audit/audit.log.2
sleep 1
ls -l /var/log /var/log/audit

eval "$(sed -n '/^for f in \/etc\/logrotate.d\/fail2ban /,/^done$/p' harden.sh)"
grep -HE '^\s*(su|daily|rotate|ifempty|notifempty|create)\b' /etc/logrotate.d/{rsyslog,fail2ban,wtmp,btmp}

if [ -n "${1:-}" ]; then
  if grep -q 'su root adm' "$1"; then
    echo "== $1 already passes su root adm; no failure to reproduce"
  else
    eval "$(sed -n '/^purge_pre_14d_logs() {$/,/^}$/p' "$1")"
    set +e
    (set -e; purge_pre_14d_logs "") >/tmp/old-purge.out 2>&1
    rc=$?
    set -e
    echo "== old purge exited $rc:"
    cat /tmp/old-purge.out
    [ "$rc" -ne 0 ] || fail "the old purge passed: the su fix is not needed here"
    grep -q 'insecure permissions' /tmp/old-purge.out || fail "the old purge failed for another reason"
    [ ! -e "$marker" ] || fail "the old purge wrote its marker"
  fi
fi

# A seed line in each live file: once its config rotated it, the line is only in the deleted .1.
seed="real-logrotate seed $RANDOM$RANDOM"
for f in "${live[@]}"; do echo "$seed" >>"$f"; done
eval "$(sed -n '/^purge_pre_14d_logs() {$/,/^}$/p' harden.sh)"
purge_pre_14d_logs ""
echo "== purge exited 0, marker $(cat "$marker")"
logger -p auth.info "real-logrotate after"
for _ in {1..20}; do [ -e /var/log/auth.log ] && [ -e /var/log/syslog ] && break; sleep 0.5; done
ls -l /var/log /var/log/audit
systemctl is-active rsyslog fail2ban auditd || true

# Every live file rotated, so the su in the first config reached all four configs after it.
for f in "${live[@]}"; do
  if grep -qaF "$seed" "$f"; then fail "$f was not rotated"; fi
  echo "== $f rotated"
done
left="$(shopt -s nullglob; echo /var/log/{syslog,kern.log,auth.log,mail.log,mail.info,mail.warn,mail.err,user.log,cron.log,daemon.log,debug,messages,lpr.log,fail2ban.log,wtmp,btmp}.[0-9]* /var/log/audit/audit.log.[0-9]*)"
[ -z "$left" ] || fail "rotated files left: $left"
[ -e /var/log/dpkg.log.1 ] || fail "deleted dpkg.log.1"
for f in /var/log/auth.log /var/log/fail2ban.log; do [ -e "$f" ] || fail "$f is gone"; done
if systemctl is-active --quiet auditd; then
  [ -e /var/log/audit/audit.log ] || fail "audit.log is gone"
else
  echo "== auditd is not active: the purge took the branch without USR1"
fi
[ "$(stat -c '%a %U:%G' /var/log/wtmp)" = "664 root:utmp" ] || fail "wtmp is $(stat -c '%a %U:%G' /var/log/wtmp)"
[ "$(stat -c '%a %U:%G' /var/log/btmp)" = "660 root:utmp" ] || fail "btmp is $(stat -c '%a %U:%G' /var/log/btmp)"
stat -c '%n %a %U:%G' /var/log/wtmp /var/log/btmp
echo "real logrotate purge passed"
