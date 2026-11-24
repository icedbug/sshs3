#!/usr/bin/env bash
# What every server of the lab has: the users ops (sudo) and deploy, host keys of its own, and the lab's CA.
set -euo pipefail
id ops >/dev/null 2>&1 || useradd -m -s /bin/bash ops
# As on a real Ubuntu server: D-Bus, so that systemctl answers a user and not only root, and the ops
# account in the groups that read the system's logs and journal.
if ! dpkg -s dbus >/dev/null 2>&1; then
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends dbus >/dev/null
  rm -rf /var/lib/apt/lists/*
fi
systemctl enable --now dbus.socket dbus.service >/dev/null 2>&1 || true
usermod -aG adm,systemd-journal ops
id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash deploy
echo 'ops ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/ops && chmod 440 /etc/sudoers.d/ops
for u in ops deploy; do
  install -d -m 700 -o "$u" -g "$u" "/home/$u/.ssh"
  touch "/home/$u/.ssh/authorized_keys" && chown "$u:$u" "/home/$u/.ssh/authorized_keys" && chmod 600 "/home/$u/.ssh/authorized_keys"
done
# Real servers each have their own host keys; the image's are shared, so they are made again here.
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A >/dev/null
systemctl restart ssh
install -m 644 /tmp/lab/lab-ca.crt /usr/local/share/ca-certificates/lab-ca.crt
update-ca-certificates >/dev/null 2>&1
# The distribution's own timers: package updates, upgrades, log rotation and other daily jobs would change a server in
# the middle of a run.
systemctl mask --now apt-daily.timer apt-daily-upgrade.timer dpkg-db-backup.timer motd-news.timer e2scrub_all.timer fstrim.timer logrotate.timer >/dev/null 2>&1
