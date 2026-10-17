# Recording 5 — STT and diarization quality audit

**Date:** 15 October 2026  
**Input:** `Recording (5).m4a` (34:25)  
**Machine result:** 438 raw turns across four Sortformer channels

## Finding

The transcript is broadly usable, but the remaining errors are structural and
must not be repaired by asking a language model to guess better words.

The clearest example is the readable paragraph fragment:

`Okay Mera naam Venkatagiriya O Daang Rapping`

That text was not one confident sentence. It came from four separate Speaker 2
turns from 40.160–51.440 seconds. One was only 0.64 seconds (`O`). The original
document renderer joined the guesses because the speaker label was the same and
the gaps were short. It thereby hid the uncertainty and made the output look
more coherent than the audio evidence supported.

## Root problems

1. **Micro-turn hallucination.** The ASR runtime pads audio shorter than one
   second before decoding. Noise, clipped words and overlap can therefore turn
   into plausible-looking tokens.
2. **Unsafe long-turn decoding.** At least one diarizer turn exceeded the
   model's approximately 30-second context. Direct decoding can collapse into
   repeated words; the supplied transcript contains visible repetition loops.
3. **Weak language decisions on tiny clips.** Per-turn automatic language
   identification repeatedly considered unsupported Urdu. A short noisy slice
   is not enough evidence for unconstrained language routing.
4. **Speaker over-segmentation.** Speaker 4 has one 0.7-second turn. That is a
   weak acoustic channel hypothesis, not evidence of a fourth participant.
   Speaker 3 has six turns totalling about 11 seconds and needs targeted audio
   review before it is treated as a stable person label.
5. **Presentation hid uncertainty.** Joining adjacent same-speaker output into
   paragraphs erased the boundaries needed to understand the above failures.

## Implemented correction

- Preserve immutable `rawRomanText` and every raw timestamp boundary.
- Use pause-aware safe splitting for turns beyond the ASR context window.
- Constrain automatic language selection to English, Hindi and Odia.
- Flag unreliable short audio, isolated micro-utterances, implausible word
  rates, low lexical diversity, decoder repetition and weak speaker channels.
- Build a separate utterance context view without deleting its constituent
  turns.
- Re-cut a suspicious collection of fragments as one bounded audio window and
  run ASR again, so the model hears the whole phrase instead of padded shards.
- Treat numbers, dates, quantities, amounts and dimensions as high-risk facts:
  preserve every candidate value, re-decode contextual audio, and block
  structured extraction on disagreement. `point five` is never auto-expanded
  to `one point five`.
- Optionally ask a private Qwen-compatible reasoner only whether the contextual
  span is coherent, uncertain or gibberish and which verbatim ASR candidate is
  better supported. It cannot suggest replacement text or combine candidates.
- Refuse trusted-paragraph presentation when either deterministic or semantic
  evidence fails. If candidate disagreement remains, show `[unclear audio]`
  with the raw candidates available to an authorised reviewer.

## Verification

The new deterministic pass reproduces the example above as
`utterance-0004`, retains turn indexes 6–9, and marks it `uncertain` due to an
isolated sub-second fragment. Four focused unit tests cover repetition,
micro-speaker evidence, boundary-preserving contextual grouping and the
reasoner's no-rewrite input contract.

This closes the false-confidence path. A fresh GPU run is still required to
produce a revised Word artifact and measure how many uncertain spans remain.

## Focused GPU re-run: 00:00–02:06

The quality-gated speaker-aware runner completed on 15 October in 91.687
seconds: 126 seconds of audio, two inferred speakers, 37 raw speaker turns and
11 derived review windows. The optional semantic service was not configured for
this run, so only the deterministic gate executed; this is intentionally
reported as `semanticReasoner.status: disabled`, not disguised as a successful
semantic review.

The output gives concrete evidence for the next recovery test:

- Around 40–70 seconds, ASR emitted both `a islander` / `Hailand` and the
  independently supported nearby form `Highlander`. This is an entity conflict,
  not a licence to replace the first raw words silently.
- The same window emitted `Halftime stores hai`, which is not a coherent retail
  statement. Earlier diarized evidence contains `Offline stores hain`; a
  contextual recovery must select only that actual ASR candidate if it recurs.
- `five stores in Dubai` and `eighteen to twenty lakhs pieces per month` are
  business facts. They remain evidence candidates until numeric corroboration,
  not database-ready values.

The required next configuration is a private semantic verifier plus the
tenant's domain vocabulary (for example `Highlander`). It will flag the entity
conflict and incoherent business phrase, trigger the widened contextual
acoustic re-decode, and retain every raw candidate with provenance.
