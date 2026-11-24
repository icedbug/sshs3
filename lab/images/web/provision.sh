#!/usr/bin/env bash
# nginx in front of the shop API, with TLS for shop.lab from the lab's CA, and a rate limit on /api/.
set -euo pipefail
install -d -m 755 /etc/nginx/tls
install -m 644 /tmp/lab/shop.crt /etc/nginx/tls/shop.crt
install -m 600 /tmp/lab/shop.key /etc/nginx/tls/shop.key
rm -f /etc/nginx/sites-enabled/default
cat >/etc/nginx/conf.d/shop.conf <<'CONF'
# shop.lab: the web shop and its API.
# OPS-812: at most 50 requests a second per client on the API.
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=50r/s;

upstream shop_backend {
    server app-01:8080;
}

server {
    listen 80;
    server_name shop.lab _;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name shop.lab _;
    ssl_certificate     /etc/nginx/tls/shop.crt;
    ssl_certificate_key /etc/nginx/tls/shop.key;

    location / {
        proxy_pass http://shop_backend;
    }

    location /api/ {
        limit_req zone=api_limit burst=20 nodelay;
        proxy_pass http://shop_backend;
    }
}
CONF
nginx -t
systemctl restart nginx
