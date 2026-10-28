#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/rakazo-computer
test -f .rakazo-computer-owner
if docker inspect rakazo-computer >/dev/null 2>&1; then
  test "$(docker inspect -f '{{index .Config.Labels "app.owner"}}' rakazo-computer)" = rakazo-computer
fi
# Always restore this bridge's protection before starting the container.
bash firewall.sh
docker compose up -d --wait --wait-timeout 90
