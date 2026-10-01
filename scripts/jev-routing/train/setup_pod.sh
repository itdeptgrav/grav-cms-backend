#!/usr/bin/env bash
# scripts/jev-routing/train/setup_pod.sh — prepare a rented GPU pod. Run ON THE POD.
#
#   bash /workspace/grav-jev/train/setup_pod.sh
#
# Expects /workspace/grav-jev to hold the uploaded bundle (see RUNBOOK-runpod.md).
# Pins and verifies everything it fetches; any mismatch stops the script.
set -euo pipefail

WS=${WS:-/workspace}
BUNDLE="$WS/grav-jev"
OPEN_JEV_COMMIT=3308a15ccd7eea1df7a37d6ddc39b023b801ba16
BASE_MODEL=Qwen/Qwen3.5-2B
BASE_REVISION=15852e8c16360a2fea060d615a32b45270f8a8fc
PACKAGE_REPO=ZefanCai/Open-Jev-2B
PACKAGE_REVISION=0c7aa498b1627be8da4acf34c863ff0ee0a92785
PACKAGE_MANIFEST_SHA256=58319da5c2a948a4645e46d9c982be44867d78779ea1c3bfb81b64867f58ef3a
NODE_VERSION=v20.18.0
VENV="$WS/jev-venv"

echo "== GPU"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
python - <<'PY'
import torch, sys
assert torch.cuda.is_available(), "CUDA not visible"
major, minor = (int(x) for x in torch.__version__.split("+")[0].split(".")[:2])
assert (major, minor) >= (2, 8), f"torch {torch.__version__} < 2.8 required by Open-Jev"
print("torch", torch.__version__, "cuda", torch.version.cuda, torch.cuda.get_device_name())
PY

echo "== bundle integrity"
( cd "$BUNDLE" && sha256sum -c BUNDLE.sha256 )

echo "== Open-Jev @ $OPEN_JEV_COMMIT"
cd "$WS"
[ -d open-jev/.git ] || git clone --filter=blob:none https://github.com/Zefan-Cai/Open-Jev.git open-jev
git -C open-jev fetch origin "$OPEN_JEV_COMMIT"
git -C open-jev checkout --detach "$OPEN_JEV_COMMIT"
[ "$(git -C open-jev rev-parse HEAD)" = "$OPEN_JEV_COMMIT" ]
[ -z "$(git -C open-jev status --porcelain)" ] || { echo "Open-Jev checkout is modified"; exit 1; }

echo "== python dependencies"
if [ ! -x "$VENV/bin/python" ]; then
  python -m venv --system-site-packages "$VENV"
fi
"$VENV/bin/python" -m pip install --quiet -r "$BUNDLE/train/requirements-train.txt"
"$VENV/bin/python" -m pip install --quiet --no-deps -e "$WS/open-jev"

echo "== weights (Open-Jev's own verifying fetcher)"
export JEV_MODEL_ROOT="$WS/models" HF_HUB_CACHE="$WS/models/hub"
JEV_BASE_MODEL=$BASE_MODEL JEV_BASE_REVISION=$BASE_REVISION \
JEV_PACKAGE_REPO=$PACKAGE_REPO JEV_PACKAGE_REVISION=$PACKAGE_REVISION \
  "$VENV/bin/python" "$WS/open-jev/docker/fetch_models.py"
[ "$(sha256sum "$WS/models/Open-Jev-2B/package/manifest.json" | cut -d' ' -f1)" = "$PACKAGE_MANIFEST_SHA256" ]

echo "== node $NODE_VERSION for the evaluator"
if ! command -v node >/dev/null || [ "$(node -v)" != "$NODE_VERSION" ]; then
  cd /tmp
  curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  grep " node-$NODE_VERSION-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
  tar -xJf "node-$NODE_VERSION-linux-x64.tar.xz" -C /usr/local --strip-components=1
fi
node -v

echo "== trainer unit tests (no GPU work)"
"$VENV/bin/python" -m unittest discover -s "$BUNDLE/train" -p 'test_*.py'
echo "SETUP OK"
