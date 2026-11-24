#!/usr/bin/env bash
# The deploy key on web-01: deploy logs in to app-01 with it.
set -euo pipefail
install -m 600 -o deploy -g deploy /tmp/lab/deploy_ed25519 /home/deploy/.ssh/id_ed25519
