#!/usr/bin/env bash
# The shop API as a systemd service, its settings in /etc/shop and its secrets in /etc/shop/env.
set -euo pipefail
id shop >/dev/null 2>&1 || useradd --system --home /opt/shop --shell /usr/sbin/nologin shop
install -d -m 755 /opt/shop /etc/shop
install -m 644 /tmp/lab/app.py /opt/shop/app.py
cat >/etc/shop/env <<ENV
DB_HOST=db-01
REDIS_HOST=cache-01
PORT=8080
DB_PASSWORD=${DB_PASSWORD}
REDIS_PASSWORD=${REDIS_PASSWORD}
API_KEY=${API_KEY}
JWT_SIGNING_KEY=${JWT_SIGNING_KEY}
ENV
chown root:shop /etc/shop/env && chmod 640 /etc/shop/env
cat >/etc/systemd/system/shop-api.service <<'UNIT'
[Unit]
Description=Shop API
After=network-online.target
Wants=network-online.target

[Service]
User=shop
EnvironmentFile=/etc/shop/env
ExecStart=/usr/bin/python3 /opt/shop/app.py
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now shop-api
# The deploy key's public half: web-01 deploys here as deploy.
cat /tmp/lab/deploy_ed25519.pub >>/home/deploy/.ssh/authorized_keys
