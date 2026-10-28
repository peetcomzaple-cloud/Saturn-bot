#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
cp ../../packages/ui-tokens/src/tokens.css web/tokens.css
