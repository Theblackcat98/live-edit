#!/bin/bash
# Start the four llama.cpp servers LiquidScribe needs, headless (--no-webui),
# in the background. Idempotent: a member already answering is left alone.
#
#   LFM3-Omni-2B   :8083  chat + ASR (legacy front door)
#   d1-Omni-2B     :8085  routing / critic (zero-token)
#   LFM3-1.7B      :8080  worker XML tool calls
#   LFM3-Audio-2B  :8086  chat + ASR + TTS (default front door)
#
# Stop with: scripts/stop-models.sh   Status: ./lfm3.sh status (in ~/Documents/Models)
set -euo pipefail

MODELS_ROOT="$HOME/Documents/Models"
MODEL_DIR="$MODELS_ROOT/lfm3"
LOGDIR="$MODELS_ROOT/logs/lfm3"
mkdir -p "$LOGDIR"

# Same backend resolution as lfm3.sh: ROCm build first, Vulkan fallback.
pick_bin() {
  for dir in "$MODELS_ROOT/llama.cpp/build/bin" "$MODELS_ROOT/llama.cpp/build-vulkan/bin"; do
    lib="$(ls "$dir"/libllama.so.* 2>/dev/null | tail -1 || true)"
    if [ -x "$dir/llama-server" ] && [ -n "$lib" ] && grep -qa "llama_model_lfm3" "$lib"; then
      printf '%s' "$dir"
      return 0
    fi
  done
  echo "no llama.cpp build with lfm3 support found; run: cmake --build ~/Documents/Models/llama.cpp/build" >&2
  exit 1
}
BIN="$(pick_bin)"

DEVICE="$("$BIN/llama-server" --list-devices 2>/dev/null | awk '
  /Device/ { next }
  /^[A-Za-z]+[0-9]+:/ { if ($0 ~ /Ryzen|CPU|llvmpipe|Software/) next; print $1; exit }')"
[ -n "$DEVICE" ] || DEVICE="ROCm0"

# Family tuning from lfm3.sh: threads, batches, quantized KV, prompt cache.
COMMON_FLAGS=(
  -t 8 -tb 16
  --device "$DEVICE"
  --gpu-layers auto
  --fit on
  -fa on
  -b 2048 -ub 512
  -np 1
  --cache-type-k q8_0 --cache-type-v q8_0
  --jinja
  --cache-prompt
  --metrics --slots
  --no-webui
  --host 0.0.0.0
)

up() { curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:$1/v1/models" >/dev/null 2>&1; }

require_file() { [ -f "$1" ] || {
  echo "missing $1 - run $MODELS_ROOT/download-script/lfm3.sh" >&2
  exit 1
}; }

start_member() { # name port gguf [mmproj] [extra flags...]
  local name="$1" port="$2" model="$3"
  shift 3
  local pidfile="$LOGDIR/$name.pid"
  if up "$port"; then
    echo "$name already up on :$port" >&2
    return 0
  fi
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$name: pid $(cat "$pidfile") still starting, leaving it alone" >&2
    return 0
  fi
  require_file "$model"
  nohup "$BIN/llama-server" -m "$model" "${@}" --port "$port" \
    >>"$LOGDIR/$name.log" 2>&1 &
  echo $! >"$pidfile"
  echo "$name: starting on :$port (pid $!, log $LOGDIR/$name.log)" >&2
}

start_member text 8080 "$MODEL_DIR/LFM3-1.7B-Q4_K_M.gguf" \
  --alias lfm3-1.7b -c 128000 "${COMMON_FLAGS[@]}" \
  --reasoning on --reasoning-preserve --temp 0.1 --top-k 50 --repeat-penalty 1.1

start_member omni 8083 "$MODEL_DIR/LFM3-Omni-2B-Q4_K_M.gguf" \
  --mmproj "$MODEL_DIR/mmproj-LFM3-Omni-2B-Q8_0.gguf" \
  --alias lfm3-omni-2b -c 32000 "${COMMON_FLAGS[@]}" \
  --temp 0

start_member d1-omni 8085 "$MODEL_DIR/d1-Omni-2B-Q8_0.gguf" \
  --mmproj "$MODEL_DIR/mmproj-d1-Omni-2B-Q8_0.gguf" \
  --alias d1-omni-2b -c 128000 "${COMMON_FLAGS[@]}" \
  -b 8192 -ub 8192

start_member audio 8086 "$MODEL_DIR/LFM3-Audio-2B-Q4_K_M.gguf" \
  --mmproj "$MODEL_DIR/mmproj-LFM3-Audio-2B-Q8_0.gguf" \
  --alias lfm3-audio-2b -c 128000 "${COMMON_FLAGS[@]}" \
  --reasoning on --reasoning-preserve --temp 0.3

# Wait for health (d1-Omni Q8_0 is the slowest to load).
fail=0
for port in 8080 8083 8085 8086; do
  for _ in $(seq 1 60); do
    up "$port" && break
    sleep 2
  done
  if up "$port"; then
    echo ":$port up"
  else
    echo ":$port FAILED to come up - check $LOGDIR" >&2
    fail=1
  fi
done
exit $fail
