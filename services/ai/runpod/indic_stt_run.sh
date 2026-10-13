#!/bin/bash
# (Re)start the GRAV voice STT server — stops ONLY the process this script
# started (its pid file), never anything else on the pod.
cd /root/grav-voice-stt || exit 1
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then kill "$(cat server.pid)"; sleep 2; fi
setsid nohup /root/indic-flex-venv/bin/python server.py > server.log 2>&1 < /dev/null &
echo $! > server.pid
for i in $(seq 1 40); do curl -s -m 2 http://127.0.0.1:19057/health && exit 0; sleep 1; done
echo "not ready"; tail -5 server.log; exit 1
