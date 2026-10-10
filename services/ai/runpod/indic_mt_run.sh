#!/bin/bash
# (Re)start the GRAV voice translation server (IndicTrans2) — stops ONLY the
# process this script started (its pid file), never anything else on the pod.
cd /root/grav-voice-mt || exit 1
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then kill "$(cat server.pid)"; sleep 2; fi
HF_HUB_CACHE=/workspace/hf-cache/hub setsid nohup ./venv/bin/python server.py > server.log 2>&1 < /dev/null &
echo $! > server.pid
for i in $(seq 1 90); do curl -s -m 2 http://127.0.0.1:19058/health && exit 0; sleep 1; done
echo "not ready"; tail -8 server.log; exit 1
