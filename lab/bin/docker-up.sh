#!/usr/bin/env bash
# Starts Docker on the cloud machine. There is no systemd here, so dockerd runs in the background, and
# after a restart of the machine this script is run again. Safe to run any number of times.
set -euo pipefail
LAB="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$LAB/.state"
mkdir -p "$STATE"

if ! command -v dockerd >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
fi

# Every lab server runs systemd, and each systemd takes inotify instances. With the kernel's default
# of 128 per user a fourth lab's servers fail to start (systemd exits 255): the limits are raised.
sysctl -qw fs.inotify.max_user_instances=8192 fs.inotify.max_user_watches=1048576 || true

# A dockerd that is still starting, or still stopping its containers after it was told to end: wait for
# it to finish one way or the other. A second one started meanwhile refuses to run.
for _ in $(seq 60); do
  docker info >/dev/null 2>&1 && break
  pgrep -x dockerd >/dev/null 2>&1 || break
  sleep 1
done

# dockerd's log grows for as long as it runs: past 50 MB only its last 5 MB are kept, written in place, so
# a dockerd still writing to it goes on writing to the same file.
LOG="$STATE/dockerd.log"
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 52428800 ]; then
  tail -c 5242880 "$LOG" >"$LOG.tail" && cat "$LOG.tail" >"$LOG" && rm -f "$LOG.tail"
fi

if ! docker info >/dev/null 2>&1; then
  rm -f /var/run/docker.pid
  nohup dockerd >>"$STATE/dockerd.log" 2>&1 &
  for _ in $(seq 60); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi

if ! docker info >/dev/null 2>&1; then
  echo "dockerd did not start. Its log: $STATE/dockerd.log" >&2
  tail -20 "$STATE/dockerd.log" >&2 || true
  exit 1
fi
echo "Docker is up."
