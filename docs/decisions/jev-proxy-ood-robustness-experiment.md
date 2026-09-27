# Jev proxy-OOD robustness experiment

Status: local proof complete; GPU experiment not yet authorised by evidence.

## Decision

Do not run another low-learning-rate safety correction against the rejected 9B
candidate. The next candidate, if launched, will be a fresh 9B proportional
run trained with independently judged semantic paraphrases made only from the
training view. Checkpoint selection will use both ordinary validation and a
separate proxy-OOD validation view.

This does not change the locked set, the release thresholds or the hybrid
Jev/Qwen accounting architecture. The final locked set remains a one-time
pass/fail measurement after the validation-only criterion succeeds.

## Evidence and hypothesis

The rejected 9B candidates fit ordinary validation and locked test much better
than locked OOD. The latest warm correction reached 91.36% route accuracy on
ordinary validation but only 78.48% over the complete locked set, including
66.42% on locked OOD. Safety-heavy sampling reduced unsafe argmax routes but
also reduced overall route accuracy.

The dataset generator deliberately reserves OOD frames and OOD rendering
styles for locked OOD. Ordinary validation therefore does not measure the
language shift that dominates the release failure. The hypothesis is that
training on label-preserving semantic variation while selecting on a separate
validation-only paraphrase view will improve language generalisation without
overweighting abstention labels or reading locked examples.

## Frozen-label augmentation contract

- Only train and validation source rows are accepted. Test and OOD rows fail
  closed.
- A pinned teacher may propose language only. It cannot provide a route,
  label, target, option, reason or other decision field.
- A separately pinned judge must approve semantic equivalence.
- Every accepted record is bound to the exact source-question hash, teacher
  and judge revisions, and both prompt hashes.
- Routes, arguments, options and targets are copied byte-for-byte from the
  source row.
- Numbers and explicit dates must be preserved.
- Duplicate and unchanged paraphrases are rejected.
- Validation paraphrases are marked as proxy-OOD and are never mixed silently
  into the ordinary validation metrics.

The intake and selection invariants are covered by deterministic local unit
tests. They do not prove model quality.

## Validation-only launch criterion

The next bounded GPU run is eligible for the one final locked evaluation only
if the selected checkpoint has all of the following on both ordinary
validation and proxy-OOD validation:

- route accuracy at least 90%;
- argument accuracy at least 96%;
- zero unsafe argmax routes;
- complete evaluation with no failed rows.

Checkpoint selection uses the weaker route, argument and safety accuracy of
the two validation views. Each unsafe argmax carries a dominating penalty so
an unsafe checkpoint cannot beat a safe checkpoint through a small accuracy
gain.

## Remaining work before GPU use

1. Pin immutable teacher and judge model revisions and prompts.
2. Generate and independently judge the train and validation paraphrase
   records without exposing labels to either generation output.
3. Build a training view whose manifest cryptographically binds the approved
   augmentation records and proxy-OOD partition.
4. Add the immutable experiment config and verify the complete proxy-OOD
   selection path with a CPU dry run.
5. Build and verify the experiment bundle, then pass the deterministic GPU
   backward preflight.

No GPU training starts until all five items pass. No production traffic is
routed by an experimental candidate.

