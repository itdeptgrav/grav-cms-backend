#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${GRAV_MRF_VOICE_ROOT:-/workspace/grav-mrf-voice}"
# Keep runtimes on the persistent workspace volume. RunPod migrations wipe
# /tmp; rebuilding several gigabytes there left a running pod with no voice
# services after every migration.
VENV_ROOT="${GRAV_MRF_VOICE_VENV:-${APP_ROOT}/venv-runtime}"
PARLER_VENV_ROOT="${GRAV_MRF_PARLER_VENV:-${APP_ROOT}/venv-parler}"
TRANSLATION_VENV_ROOT="${GRAV_MRF_TRANSLATION_VENV:-${APP_ROOT}/venv-translation}"
HINDI_VENV_ROOT="${GRAV_MRF_HINDI_VENV:-${APP_ROOT}/venv-chatterbox-hi}"
CONFIG_FILE="${GRAV_MRF_VOICE_CONFIG:-${APP_ROOT}/config.env}"
PARLER_PACKAGE="git+https://github.com/huggingface/parler-tts.git@d108732cd57788ec86bc857d99a6cabd66663d68"

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "Missing private worker configuration: ${CONFIG_FILE}" >&2
  exit 1
fi

set -a
source "${CONFIG_FILE}"
set +a

# RunPod object-volume migrations can flatten Hugging Face snapshot symlinks.
# Prefer the validated direct-file reconstruction when it is present, while
# still allowing an explicitly configured different model to win.
dialog_model_default="Qwen/Qwen3-4B-Instruct-2507"
dialog_model_local="${APP_ROOT}/models/qwen3-4b-instruct-2507"
if [[ "${MRF_DIALOG_MODEL:-${dialog_model_default}}" == "${dialog_model_default}" \
  && -s "${dialog_model_local}/config.json" ]]; then
  export MRF_DIALOG_MODEL="${dialog_model_local}"
fi

for name in LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET GRAV_BACKEND_URL MRF_VOICE_WORKER_SECRET; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required setting: ${name}" >&2
    exit 1
  fi
done

if [[ ! -x "${VENV_ROOT}/bin/python" ]]; then
  uv venv --seed "${VENV_ROOT}"
  uv pip install --python "${VENV_ROOT}/bin/python" -r "${APP_ROOT}/app/requirements.txt"
fi

# Parler requires Transformers 4.46 while the Qwen dialogue gateway uses the
# current Transformers runtime. Keep it in a disposable, isolated venv. The
# pod image already supplies CUDA PyTorch, so system-site-packages avoids a
# multi-gigabyte duplicate install; model weights remain on persistent storage.
if [[ ! -x "${PARLER_VENV_ROOT}/bin/python" ]]; then
  python3 -m venv --system-site-packages "${PARLER_VENV_ROOT}"
fi
if ! "${PARLER_VENV_ROOT}/bin/python" -c 'import fastapi, parler_tts, transformers, uvicorn; assert transformers.__version__ == "4.46.1"' >/dev/null 2>&1; then
  "${PARLER_VENV_ROOT}/bin/pip" install "${PARLER_PACKAGE}" \
    "fastapi~=0.118" "uvicorn[standard]~=0.37"
fi

if [[ ! -x "${TRANSLATION_VENV_ROOT}/bin/python" ]]; then
  uv venv --seed "${TRANSLATION_VENV_ROOT}"
fi
if ! "${TRANSLATION_VENV_ROOT}/bin/python" -c 'import fastapi, onnxruntime, tokenizers, uvicorn; from IndicTransToolkit import IndicProcessor; import transformers; assert int(transformers.__version__.split(".")[0]) < 5' >/dev/null 2>&1; then
  uv pip install --python "${TRANSLATION_VENV_ROOT}/bin/python" \
    onnxruntime tokenizers indictranstoolkit "transformers<5" \
    "fastapi~=0.118" "uvicorn[standard]~=0.37"
fi

# Chatterbox Hindi V3 ships its current loader with the official demo Space.
# Keep its fast-moving audio dependencies isolated from STT, Qwen and Parler.
if [[ ! -x "${HINDI_VENV_ROOT}/bin/python" ]]; then
  python3 -m venv --system-site-packages "${HINDI_VENV_ROOT}"
