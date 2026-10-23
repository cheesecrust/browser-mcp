#!/bin/bash
# Pulls the deployed branch and rebuilds the containers when it moved.
# Installed as an hourly cron job by deploy/lightsail-launch.sh; safe to run by hand.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

git fetch --depth 1 --quiet origin "$BRANCH"
if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ]; then
  exit 0
fi

echo "== updating to $(git rev-parse --short "origin/$BRANCH") $(date -Is)"
git reset --hard --quiet "origin/$BRANCH"
docker compose --profile https up -d --build
docker image prune -f > /dev/null
echo "== updated $(date -Is)"
