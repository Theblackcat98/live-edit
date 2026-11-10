#!/bin/bash
# Stop the four LiquidScribe llama.cpp servers started by start-models.sh.
set -u
LOGDIR="$HOME/Documents/Models/logs/lfm3"
fail=0
for name in text omni d1-omni audio; do
  pidfile="$LOGDIR/$name.pid"
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    if kill "$pid" 2>/dev/null; then
      echo "$name: stopped pid $pid"
    else
      echo "$name: pid $pid not running"
    fi
    rm -f "$pidfile"
  else
    echo "$name: no pid file"
  fi
done
exit $fail
