#!/usr/bin/env bash
# Prepare the pinned fresh-Qwen-4B experiment without downloading any 2B package.
set -euo pipefail

WS=${WS:-/workspace}
BUNDLE="$WS/grav-jev"
OPEN_JEV_COMMIT=3308a15ccd7eea1df7a37d6ddc39b023b801ba16
NODE_VERSION=v20.18.0
VENV="$WS/jev-venv"

echo "== GPU"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
python - <<'PY'
import torch
assert torch.cuda.is_available(), "CUDA not visible"
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

echo "== Python dependencies"
[ -x "$VENV/bin/python" ] || python -m venv --system-site-packages "$VENV"
"$VENV/bin/python" -m pip install --quiet -r "$BUNDLE/train/requirements-train.txt"
"$VENV/bin/python" -m pip install --quiet --no-deps -e "$WS/open-jev"
# Qwen3.5's unfused fallback exceeds 48 GiB during backward at the measured
# dataset length. Pin the upstream training kernels without permitting pip to
# replace the already-attested Torch, Transformers or Triton stack.
"$VENV/bin/python" -m pip install --quiet --no-deps \
  einops==0.8.1 ninja==1.13.0 fla-core==0.4.2 flash-linear-attention==0.4.2
"$VENV/bin/python" -m pip install --quiet --no-build-isolation --no-deps causal-conv1d==1.6.1

echo "== node $NODE_VERSION"
if ! command -v node >/dev/null || [ "$(node -v)" != "$NODE_VERSION" ]; then
  cd /tmp
  curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  grep " node-$NODE_VERSION-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
  tar -xJf "node-$NODE_VERSION-linux-x64.tar.xz" -C /usr/local --strip-components=1
fi
node -v

"$VENV/bin/python" -m unittest discover -s "$BUNDLE/train" -p 'test_*.py'
echo "FRESH 4B SETUP OK"
