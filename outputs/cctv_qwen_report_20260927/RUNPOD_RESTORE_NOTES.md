# RunPod CCTV Qwen pilot backup

Created before stopping the non-persistent RunPod on 2026-09-27.

## Saved locally

- `RunPod_phone_detc_backup_20260927.tar.gz`
  - Analysis and benchmark scripts
  - Qwen-only JSON results
  - Live-preview server and log
  - 68 annotated one-second audit frames
- `CCTV_Qwen_Activity_Audit_cam09_2026-08-28_172449.xlsx`
  - Summary, timings, track results, raw observations, and embedded audit frames

## Deliberately excluded

- Qwen model weights (download `Qwen/Qwen2.5-VL-3B-Instruct` again)
- Uploaded CCTV video copies (originals remain on the Cineframe SSD)
- Uploaded YOLO weights (originals remain in the local `PHONE_DETC` project)

## Environment used

- Python 3.12
- PyTorch 2.8.0 with CUDA 12.8
- Transformers 5.17.0
- Accelerate 1.15.0
- Ultralytics 8.4.163
- qwen-vl-utils 0.0.14
- OpenCV 5.0.0
- GPU: NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb

The pod had no persistent volume. Stopping it deletes the remote environment, but the saved files above are sufficient to reconstruct this pilot.
