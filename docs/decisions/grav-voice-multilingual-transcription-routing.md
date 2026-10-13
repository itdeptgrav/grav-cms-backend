# GRAV Voice — Multilingual Meeting Transcription Routing

**Decision status:** Superseded after benchmark — 10 October 2026  
**Scope:** Recorded GRAV Voice calls and uploaded meeting audio

> The three-lane router below records the benchmark history. It is not the
> production direction. Testing selected a single
> `bodhan-ai/indic-transcribe-flex` Romanized model with optional NVIDIA
> Sortformer diarization, centralised behind the private GRAV Speech API. See
> `docs/decisions/central-grav-speech-service.md`.

## Outcome sought

Produce a timestamped transcript for Hindi, English and Odia speech, including
mixed-language meetings. The final user-facing transcript is Roman script, but
the system retains the raw native-script transcript for audit and future review.

No proprietary transcription API, Qwen, generative post-editor or manual text
correction may alter the transcript.

## Candidate pipeline

```text
recording / uploaded audio
  -> normalize to mono 16 kHz
  -> speech segmentation (VAD timestamps)
  -> three-lane language routing
  -> specialist ASR per segment
  -> native transcript + deterministic Romanization
  -> timestamp-order merge
  -> transcript, language and confidence metadata
```

| Lane | Candidate model | Purpose | Licence |
| --- | --- | --- | --- |
| English | faster-whisper `large-v3-turbo` | English segments | MIT |
| Hindi / Hinglish | Oriserve `Whisper-Hindi2Hinglish-Apex` | Direct Roman Hindi/Hinglish ASR | Apache-2.0 |
| Odia | ARTPARK-IISc `whisper-large-v3-vaani-odia` | Native-script Odia ASR | Apache-2.0 |
| Odia Romanization | AI4Bharat IndicXlit native-to-Roman | Deterministic Odia-script to Roman output | MIT |
| Router | ARTPARK-IISc `Vaani-LID_v0`, calibrated to the three supported lanes | Segment routing | MIT |

## Routing contract

- Routing operates on VAD segments, not on the entire recording, so a Hindi
  speaker and an Odia speaker in one meeting can use different ASR lanes.
- The router is calibrated only to the three supported production lanes:
  `English`, `Hindi/Hinglish`, and `Odia` (including its Sambalpuri neighbour
  label). It must not treat a raw 42-language classifier label as a production
  language decision.
- A segment whose calibrated confidence or supported-lane coverage falls below
  the validated threshold is marked `uncertain`. It is processed by the Hindi
  and Odia lanes and retained for deterministic selection/review; it is never
  silently sent to an unrelated-language lane.
- Exact start and end timestamps come from the VAD segment manifest. The merge
  sorts these segments chronologically and does not use an LLM to rewrite text.

## Output contract

Each transcript segment stores:

```json
{
  "startSeconds": 0.0,
  "endSeconds": 0.0,
  "language": "odia",
  "routeConfidence": 0.0,
  "routeState": "confirmed | uncertain",
  "engine": "versioned model identifier",
  "nativeText": "raw ASR text when applicable",
  "romanText": "raw model or deterministic IndicXlit output"
}
```

English text remains unchanged. Hindi/Hinglish comes directly from the Apex
ASR's Roman output. Odia native text is preserved and only its Odia-script
tokens are transliterated through IndicXlit; Latin words remain Latin.

## Evidence and release gate

## Benchmark evidence — 9 October 2026

The candidate pipeline has the following recorded, machine-only evidence:

- The ARTPARK-IISc Odia ASR was validated on five official FLEURS Odia test
  clips: mean character error rate 10.08%. Its word error rate is less useful
  here because whitespace variants are counted as different tokens.
- The original uncalibrated 42-language LID labels were unsuitable as direct
  routing decisions: they mislabelled real Hinglish and dialect-adjacent Odia.
- A logistic-regression calibration trained only on 90 official, labelled
  FLEURS clips (30 per language) correctly routed all 30 held-out clips (10
  English, 10 Hindi and 10 Odia).
- The calibrated router then correctly routed all 11 external clips: five real
  GRAV Hindi/Hinglish meeting segments, five Odia clips excluded from the
  calibration set, and one independent English clip.
- A synthetic integration recording assembled from independent labelled English,
  real GRAV Hinglish and held-out Odia speech was automatically segmented,
  routed English → Hindi/Hinglish → Odia, transcribed by the three specialist
  lanes and timestamp-merged. The output preserves native Odia and its
  IndicXlit Roman form. No LLM touched the output.

The candidate is not production-approved until all are recorded:

1. a held-out, balanced official English/Hindi/Odia router validation result;
2. a real GRAV Hinglish meeting routing result;
3. at least one user-provided natural Odia recording acceptance result;
4. a combined three-language timestamp-merge test;
5. a documented uncertainty threshold and no silent fallback to an unsupported
   language;
6. privacy, retention, authorised playback and company-scoped access design
   consistent with the GRAV Voice recording boundary.

The benchmark artifacts stay outside the CMS repository. Only the verified
model identities, licences, routing threshold, output contract and acceptance
evidence belong in repository decisions.
