#!/usr/bin/env bash
# A streaming replica of db-01, made from a base backup.
set -euo pipefail
conf=/etc/postgresql/16/main
echo "listen_addresses = '*'" >"$conf/conf.d/shop.conf"
echo "hot_standby = on" >>"$conf/conf.d/shop.conf"
echo "db-01:5432:replication:replicator:${DB_PASSWORD}" >/var/lib/postgresql/.pgpass
chown postgres:postgres /var/lib/postgresql/.pgpass && chmod 600 /var/lib/postgresql/.pgpass
systemctl stop postgresql
rm -rf /var/lib/postgresql/16/main
sudo -u postgres pg_basebackup -h db-01 -U replicator -D /var/lib/postgresql/16/main -R -X stream -w
chmod 700 /var/lib/postgresql/16/main
systemctl start postgresql
