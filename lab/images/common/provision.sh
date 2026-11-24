#!/usr/bin/env bash
# What every server of the lab has: the users ops (sudo) and deploy, host keys of its own, and the lab's CA.
set -euo pipefail
id ops >/dev/null 2>&1 || useradd -m -s /bin/bash ops
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
