#!/bin/bash
# Stop the four LiquidScribe llama.cpp servers started by start-models.sh
# (or the model-manager daemon). Thin wrapper: scripts/model-manager.mjs owns
# the pid-file kill. Per-member: pass names, e.g. `model-manager.mjs stop d1-omni`.
set -u
exec node "$(cd "$(dirname "$0")" && pwd)/model-manager.mjs" stop --all
