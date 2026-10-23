#!/usr/bin/env bash
# One-time (and safe to re-run) bootstrap for a fresh Ubuntu 24.04 VPS. Run as root:
#
#   bash harden.sh [--deploy-key KEY|FILE]... [--admin-key KEY|FILE]...
#
# --deploy-key  CI key. Pinned to /usr/local/bin/push-deploy: no shell, no forwarding.
#               Default: keys/push-deploy.pub next to this script.
# --admin-key   Your own key for an interactive shell as `deploy`. Optional; without it
#               the only interactive way in is the Hostinger browser console.
# DEPLOY_PUBKEYS / ADMIN_PUBKEYS (newline-separated) work as well as the flags.
# Only public keys are accepted. Re-running replaces the key list, so it is also how
# keys are rotated or revoked.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_USER=deploy
APP_ROOT=/opt/push-be
export DEBIAN_FRONTEND=noninteractive

log() { printf '\n==> %s\n' "$*"; }
die() {
  echo "harden.sh: $*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || die "run as root"
# shellcheck source=/dev/null
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "Ubuntu only (found ${ID:-unknown})"

deploy_keys=()
admin_keys=()
# add_key <array> <KEY|FILE>
add_key() {
  local -n into="$1"
  local line
  if [ -f "$2" ]; then
    grep -q 'PRIVATE KEY' "$2" && die "$2 is a private key; pass the .pub file"
    while IFS= read -r line; do [ -n "$line" ] && into+=("$line"); done <"$2"
  else
    into+=("$2")
  fi
}
while [ $# -gt 0 ]; do
  case "$1" in
    --deploy-key) add_key deploy_keys "${2:?--deploy-key needs a value}"; shift 2 ;;
    --admin-key) add_key admin_keys "${2:?--admin-key needs a value}"; shift 2 ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
while IFS= read -r k; do [ -n "$k" ] && deploy_keys+=("$k"); done <<<"${DEPLOY_PUBKEYS:-}"
while IFS= read -r k; do [ -n "$k" ] && admin_keys+=("$k"); done <<<"${ADMIN_PUBKEYS:-}"
if [ "${#deploy_keys[@]}" = 0 ] && [ -f "$HERE/keys/push-deploy.pub" ]; then
  add_key deploy_keys "$HERE/keys/push-deploy.pub"
fi
[ "${#deploy_keys[@]}" -gt 0 ] || die "no deploy key; pass --deploy-key"

valid_key() {
  [[ "$1" =~ ^(ssh-ed25519|sk-ssh-ed25519@openssh.com|ecdsa-sha2-nistp(256|384|521)|sk-ecdsa-sha2-nistp256@openssh.com|ssh-rsa)\ [A-Za-z0-9+/=]+(\ .*)?$ ]] \
    && ssh-keygen -l -f /dev/stdin <<<"$1" >/dev/null 2>&1
}
for k in "${deploy_keys[@]}" "${admin_keys[@]}"; do
  valid_key "$k" || die "not an SSH public key: ${k:0:40}..."
done

# ---------------------------------------------------------------- packages
log "packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg jq iptables conntrack fail2ban python3-systemd \
  auditd unattended-upgrades apt-listchanges needrestart

# ---------------------------------------------------------------- firewall (before Docker starts containers)
log "firewall"
if command -v ufw >/dev/null; then ufw --force disable >/dev/null || true; fi
install -m 0755 "$HERE/bin/push-firewall" /usr/local/sbin/push-firewall
cat >/etc/systemd/system/push-firewall.service <<'EOF'
[Unit]
Description=Push host and container firewall
DefaultDependencies=no
Wants=network-pre.target
Before=network-pre.target docker.service
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/push-firewall

[Install]
WantedBy=multi-user.target
EOF
mkdir -p /etc/systemd/system/docker.service.d
# Docker must never start without the egress rules in DOCKER-USER.
cat >/etc/systemd/system/docker.service.d/10-push-firewall.conf <<'EOF'
[Unit]
Requires=push-firewall.service
After=push-firewall.service
EOF
systemctl daemon-reload
systemctl enable push-firewall.service >/dev/null
/usr/local/sbin/push-firewall

