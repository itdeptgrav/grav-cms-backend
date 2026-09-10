#!/usr/bin/env bash
# Thin shim. The real runner is run.js — see its header for why.
#
# Short version: `npm run face:service` used to be `bash run.sh`, and on Windows
# `bash` resolves to WSL, where the Windows venv path in FACE_PYTHON does not
# exist. The failure looked like a missing interpreter that was plainly present.
# Node is already guaranteed by npm, so the runner moved there and this stayed
# behind for anyone with `bash run.sh …` in their fingers.
#
# Keeping the logic in ONE place matters more than the entry point: the
# interpreter and the data paths must be decided once, or the engine and the API
# end up looking at different folders.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Running this inside WSL against a Windows checkout is the exact trap above,
# one layer down: WSL's node would resolve the Windows venv path as a Linux
# one and fail just as opaquely. Say so instead.
if grep -qi microsoft /proc/version 2>/dev/null && [ -d /mnt/c ]; then
  cat >&2 <<'MSG'
This is WSL, and the face engine is a Windows install on this machine.
Run it from PowerShell instead:

    npm run face:service

(WSL cannot use the Windows venv in FACE_PYTHON, and the engine needs the
Windows paths in FACE_BIOMETRIC_ROOT.)
MSG
  exit 1
fi

exec node "$here/run.js" "$@"
