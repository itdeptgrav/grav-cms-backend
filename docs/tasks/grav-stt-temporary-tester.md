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
  model name, timing, long-form status and evidence-preserving quality flags.
- For recordings too long for a single decoder pass, use the model's shipped
  natural-pause chunker solely for audio-size safety. It must never choose
  separate language lanes.
- Bind only to `127.0.0.1`; do not expose an internet-facing endpoint.
- Keep a private, pod-loopback warm worker for latency testing. It loads the
  single Flex model once; the localhost UI uses that worker rather than
  cold-starting Python per upload.

## Explicit non-goals

- No CMS integration, database writes, transcript clean-up, or production
  deployment. A configured private Qwen-compatible endpoint may classify a
  transcript span as coherent, uncertain or gibberish, but cannot produce or
  replace transcript text.
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
3. Transcribe every diarized turn with `bodhan-ai/indic-transcribe-flex` in its
   native Romanized mode. Use its pause-aware long-form helper whenever a turn
   exceeds the decoder's trained context window.
4. Preserve each untouched result as `rawRomanText`, exact timestamps and the
   model language decision.
5. Add deterministic flags for unreliable micro-turns, word-rate anomalies,
   low lexical diversity, repetition loops and weak diarizer-channel evidence.
6. Group only a derived, bounded meeting-context window for semantic quality
   classification; never discard the underlying turn boundaries or let the
   classifier rewrite words.
7. Re-cut any flagged window from the normalized source and decode it again as
   one contextual utterance. The reasoner may select only an exact recorded ASR
   candidate; it cannot compose a third transcript.
8. Use bounded meeting context to flag incoherent business phrases and entity
   conflicts. A versioned tenant glossary may support an additional derived
   display annotation only when Qwen selects a closed glossary ID and a
   deterministic literal-span/phonetic guard accepts it. The raw ASR text and
   structured facts are never altered.

Set `GRAV_TRANSCRIPT_REASONER_URL` to a private OpenAI-compatible service to
enable semantic classification. `GRAV_TRANSCRIPT_REASONER_MODEL` defaults to
`Qwen/Qwen3-4B-Instruct-2507`; an optional private bearer token is read from
`GRAV_TRANSCRIPT_REASONER_KEY`. With no URL, deterministic checks still run and
the result explicitly reports that semantic verification was disabled.

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

## Long-recording failure reproduced — 15 October 2026

The 34-minute supplied recording exposed three root defects in the first
diarized transcript path:

- turns shorter than one second were padded by the ASR runtime and decoded as
  words even when they were noise, overlap or a clipped backchannel;
- turns longer than the model's context limit bypassed the shipped safe
  long-form decoder and could collapse into repeated words; and
- the Word renderer joined adjacent same-speaker guesses into fluent-looking
  paragraphs, hiding their weak evidence.

The visible example `Okay Mera naam Venkatagiriya O Daang Rapping` is four raw
turns from 40.160–51.440 seconds, including a 0.64-second isolated `O`. The new
gate retains all four turns and their raw text, but marks the combined review
window `uncertain`. This is the intended behavior until a second audio decode
or human review resolves it; a language model must not invent a correction.
