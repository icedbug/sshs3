"""The shop API: what the lab's web servers sit in front of. Its health says whether the database and
the cache answer, so a fault anywhere behind it shows on the site."""
import http.server
import json
import os
import sys

import psycopg2
import redis

REQUIRED = ("DB_PASSWORD", "REDIS_PASSWORD", "API_KEY", "JWT_SIGNING_KEY")
missing = [name for name in REQUIRED if not os.environ.get(name)]
if missing:
    print(f"shop-api: missing settings in /etc/shop/env: {', '.join(missing)}", file=sys.stderr)
    sys.exit(78)

try:
    PORT = int(os.environ.get("PORT", "8080"))
except ValueError:
    print(f"shop-api: PORT must be a number, got {os.environ.get('PORT')!r}", file=sys.stderr)
    sys.exit(78)

DB = dict(host=os.environ.get("DB_HOST", "db-01"), dbname="shop", user="shop", password=os.environ["DB_PASSWORD"], connect_timeout=3)
CACHE = dict(host=os.environ.get("REDIS_HOST", "cache-01"), port=6379, password=os.environ["REDIS_PASSWORD"], socket_timeout=3)


def check():
    out = {}
    try:
        with psycopg2.connect(**DB) as conn, conn.cursor() as cur:
            cur.execute("select count(*) from orders")
            out["orders"] = cur.fetchone()[0]
            out["db"] = True
    except Exception as error:  # noqa: BLE001 - any failure is reported as the database being down
        out["db"] = False
        print(f"shop-api: database: {str(error).splitlines()[0][:200]}", file=sys.stderr)
    try:
        redis.Redis(**CACHE).ping()
        out["cache"] = True
    except Exception as error:  # noqa: BLE001
        out["cache"] = False
        print(f"shop-api: cache: {str(error)[:200]}", file=sys.stderr)
    return out


class Handler(http.server.BaseHTTPRequestHandler):
    def send(self, code, body, kind="application/json"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802 - the name http.server calls
        if self.path == "/health":
            state = check()
            ok = state.get("db") and state.get("cache")
            self.send(200 if ok else 503, json.dumps({"status": "ok" if ok else "degraded", **state}))
        elif self.path in ("/", "/index.html"):
            state = check()
            self.send(200, f"<html><head><title>Shop</title></head><body><h1>Shop</h1><p>{state.get('orders', '?')} orders</p></body></html>", "text/html")
        elif self.path.startswith("/api/orders"):
            state = check()
            self.send(200 if state.get("db") else 503, json.dumps({"orders": state.get("orders")}))
        else:
            self.send(404, json.dumps({"error": "not found"}))

    def log_message(self, fmt, *args):
        print(f"shop-api: {self.address_string()} {fmt % args}", file=sys.stderr)


http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
