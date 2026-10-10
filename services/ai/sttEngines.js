"use strict";
/**
 * services/ai/sttEngines.js — which speech-to-text answers a spoken command.
 *
 *   1. Indic-Transcribe-Flex (Bodhan AI / AI4Bharat) on the RunPod GPU, when
 *      GRAV_INDIC_STT_URL is set — reached through an SSH tunnel, so the pod
 *      exposes nothing publicly. Built for Indian-accented English and Indian
 *      names; ~0.3 s a command on the pod's RTX 2000 Ada. Asked for English
 *      ("en") with digits kept as digits ("mixed") — measured best for
 *      Cmd/Ctrl K. Server: /root/grav-voice-stt/server.py on the pod.
 *   2. The local Whisper sidecar (services/ai/sttSidecar.js) — always there as
 *      the fallback: the pod stopped, the tunnel down, or an error or a slow
 *      answer (12 s) all fall through to it, so voice keeps working.
 *
 * Same contract for both: raw audio bytes in, { text } out.
 */

const { STT_URL } = require("./sttSidecar");

const INDIC_URL = String(process.env.GRAV_INDIC_STT_URL || "").replace(/\/$/, "");
const INDIC_TIMEOUT_MS = Number(process.env.GRAV_INDIC_STT_TIMEOUT_MS || 12000);
/* English, Hindi and Odia: a Hindi or Odia command comes back translated to
   English (what Cmd/Ctrl K reads) with what was said, in its own script, as
   `original` — translated on the pod by IndicTrans2 (indic_mt_server.py). */
const INDIC_LANGS = String(process.env.GRAV_INDIC_STT_LANGS || "en,hi,or");

async function postAudio(url, audio, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", ...headers },
      body: audio,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(`STT ${res.status}: ${detail.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return {
      text: typeof data.text === "string" ? data.text.trim() : "",
      original: typeof data.original === "string" && data.original.trim() ? data.original.trim() : null,
      lang: typeof data.lang === "string" ? data.lang : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Buffer} audio
 * @param {object} [opts]
 * @param {string} [opts.hotwords]  names Whisper is biased toward (Indic has no biasing)
 * @returns {Promise<{ text: string, original: string|null, lang: string|null, engine: "indic" | "whisper" }>}
 */
async function transcribeAudio(audio, { hotwords = "" } = {}) {
  if (INDIC_URL) {
    try {
      const out = await postAudio(`${INDIC_URL}/transcribe`, audio, { "X-Langs": INDIC_LANGS }, INDIC_TIMEOUT_MS);
      return { ...out, engine: "indic" };
    } catch (err) {
      console.warn("[AI] Indic STT unavailable, using Whisper:", err?.message || err, err?.cause?.code || "");
    }
  }
  const out = await postAudio(`${STT_URL}/transcribe`, audio, {
    "X-Hotwords": String(hotwords || "").replace(/[\r\n]+/g, " ").slice(0, 900),
  }, 30000);
  return { text: out.text, original: null, lang: "en", engine: "whisper" };
}

module.exports = { transcribeAudio, INDIC_URL };
