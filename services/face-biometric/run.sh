#!/usr/bin/env bash
# Runs the face engine with the backend's configuration.
#
# One entry point for every engine command, so the interpreter and the data
# paths are decided in exactly one place.
#
# Only FACE_* keys are read out of .env, and they are read rather than
# sourced: a .env is a key/value file, not a shell script, and sourcing one
# executes whatever an unquoted value happens to look like. A real value in
# this backend's .env contains a space, which is enough to break it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

if [ -f "$root/.env" ]; then
  while IFS= read -r line; do
    key="${line%%=*}"
    val="${line#*=}"
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    # The real environment wins over the file.
    if [ -z "${!key:-}" ]; then export "$key=$val"; fi
  done < <(grep -E '^FACE_[A-Z_]+=' "$root/.env" || true)
fi

PY="${FACE_PYTHON:-$HOME/phone_detc_venv/bin/python}"
export FACE_BIOMETRIC_ROOT="${FACE_BIOMETRIC_ROOT:-/Volumes/ESD-USB/PHONE_DETC}"
export FACE_BIOMETRIC_REGISTERED_DIR="${FACE_BIOMETRIC_REGISTERED_DIR:-$FACE_BIOMETRIC_ROOT/REGISTERED_PEOPLE}"
export FACE_BIOMETRIC_PEOPLE_MAP="${FACE_BIOMETRIC_PEOPLE_MAP:-$FACE_BIOMETRIC_ROOT/biometric_people.json}"
export FACE_BIOMETRIC_STATUS_FILE="${FACE_BIOMETRIC_STATUS_FILE:-$FACE_BIOMETRIC_ROOT/biometric_status.json}"
PORT="${FACE_BIOMETRIC_PORT:-5001}"

if [ ! -x "$PY" ]; then
  echo "FACE_PYTHON is not an executable interpreter: $PY" >&2
  echo "Set FACE_PYTHON in $root/.env to a python with insightface installed." >&2
  exit 1
fi
if [ ! -d "$FACE_BIOMETRIC_REGISTERED_DIR" ]; then
  echo "warning: no registration directory at $FACE_BIOMETRIC_REGISTERED_DIR" >&2
  echo "         set FACE_BIOMETRIC_ROOT (or _REGISTERED_DIR) in $root/.env" >&2
fi

cmd="${1:-service}"; shift || true
case "$cmd" in
  service) exec "$PY" "$here/face_biometric_server.py" --port "$PORT" "$@" ;;
  status)  exec "$PY" "$here/face_biometric.py" --hr-map-status "$@" ;;
  check)   exec "$PY" "$here/face_biometric.py" --check-registered "$@" ;;
  test)    exec "$PY" "$here/test_face_biometric.py" "$@" ;;
  link)    exec "$PY" "$here/face_biometric.py" "$@" ;;
  *)       echo "usage: run.sh {service|status|check|test}" >&2; exit 2 ;;
esac
