# AI Interview — Qwen3 32B Feasibility Probe

**Date:** 10 October 2026  
**Status:** Development evidence only; not production-approved  
**Model:** `qwen3:32b`, 32.8B parameters, `Q4_K_M`  
**Runtime:** Private Ollama service on the existing RunPod A40, reached through
an SSH tunnel bound to local loopback

## Purpose

Test whether the existing private Qwen runtime is a credible candidate for two
separate AI-interview duties:

1. asking a short, relevant follow-up during a structured Chartered Accountant
   pre-screen; and
2. proposing criterion-level scores from a supplied expert rubric and exact
   candidate-answer evidence.

The probe used synthetic answers and no candidate or employee data.

## Environment recovery

The replacement RunPod retained `/workspace/ollama-models` and the A40 GPU but
did not retain the ephemeral Ollama executable. With owner approval, the
official Ollama installer restored the runtime. The service remained bound to
`127.0.0.1` on the pod; it was not exposed publicly. The local connection also
remained loopback-only.

The restored runtime reported:

- model: `qwen3:32b`;
- parameter size: 32.8B;
- quantisation: `Q4_K_M`;
- context length reported by the installed artifact: 40,960 tokens;
- GPU: NVIDIA A40, approximately 44.4 GiB visible VRAM.

## Probe results

### 1. Positive accounting answer, non-thinking scoring

The candidate answer refused premature revenue recognition, checked the
purchase order, contract, delivery evidence and customer acceptance, explained
the revenue/profit and audit effect, and proposed escalation.

Qwen returned schema-valid criterion scores and a plausible 10/10 total. It
made one evidence-grounding error: for the rubric's transaction-documentation
criterion it cited `document my objection`, rather than the transaction
documents named earlier in the answer. The numerical outcome was plausible,
but the cited evidence did not prove that exact criterion.

Measured request:

- total: approximately 103.8 seconds;
- model load: approximately 75.7 seconds;
- prompt: 267 tokens;
- generation: 518 tokens.

### 2. Unsafe accounting answer, non-thinking scoring

The synthetic answer proposed recording revenue before delivery and completing
delivery documents afterward.

Qwen correctly gave zero on recognition risk, verification, refusal,
escalation and financial-statement effect. It incorrectly awarded the
documentation point because the words `delivery documents` appeared, despite
their meaning being contrary to the rubric. It also returned confidence `1`
and `requiresHumanReview: false`.

This is a material false positive and proves that keyword-like evidence
matching and model self-confidence cannot be accepted as authority.

Measured warm request:

- total: approximately 20.9 seconds;
- model load: approximately 0.6 seconds;
- prompt: 258 tokens;
- generation: 372 tokens.

### 3. Unsafe answer, contradiction-aware thinking-mode scoring

The prompt was tightened so that mentioning evidence earns no point unless the
answer requires that evidence before recognition, and contradictions cancel a
point. Thinking mode then returned 0/10 and explicitly explained that delivery
documents completed afterward do not satisfy the criterion.

Measured warm request:

- total: approximately 36.9 seconds;
- prompt: 276 tokens;
- generation, including reasoning: 702 tokens.

The correction is promising, but one repaired example is not a reliability
benchmark. The model's reported confidence remains uncalibrated and must not be
used as a release gate.

### 4. Warm live follow-up

With thinking disabled and output limited to one question of at most 25 words,
Qwen asked:

> What specific audit documentation would you prepare to support this conclusion?

Measured request:

- wall time: approximately 1.46 seconds;
- model load: approximately 15 milliseconds;
- prompt: 77 tokens;
- output: 13 tokens.

This is suitable latency for a warm development interview loop. Cold-start
latency is not suitable for a scheduled interview, so the runtime must pass a
warm-up health gate before a candidate can enter a session.

## Conclusion

`qwen3:32b` is accepted as the **candidate model for an AI-interview
development spike**:

- non-thinking mode may select or phrase short live follow-ups within an
  approved interview plan;
- thinking mode may propose post-interview criterion scores;
- server code must validate criterion IDs, ranges and exact evidence spans;
- model self-confidence is not trusted;
- no AI score may automatically reject a candidate;
- the scoring path is not production-approved until it is benchmarked against
  independently scored answers from qualified subject-matter experts.

## Required next evidence

1. An SME-approved CA competency map, question set and scoring rubric.
2. At least 100 anonymised answers independently scored by two qualified CAs.
3. Criterion-level agreement, false-positive and false-negative measurements.
4. Repeatability tests across multiple model runs.
5. English and Hinglish transcript tests, including uncertain ASR spans.
6. A fixed warm-up and health gate before every scheduled interview.
7. Candidate consent, retention, access and human-review requirements.

