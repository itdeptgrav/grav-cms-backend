# CCTV phone-use cascade — 12 GB VRAM profile

Date: 13 October 2026  
Scope: feasibility evidence for PU-05 and PU-08; not an accuracy or production
acceptance result.

## Outcome

The proposed six-model production stack loaded concurrently and completed one
inference through every stage while PyTorch enforced an 11.5 GiB per-process
CUDA allocation cap. The joint run peaked at **8.172 GiB allocated** and
**8.426 GiB reserved**, leaving 3.074 GiB of the 11.5 GiB engineering budget.

The resident stack was:

- Qwen2.5-VL 3B in BF16 as the candidate semantic verifier;
- YOLO11x person detector;
- YOLO11x Pose;
- the `phone-v5` proposal checkpoint;
- the `phone-model2` proposal checkpoint; and
- MViT V2 S with the Kinetics-400 head for temporal-action features.

Qwen3-VL 8B BF16 remains an offline teacher/evaluation model and is not part of
the 12 GB production stack.

## Measurements

| Profile | Peak allocated | Peak reserved | Cold wall time | First inference | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| YOLO11x person | 0.382 GiB | 0.449 GiB | 23.164 s | 5.4682 s | Pass |
| YOLO11x Pose | 0.389 GiB | 0.469 GiB | 22.760 s | 5.5838 s | Pass |
| `phone-v5` | 0.157 GiB | 0.172 GiB | 15.543 s | 3.8113 s | Pass |
| `phone-model2` | 0.157 GiB | 0.172 GiB | 15.126 s | 3.7046 s | Pass |
| MViT V2 S | 0.401 GiB | 0.627 GiB | 3.616 s | 0.3064 s | Pass |
| Qwen2.5-VL 3B BF16 | 7.163 GiB | 7.402 GiB | 152.827 s | 0.5487 s | Pass |
| All six resident | **8.172 GiB** | **8.426 GiB** | 187.987 s | Qwen: 0.3855 s | **Pass** |

Cold timings include model construction, network-volume reads and first-kernel
costs; they do not represent steady-state throughput. The joint smoke input
produced four person detections, one pose result, one proposal from each phone
checkpoint, a 400-class action vector and a valid one-token verifier response.

## Test controls and limitations

- Hardware was an NVIDIA A40 with 46 GiB physical VRAM. The test constrained
  the PyTorch process with `torch.cuda.set_per_process_memory_fraction()` to an
  11.5 GiB allowance. This proves the stack respects that allocator ceiling;
  it does **not** replace final validation on the exact 12 GB deployment GPU.
- The result is a resident-model smoke test, not a representative multi-person
  replay. PU-08 must still measure decode buffers, batching, concurrent
  candidates, overlays, queues and non-PyTorch CUDA consumers.
- A 3.074 GiB budget margin is useful but not permission for unbounded batches.
  Production must keep batch sizes and candidate queues bounded and expose
  current/peak VRAM, queue depth and dropped-stale-candidate counts.
- No accuracy conclusion follows from this profile. Release remains blocked by
  the frozen camera-matched holdout and event-level quality gates.

## Architecture consequence

The initial worker may keep all six selected models resident. It does not need
to unload/reload Qwen between candidates. Inference is still scheduled: cheap
quality/tracking/proposal stages run first, and the semantic verifier receives
only candidate or conflicting windows. If representative PU-08 replay exceeds
11.5 GiB, the permitted fallback is a measured bounded scheduler or smaller
verified model—not silent model substitution or relaxed memory reporting.

## Reproducibility evidence

The executed profiler and raw logs are retained on the authorised RunPod at:

- `/workspace/phone_detc_pilot/cascade_v1/src/profile_models_12gb.py`
- `/workspace/phone_detc_pilot/cascade_v1/qwen3b-profile.log`
- `/workspace/phone_detc_pilot/cascade_v1/joint-profile.log`

The RunPod is replaceable compute, so these paths are supporting evidence rather
than the sole durable record. This audit preserves the measured decision in the
repository.
