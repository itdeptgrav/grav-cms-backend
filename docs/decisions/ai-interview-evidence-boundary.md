# Decision: evidence-bound AI interview assistance

**Status:** accepted for prototype  
**Date:** 2026-10-10

Qwen 3 32B may evaluate the content of an interview answer against a human-authored rubric, identify answer-level contradictions, and suggest follow-up questions. Its output is advisory and cannot advance, reject, rank, or otherwise change a candidate record.

Qwen also controls the bounded conversational transition: it creates the opening welcome, acknowledges substantive answers without signalling correctness, and chooses whether to ask a rubric-grounded follow-up or advance. The initial self-introduction is rapport-building context and is excluded from scoring and the final evidence report. Repeat requests remain deterministic and unscored.

Video and voice are evidence-capture channels, not personality sensors. The product records or transcribes only with consent and may report objective technical facts such as duration, whether audio/video tracks existed, transcript confidence when supplied, and explicitly marked interruptions. It will not score nervousness, suspicion, honesty, emotion, gaze, accent, personality, health, disability, or protected traits.

Hosted Bodhan Indic-Speak is the candidate-facing text-to-speech provider. The backend owns the API key, fixed `indic-speak` model, language mapping, and voice allowlist; browsers send only question text, a supported language choice, and a server-approved voice ID. English and Hindi use `en` and `hi`; the product's Odia choice maps server-side to Indic-Speak's `or` code. VoiceStudio/Kokoro and Sarvam are retired from the candidate-facing path. The prototype remains release-blocked pending employment, consent, privacy, provider-terms, and AI-governance review.

Natural delivery is presentation metadata, not assessment evidence. Qwen may emit only the server allowlist of warmth, professional/explanatory/excited/neutral styles and short/standard/long pauses. The backend translates styles into provider request instructions and pauses into bounded PCM silence before returning one WAV. These cues are never inferred from the candidate, never added to the raw transcript, and never affect rubric scores.

Speech-to-text uses the existing `services/ai/gravSpeechClient.js` and central private GRAV Speech API. The application signs raw answer audio with service `hr-interview` and a company identity derived from exactly one active server-side HR company grant. Until HR company grants are populated, the legacy single-company deployment may derive the sole active `Acc_Company`; zero or multiple matches fail closed. It does not accept company IDs, audio object keys, model names, or callback URLs from the browser. The raw `romanTranscript` is displayed without rewriting and is the text passed to Qwen.

Runtime settings:

- `INTERVIEW_OLLAMA_BASE_URL` (falls back to `OLLAMA_BASE_URL`)
- `INTERVIEW_OLLAMA_MODEL` (defaults to `qwen3:32b`)
- `INTERVIEW_OLLAMA_TIMEOUT_MS` (defaults to 120 seconds)
- `BODHAN_API_KEY` (required and server-side only)
- `BODHAN_API_URL` (defaults to `https://api.bodhan.ai/v1`)
- `BODHAN_TTS_MODEL` (defaults to `indic-speak`; server-controlled)
- `BODHAN_TTS_VOICE` (defaults to `Kavya`)
- `BODHAN_TTS_TIMEOUT_MS`
- `GRAV_SPEECH_API_URL=http://private-grav-speech-origin:8097`
- `GRAV_SPEECH_SHARED_SECRET` supplied by the private workload environment
