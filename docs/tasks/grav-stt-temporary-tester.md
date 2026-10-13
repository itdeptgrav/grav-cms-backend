# Temporary multilingual transcription tester

## Purpose

Provide a localhost-only testing screen for the GRAV Voice transcription
prototype. A tester uploads one audio file and receives the unedited output of
a single open-source multilingual model.

## Scope

- Accept a local audio upload only.
- Copy the file to the existing private RunPod over the existing SSH key.
- Run one preloaded `bodhan-ai/indic-transcribe-flex` model. Its built-in
  decoder decides the transcription prompt and emits Romanized code-mixed
  output itself.
- Return the raw Roman transcript, the model's own initial language decision,
  model name, timing and long-form status.
- For recordings too long for a single decoder pass, use the model's shipped
  natural-pause chunker solely for audio-size safety. It must never choose
  separate language lanes.
- Bind only to `127.0.0.1`; do not expose an internet-facing endpoint.
- Keep a private, pod-loopback warm worker for latency testing. It loads the
  single Flex model once; the localhost UI uses that worker rather than
  cold-starting Python per upload.

## Explicit non-goals

- No CMS integration, database writes, Qwen usage, transcript clean-up, or
  production deployment.
- This is a diagnostic surface, not a production recording service.

## Production successor

This localhost tester remains a diagnostic client only. The approved shared
production boundary is the private GRAV Speech service described in
`docs/decisions/central-grav-speech-service.md`; its first implementation slice
is `docs/tasks/grav-speech-api-foundation.md`. Applications must consume that
API and must not copy this runner or load model weights themselves.

## Safety and operational rules

- One job at a time because the existing GPU has 16 GB VRAM and models are
  loaded serially.
- The warm worker must remain loopback-only and is strictly temporary. Its
  preload/memory result is a prototype measurement, not a production capacity
  commitment.
- The upload is limited to common audio/video containers and 150 MB.
- The user sees raw model output and its own language decision; no LLM rewrites
  it.

## Speaker diarization extension (validated 2026-10-10)

The preserved offline diarization runner is
`scripts/grav-stt-test-ui/diarization_runner.py`.

Pipeline:

1. Convert the source to mono 16 kHz PCM for consistent model input.
2. Use `nvidia/diar_sortformer_4spk-v1` to produce up to four speaker turns,
   including overlapping turns.
3. Transcribe every diarized turn independently with
   `bodhan-ai/indic-transcribe-flex` in its native Romanized mode.
4. Sort the untouched model results by timestamp. No LLM or manual transcript
   correction is allowed.

Validated evidence:

- A 65-second real call produced two speakers and retained an overlapping
  interval around 23 seconds.
- A 16.6-second English/Hindi/Odia reference produced three speakers and the
  expected Romanized language sequence.
- The public Sortformer checkpoint is cached locally at
  `.local-models/diar-sortformer-4spk-v1/` and the Flex model is cached at
  `.local-models/indic-transcribe-flex/`. Both directories are git-ignored.
- Raw benchmark JSON is kept under `.local-results/diarization/`, also
  git-ignored because recordings and transcripts may contain sensitive data.

The runner accepts either the public model ID or the saved `.nemo` file. To
force the fully local copy, set `GRAV_DIARIZER_MODEL` to
`.local-models/diar-sortformer-4spk-v1/diar_sortformer_4spk-v1.nemo` and
`GRAV_STT_MODEL_DIR` to `.local-models/indic-transcribe-flex` before running
it in a CUDA-capable environment with NeMo, PyTorch, torchaudio and ffmpeg.

Do not add automatic cross-speaker merging based on WavLM. In this benchmark,
its published default verification threshold incorrectly merged the two real
call participants. Do not apply a fixed known-speaker-count override unless
the recording source explicitly supplies that trusted metadata.
