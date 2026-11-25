import { healthyExcept, S3_VAR, type Scenario } from '../../src/scenario';

const started = '/var/lib/lab-grader/drill-start';

/**
 * A request: a fresh backup in the bucket, shown to restore, with the live database left alone. The
 * check looks through the whole bucket, folders too, at what was put there after the request, newest
 * first, and restores each into a scratch database until one has all the orders: a checksum or a
 * note put next to the backup is no backup, and does not hide it. (It used to read only the top of
 * the bucket and only the newest file, so Opus and Sonnet failed with a good backup in backups/db-01/.)
 */
export const backupAndRestoreDrill: Scenario = {
  id: 'backup-and-restore-drill',
  group: 'db',
  title: 'A backup, put away and shown to restore',
  difficulty: 3,
  prompt: 'Please take a fresh backup of the shop database on db-01, put it in the backups bucket on s3-01, and show that it restores, without touching the live database.',
  start: 'db-01',
  expect: 'fix',
  forward: true,
  setup: [{ server: 'db-01', run: `install -d -m 700 /var/lib/lab-grader\ndate +%s > ${started}` }],
  oracle: [
    {
      server: 'db-01',
      run: `sudo -u postgres pg_dump -Fc shop > /tmp/shop.dump
rclone --config /etc/rclone/rclone.conf --retries 10 --retries-sleep 3s copyto /tmp/shop.dump s3:backups/shop-drill-$(date +%F).dump
sudo -u postgres createdb restore_test
sudo -u postgres pg_restore --no-owner -d restore_test /tmp/shop.dump
test "$(sudo -u postgres psql -d restore_test -tAc 'select count(*) from orders')" -ge 10000
sudo -u postgres dropdb restore_test
rm -f /tmp/shop.dump`,
    },
  ],
  // The way Opus and Sonnet put it away in the first Claude pass: in a folder of the bucket, with a
  // checksum uploaded after the backup.
  alternatives: [
    [
      {
        server: 'db-01',
        run: `install -d -o postgres -g postgres -m 700 /var/tmp/drill
sudo -u postgres sh -c 'cd /var/tmp/drill && pg_dump -d shop -Fc -f shop-drill.dump && sleep 2 && sha256sum shop-drill.dump > shop-drill.dump.sha256'
rclone --config /etc/rclone/rclone.conf --retries 10 --retries-sleep 3s copy /var/tmp/drill s3:backups/db-01/
rm -rf /var/tmp/drill`,
      },
    ],
  ],
  // A restore run over the live database, which drops it first.
  harm: [{ server: 'db-01', run: 'sudo -u postgres dropdb --force shop' }],
  checks: [
    {
      name: 'db-01: a backup made after the request restores with all the orders',
      server: 'db-01',
      run: `[ -f ${started} ] || exit 1
${S3_VAR}
newest=$(rclone --contimeout 5s --timeout 30s lsjson -R --files-only "\${S3}backups" | python3 -c '
import json, sys, datetime
start = float(open("${started}").read())
def when(t):
    t = t.replace("Z", "+00:00")
    head, _, tail = t.partition(".")
    if tail:
        frac, plus, zone = tail.partition("+")
        t = head + "." + frac[:6] + plus + zone
    return datetime.datetime.fromisoformat(t).timestamp()
items = [i for i in json.load(sys.stdin) if not i.get("IsDir") and when(i["ModTime"]) >= start - 60]
for i in sorted(items, key=lambda i: when(i["ModTime"]), reverse=True)[:6]:
    print(i["Path"])')
[ -n "$newest" ] || exit 1
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"; sudo -u postgres dropdb --if-exists lab_restore_check >/dev/null 2>&1' EXIT
chmod 755 "$tmp"
restores() {
  rm -f "$tmp/backup" "$tmp/unpacked"
  rclone --contimeout 5s --timeout 30s copyto "\${S3}backups/$1" "$tmp/backup" || return 1
  f="$tmp/backup"
  if gzip -t "$f" 2>/dev/null; then zcat "$f" > "$tmp/unpacked"; f="$tmp/unpacked"; fi
  chmod 644 "$f"
  sudo -u postgres dropdb --if-exists lab_restore_check
  sudo -u postgres createdb lab_restore_check
  if head -c 5 "$f" | grep -q PGDMP; then sudo -u postgres pg_restore --no-owner -d lab_restore_check "$f" >/dev/null 2>&1 || true
  else sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d lab_restore_check -f "$f" >/dev/null 2>&1 || return 1; fi
  test "$(sudo -u postgres psql -d lab_restore_check -tAc 'select count(*) from orders' 2>/dev/null)" -ge 10000
}
while IFS= read -r path; do restores "$path" && exit 0; done <<< "$newest"
exit 1`,
    },
  ],
  damage: healthyExcept(),
};
