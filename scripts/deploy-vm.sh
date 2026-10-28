#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# sshs3 1-Command VM Web Deployment Script
# Usage:
#   ./scripts/deploy-vm.sh [--port 8080] [--systemd]
# ==============================================================================

PORT="${SSHS3_WEB_PORT:-8080}"
MODE="auto"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      PORT="$2"
      shift 2
      ;;
    --systemd)
      MODE="systemd"
      shift
      ;;
    --docker)
      MODE="docker"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

export SSHS3_WEB_PORT="$PORT"

if [[ "$MODE" == "auto" ]]; then
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    MODE="docker"
  else
    MODE="systemd"
  fi
fi

if [[ "$MODE" == "docker" ]]; then
  echo "[sshs3-deploy] Starting sshs3 Multi-User Web Server with Docker Compose on port ${PORT}..."
  mkdir -p ./sshs3-data
  docker compose up -d --build
  echo "=================================================================="
  echo "  sshs3 Web Server deployed via Docker!"
  echo "  Open in browser: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost):${PORT}"
  echo "=================================================================="
  exit 0
fi

echo "[sshs3-deploy] Deploying sshs3 Multi-User Web Server directly on VM (port ${PORT})..."

if ! command -v node >/dev/null 2>&1; then
  echo "[sshs3-deploy] Installing Node.js 22 and system dependencies..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y curl git openssh-client build-essential python3 ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
fi

npm install
npm run build:web

DATA_DIR="${SSHS3_DATA_DIR:-$HOME/.sshs3-web-server}"
mkdir -p "$DATA_DIR"

if command -v systemctl >/dev/null 2>&1 && [[ -d /etc/systemd/system ]]; then
  SERVICE_FILE="/etc/systemd/system/sshs3-web.service"
  APP_DIR="$(pwd)"
  NODE_BIN="$(command -v node)"
  echo "[sshs3-deploy] Configuring systemd service: ${SERVICE_FILE}..."
  sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=sshs3 Multi-User Web Workspace Server
After=network.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=SSHS3_WEB_HOST=0.0.0.0
Environment=SSHS3_WEB_PORT=${PORT}
Environment=SSHS3_DATA_DIR=${DATA_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/dist-web/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now sshs3-web.service
  echo "=================================================================="
  echo "  sshs3 Web Server is active via systemd (sshs3-web.service)!"
  echo "  URL: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost):${PORT}"
  echo "=================================================================="
else
  echo "[sshs3-deploy] Starting sshs3 Web Server in foreground..."
  SSHS3_WEB_PORT="$PORT" SSHS3_DATA_DIR="$DATA_DIR" node dist-web/server.mjs
fi