# ---------------------------------------------------------------- docker daemon
log "docker daemon"
install -d -m 0755 /etc/docker
daemon_json="$(mktemp)"
cat >"$daemon_json" <<'EOF'
{
  "no-new-privileges": true,
  "live-restore": true,
  "icc": false,
  "userland-proxy": false,
  "default-address-pools": [{ "base": "172.30.0.0/16", "size": 24 }],
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
EOF
# Written before the first install so Docker never starts with the default address pools.
daemon_changed=0
if ! cmp -s "$daemon_json" /etc/docker/daemon.json; then
  install -m 0644 "$daemon_json" /etc/docker/daemon.json
  daemon_changed=1
fi
rm -f "$daemon_json"

if ! command -v docker >/dev/null || ! [ -f /etc/apt/sources.list.d/docker.list ]; then
  log "docker (official repository)"
  for pkg in docker.io docker-doc docker-compose podman-docker containerd runc; do
    apt-get remove -y -q "$pkg" >/dev/null 2>&1 || true
  done
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod 0644 /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
fi
apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker >/dev/null
if [ "$daemon_changed" = 1 ]; then systemctl restart docker; fi

# ---------------------------------------------------------------- deploy user
log "user $DEPLOY_USER"
id "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group "$DEPLOY_USER"
# docker is root-equivalent; that is why the CI key is pinned to push-deploy.
usermod -aG docker,systemd-journal "$DEPLOY_USER"
usermod -p '*' "$DEPLOY_USER" # no password; key login only
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 "$APP_ROOT" "$APP_ROOT/releases"
install -d -m 0755 /usr/local/lib/push
install -m 0755 "$HERE/bin/check-compose" /usr/local/lib/push/check-compose
install -m 0755 "$HERE/bin/push-deploy" /usr/local/bin/push-deploy

# Root-owned key file outside $HOME, so a shell as deploy cannot add keys.
install -d -m 0755 /etc/ssh/authorized_keys
keys_tmp="$(mktemp)"
{
  echo "# Managed by infra/vps/harden.sh. Re-run it to change keys."
  for k in "${deploy_keys[@]}"; do echo "restrict,command=\"/usr/local/bin/push-deploy\" $k"; done
  for k in "${admin_keys[@]}"; do echo "restrict,pty $k"; done
} >"$keys_tmp"
install -m 0644 "$keys_tmp" "/etc/ssh/authorized_keys/$DEPLOY_USER"
rm -f "$keys_tmp"

# ---------------------------------------------------------------- sshd
log "sshd"
# Keep only algorithms this OpenSSH build supports, or sshd refuses to start.
supported() {
  local kind="$1" want="$2" out="" a
  for a in ${want//,/ }; do
    if ssh -Q "$kind" | grep -qx "$a"; then out="${out:+$out,}$a"; fi
  done
  printf '%s' "$out"
}
kex="$(supported kex mlkem768x25519-sha256,sntrup761x25519-sha512,sntrup761x25519-sha512@openssh.com,curve25519-sha256,curve25519-sha256@libssh.org)"
ciphers="$(supported cipher chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com)"
macs="$(supported mac hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com,umac-128-etm@openssh.com)"
[ -f /etc/ssh/ssh_host_ed25519_key ] || ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
sshd_conf=/etc/ssh/sshd_config.d/00-push-hardening.conf
sshd_prev="$(mktemp)"
[ -f "$sshd_conf" ] && cp "$sshd_conf" "$sshd_prev"
# 00- sorts before cloud-init's 50- file; sshd keeps the first value it reads.
cat >"$sshd_conf" <<EOF
# Managed by infra/vps/harden.sh
HostKey /etc/ssh/ssh_host_ed25519_key
HostKeyAlgorithms ssh-ed25519
PermitRootLogin no
AllowUsers $DEPLOY_USER
AuthorizedKeysFile /etc/ssh/authorized_keys/%u
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
HostbasedAuthentication no
PermitUserEnvironment no
MaxAuthTries 3
MaxStartups 10:30:60
LoginGraceTime 20
ClientAliveInterval 300
ClientAliveCountMax 2
DisableForwarding yes
AllowAgentForwarding no
AllowTcpForwarding no
AllowStreamLocalForwarding no
X11Forwarding no
PermitTunnel no
GatewayPorts no
LogLevel VERBOSE
KexAlgorithms $kex
Ciphers $ciphers
MACs $macs
EOF
chmod 0644 "$sshd_conf"
if ! sshd -t; then
  if [ -s "$sshd_prev" ]; then cp "$sshd_prev" "$sshd_conf"; else rm -f "$sshd_conf"; fi
  die "sshd rejected the new config; previous config restored"
fi
rm -f "$sshd_prev"
systemctl restart ssh

# ---------------------------------------------------------------- kernel
log "sysctl"
cat >/etc/sysctl.d/99-push-hardening.conf <<'EOF'
# Managed by infra/vps/harden.sh
net.ipv4.ip_forward = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.default.log_martians = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_rfc1337 = 1
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_source_route = 0
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.yama.ptrace_scope = 2
kernel.unprivileged_bpf_disabled = 1
net.core.bpf_jit_harden = 2
kernel.kexec_load_disabled = 1
kernel.perf_event_paranoid = 3
kernel.sysrq = 0
kernel.randomize_va_space = 2
dev.tty.ldisc_autoload = 0
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2
fs.suid_dumpable = 0
EOF
sysctl --system >/dev/null

# Nothing legitimate executes from /dev/shm on this host (containers have their own).
if ! grep -qE '^\S+\s+/dev/shm\s' /etc/fstab; then
  echo 'tmpfs /dev/shm tmpfs defaults,nosuid,nodev,noexec 0 0' >>/etc/fstab
fi
mount -o remount,nosuid,nodev,noexec /dev/shm

# ---------------------------------------------------------------- fail2ban
log "fail2ban"
cat >/etc/fail2ban/jail.d/push.local <<'EOF'
# Managed by infra/vps/harden.sh
# The proxy has no jail: its callers are Cloudflare Workers, and banning a shared
# Cloudflare egress IP on 4xx would take production down. Traefik rate-limits instead.
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1
banaction = iptables-multiport
banaction_allports = iptables-allports

[sshd]
enabled = true
backend = systemd
mode = aggressive
maxretry = 3
findtime = 10m
bantime = 1h
bantime.increment = true
bantime.maxtime = 1w

[recidive]
enabled = true
bantime = 1w
findtime = 1d
EOF
systemctl enable fail2ban >/dev/null
systemctl restart fail2ban

# ---------------------------------------------------------------- auditd
log "auditd"
{
  echo "# Managed by infra/vps/harden.sh. Search: ausearch -k push-<key>"
  echo "-w /etc/systemd -p wa -k push-systemd"
  echo "-w /usr/lib/systemd/system -p wa -k push-systemd"
  for d in /etc/crontab /etc/cron.d /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly /var/spool/cron; do
    [ -e "$d" ] && echo "-w $d -p wa -k push-cron"
  done
  echo "-w /etc/ssh -p wa -k push-ssh"
  echo "-w /root/.ssh -p wa -k push-ssh"
  for h in /home/*; do [ -d "$h" ] && echo "-w $h/.ssh -p wa -k push-ssh"; done
  echo "-w /etc/passwd -p wa -k push-identity"
  echo "-w /etc/shadow -p wa -k push-identity"
  echo "-w /etc/group -p wa -k push-identity"
  echo "-w /etc/sudoers -p wa -k push-identity"
  echo "-w /etc/sudoers.d -p wa -k push-identity"
  echo "-w /etc/ld.so.preload -p wa -k push-preload"
  echo "-w /usr/local/bin -p wa -k push-bin"
  echo "-w /usr/local/sbin -p wa -k push-bin"
  echo "-w /usr/local/lib/push -p wa -k push-bin"
  echo "-w /etc/docker -p wa -k push-docker"
  echo "-w /etc/systemd/system/docker.service.d -p wa -k push-docker"
  echo "-w /usr/bin/docker -p x -k push-docker-exec"
  echo "-w /opt/push-be/.env -p r -k push-env-read"
  echo "-a always,exit -F arch=b64 -S execve -F dir=/tmp -k push-exec-tmp"
  echo "-a always,exit -F arch=b64 -S execve -F dir=/dev/shm -k push-exec-tmp"
  echo "-a always,exit -F arch=b64 -S execve -F dir=/var/tmp -k push-exec-tmp"
} >/etc/audit/rules.d/push.rules
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -e /etc/ld.so.preload ] || touch /etc/ld.so.preload
augenrules --load >/dev/null
systemctl enable --now auditd >/dev/null

# ---------------------------------------------------------------- automatic security updates
log "unattended-upgrades"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat >/etc/apt/apt.conf.d/52push-unattended-upgrades <<'EOF'
// Managed by infra/vps/harden.sh
Unattended-Upgrade::Origins-Pattern {
        "origin=${distro_id},archive=${distro_codename}-security,label=Ubuntu";
        "origin=UbuntuESMApps,archive=${distro_codename}-apps-security";
        "origin=UbuntuESM,archive=${distro_codename}-infra-security";
        "origin=Docker,label=Docker CE";
};
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
systemctl enable --now unattended-upgrades >/dev/null

# ---------------------------------------------------------------- unneeded services
log "services"
for unit in snapd.service snapd.socket snapd.seeded.service cups.service cups-browsed.service \
  avahi-daemon.service avahi-daemon.socket rpcbind.service rpcbind.socket ModemManager.service \
  postfix.service exim4.service apport.service whoopsie.service motd-news.timer \
  multipathd.service multipathd.socket udisks2.service; do
  if systemctl list-unit-files "$unit" >/dev/null 2>&1 && systemctl cat "$unit" >/dev/null 2>&1; then
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
    systemctl mask "$unit" >/dev/null 2>&1 || true
  fi
done

# ---------------------------------------------------------------- journald
install -d -m 0755 /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/push.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=1G
EOF
systemctl restart systemd-journald

# ---------------------------------------------------------------- watchdog
log "watchdog"
install -m 0755 "$HERE/bin/push-watchdog" /usr/local/sbin/push-watchdog
cat >/etc/systemd/system/push-watchdog.service <<'EOF'
[Unit]
Description=Push integrity watchdog
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/push-watchdog
Nice=10
EOF
cat >/etc/systemd/system/push-watchdog.timer <<'EOF'
[Unit]
Description=Run the Push integrity watchdog every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now push-watchdog.timer >/dev/null
# A re-run changes watched files on purpose; take a fresh baseline instead of alerting.
rm -f /var/lib/push-watchdog/*.base
/usr/local/sbin/push-watchdog || true

# ---------------------------------------------------------------- summary
host_key="$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
cat <<EOF

harden.sh finished.
  deploy keys:  ${#deploy_keys[@]} (forced command push-deploy)
  admin keys:   ${#admin_keys[@]}
  SSH host key: $host_key
Set the GitHub Actions variable VPS_SSH_HOST_KEY to the host key above.
Keep this root session open and confirm a new login as $DEPLOY_USER works before closing it.
EOF
