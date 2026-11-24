#!/usr/bin/env bash
# Redis for the shop API, on the lab network, with a password.
set -euo pipefail
conf=/etc/redis/redis.conf
sed -i -E 's/^bind .*/bind 0.0.0.0 ::/; s/^protected-mode .*/protected-mode no/' "$conf"
sed -i -E '/^requirepass /d' "$conf"
echo "requirepass ${REDIS_PASSWORD}" >>"$conf"
systemctl restart redis-server
