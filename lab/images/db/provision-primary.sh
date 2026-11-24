#!/usr/bin/env bash
# PostgreSQL 16 primary for the shop: the orders, a replication user, and WAL archived to s3-01 with rclone.
set -euo pipefail
conf=/etc/postgresql/16/main
cat >"$conf/conf.d/shop.conf" <<CONF
listen_addresses = '*'
wal_level = replica
max_wal_senders = 5
wal_keep_size = 64MB
archive_mode = on
archive_command = '/usr/local/bin/wal-archive.sh %p %f'
CONF
cat >>"$conf/pg_hba.conf" <<'HBA'
host    shop            shop            samenet                 scram-sha-256
host    replication     replicator      samenet                 scram-sha-256
HBA
install -d -m 700 -o postgres -g postgres /etc/rclone
cat >/etc/rclone/rclone.conf <<RCLONE
[s3]
type = s3
provider = SeaweedFS
access_key_id = labadmin
secret_access_key = ${AWS_SECRET}
endpoint = http://s3-01:9000
RCLONE
chown postgres:postgres /etc/rclone/rclone.conf && chmod 600 /etc/rclone/rclone.conf
cat >/usr/local/bin/wal-archive.sh <<'ARCHIVE'
#!/bin/sh
# Called by PostgreSQL for each finished WAL segment: $1 is its path, $2 its name.
exec rclone --config /etc/rclone/rclone.conf copyto "$1" "s3:wal-archive/db-01/$2"
ARCHIVE
chmod 755 /usr/local/bin/wal-archive.sh
rclone --config /etc/rclone/rclone.conf mkdir s3:wal-archive
rclone --config /etc/rclone/rclone.conf mkdir s3:backups
rclone --config /etc/rclone/rclone.conf mkdir s3:team
systemctl restart postgresql
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'shop') THEN CREATE ROLE shop LOGIN PASSWORD '${DB_PASSWORD}'; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'replicator') THEN CREATE ROLE replicator REPLICATION LOGIN PASSWORD '${DB_PASSWORD}'; END IF;
END \$\$;
SQL
sudo -u postgres psql -tAc "select 1 from pg_database where datname='shop'" | grep -q 1 || sudo -u postgres createdb -O shop shop
sudo -u postgres psql -v ON_ERROR_STOP=1 -q shop <<'SQL'
CREATE TABLE IF NOT EXISTS orders (id serial PRIMARY KEY, customer text NOT NULL, amount numeric(10,2) NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO orders (customer, amount, created_at)
  SELECT 'customer-' || (g % 997), round((random() * 500)::numeric, 2), now() - (g || ' minutes')::interval
  FROM generate_series(1, 10000) AS g
  WHERE (SELECT count(*) FROM orders) = 0;
ALTER TABLE orders OWNER TO shop;
ALTER SEQUENCE orders_id_seq OWNER TO shop;
SQL
sudo -u postgres psql -qc 'select pg_switch_wal()' >/dev/null
cat >/etc/cron.d/shop-backup <<'CRON'
# The shop database, every night to the backups bucket.
30 2 * * * postgres pg_dump shop | gzip | rclone --config /etc/rclone/rclone.conf rcat s3:backups/shop-$(date +\%F).sql.gz
CRON
