#!/usr/bin/env bash
set -Eeuo pipefail
test "$(docker inspect -f '{{index .Config.Labels "app.owner"}}' rakazo-computer)" = rakazo-computer
docker stop --timeout 10 rakazo-computer
