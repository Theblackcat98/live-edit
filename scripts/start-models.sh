#!/bin/bash
# Start the four llama.cpp servers LiquidScribe needs, headless (--no-webui),
# in the background. Idempotent: a member already answering is left alone.
#
#   LFM3-Omni-2B   :8083  chat + ASR (legacy front door)
#   d1-Omni-2B     :8085  routing / critic (zero-token)
#   LFM3-1.7B      :8080  worker XML tool calls
#   LFM3-Audio-2B  :8086  chat + ASR + TTS (default front door)
#
# Thin wrapper: scripts/model-manager.mjs is the source of truth (specs,
# health wait, pid files). Stop with: scripts/stop-models.sh
# Status: ./lfm3.sh status (in ~/Documents/Models) or
#   node scripts/model-manager.mjs status
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/model-manager.mjs" start --all