fi
if ! "${HINDI_VENV_ROOT}/bin/python" -c 'import fastapi, librosa, perth, s3tokenizer, soundfile, uvicorn' >/dev/null 2>&1; then
  "${HINDI_VENV_ROOT}/bin/pip" install --no-deps chatterbox-tts
  "${HINDI_VENV_ROOT}/bin/pip" install \
    conformer diffusers librosa omegaconf pykakasi pyloudnorm \
    resemble-perth s3tokenizer safetensors spacy-pkuseg transformers \
    "fastapi~=0.118" "uvicorn[standard]~=0.37" httpx soundfile
fi

if ! "${VENV_ROOT}/bin/python" -c "import spacy; spacy.load('en_core_web_sm')" >/dev/null 2>&1; then
  "${VENV_ROOT}/bin/python" -m spacy download en_core_web_sm
fi

if ! "${VENV_ROOT}/bin/python" -c "import accelerate, bitsandbytes" >/dev/null 2>&1; then
  uv pip install --python "${VENV_ROOT}/bin/python" "accelerate>=1.1" "bitsandbytes>=0.45"
fi

export PATH="${VENV_ROOT}/bin:${PATH}"
cd "${APP_ROOT}/app"

"${VENV_ROOT}/bin/python" -m uvicorn speech_gateway:app --host 127.0.0.1 --port 8890 \
  >"${APP_ROOT}/speech-gateway.log" 2>&1 &
gateway_pid=$!

"${PARLER_VENV_ROOT}/bin/python" -m uvicorn indic_gateway:app --host 127.0.0.1 --port 8892 \
  >"${APP_ROOT}/indic-gateway.log" 2>&1 &
indic_pid=$!

uvicorn dialog_gateway:app --host 127.0.0.1 --port 8891 \
  >"${APP_ROOT}/dialog-gateway.log" 2>&1 &
dialog_pid=$!

"${TRANSLATION_VENV_ROOT}/bin/python" -m uvicorn translation_gateway:app --host 127.0.0.1 --port 8893 \
  >"${APP_ROOT}/translation-gateway.log" 2>&1 &
translation_pid=$!

"${HINDI_VENV_ROOT}/bin/python" -m uvicorn hindi_gateway:app --host 127.0.0.1 --port 8894 \
  >"${APP_ROOT}/hindi-gateway.log" 2>&1 &
hindi_pid=$!

cleanup() {
  kill "${gateway_pid}" 2>/dev/null || true
  kill "${indic_pid}" 2>/dev/null || true
  kill "${dialog_pid}" 2>/dev/null || true
  kill "${translation_pid}" 2>/dev/null || true
  kill "${hindi_pid}" 2>/dev/null || true
  if [[ -n "${worker_pid:-}" ]]; then
    kill "${worker_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Uvicorn's speech startup hook loads both required English models. Registering
# the LiveKit worker before that finishes creates a connected room whose first
# greeting/STT requests time out, so readiness is deliberately fail-closed.
speech_ready=false
# Cold model loads can exceed 90 seconds when the pod volume is busy. Keep the
# worker fail-closed, but allow a realistic warm-up window before tearing down
# an otherwise healthy speech gateway.
for _attempt in $(seq 1 240); do
  if curl --fail --silent http://127.0.0.1:8890/health \
    | grep -q '"sttLoaded":true.*"englishTtsLoaded":true' \
    && curl --fail --silent http://127.0.0.1:8892/health \
    | grep -q '"loaded":true' \
    && curl --fail --silent http://127.0.0.1:8893/health \
    | grep -q '"loaded":true' \
    && curl --fail --silent http://127.0.0.1:8894/health \
    | grep -q '"loaded":true'; then
    speech_ready=true
    break
  fi
  sleep 1
done
if [[ "${speech_ready}" != "true" ]]; then
  echo "Speech gateways did not prewarm within 240 seconds" >&2
  exit 1
fi

python worker.py start &
worker_pid=$!
wait "${worker_pid}"
