# Meeting-aware transcript correction

## Decision

Transcript correction must derive its context from the meeting being processed,
not from an industry glossary, tenant vocabulary, or phrase-replacement table.

The correction pipeline has three independently auditable stages:

1. It builds a temporary meeting model from the noisy transcript in short
   segments and synthesises those observations into one meeting context.
2. It asks an editor to propose only narrow, high-confidence repairs using the
   raw utterance, nearby conversation, and that inferred context.
3. A separate verifier accepts or rejects every proposed edit. Local guards
   additionally prohibit automatic number changes and broad paraphrases.

Raw ASR is preserved beside all accepted edits. No model output may silently
replace the source transcript.

## Consequences

The system can recognise that a seemingly nonsensical word may be an
acoustically confused domain term when the meeting itself supports that
interpretation. It cannot invent terminology merely because a generic industry
dictionary suggests it. Uncertain text remains raw rather than being guessed.
