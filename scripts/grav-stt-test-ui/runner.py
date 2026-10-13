#!/usr/bin/env python3
"""One-off, model-only runner for the localhost GRAV STT tester.

This lives on the private RunPod while the tester is active.  It deliberately
does not import CMS code or call an LLM: every field in its JSON comes from the
audio, the calibrated language router, or one of the named ASR models.
"""

import argparse
import gc
import json
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import librosa
import torch
from joblib import load
from transformers import (
    AutoFeatureExtractor,
    AutoModelForAudioClassification,
    AutoModelForSpeechSeq2Seq,
    AutoProcessor,
    GenerationConfig,
)

ROOT = Path("/workspace/grav-stt-benchmark")
ROUTER_MODEL = Path("/workspace/models/Vaani-LID_v0")
ROUTER_ARTIFACT = ROOT / "router-calibration" / "three-lane-router.joblib"
ODIA_MODEL = Path("/workspace/models/whisper-large-v3-vaani-odia")
ENGLISH_MODEL = "openai/whisper-large-v3-turbo"
ENGLISH_CACHE = "/root/.cache/huggingface/hub"
ENGLISH_PROCESSOR = Path("/workspace/models/whisper-large-v3-turbo-tokenizer")
HINDI_MODEL = "Oriserve/Whisper-Hindi2Hinglish-Apex"
HINDI_CACHE = "/root/hf-apex/hub"
INDICXLIT_ROOT = Path("/workspace/models/indicxlit-indic-en")
INDICXLIT_LANG_DICT = Path("/workspace/IndicXlit-master/inference/cli/indic-en/lang_list.txt")
ODIA_PATTERN = re.compile(r"[\u0B00-\u0B7F]")
CONFIRMED_CONFIDENCE = 0.60
CONFIRMED_MARGIN = 0.20
LID_WINDOW_SECONDS = 2.4
VAD_PHRASE_GAP_SECONDS = 0.25
MIN_SPEECH_SECONDS = 0.25
RUNTIME = {}


def command(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def duration(path):
    return float(
        subprocess.check_output(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(path),
            ],
            text=True,
        ).strip()
    )


def to_analysis_wav(source, destination):
    command([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(source),
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(destination),
    ])


def speech_segments(path):
    """Return VAD speech regions; these are not language-switch boundaries.

    Brief pauses improve ASR phrase alignment and exclude silence.  Continuous
    speech is still independently scanned by the fixed language-ID windows in
    ``route_segments`` below, so a language change never requires a pause.
    """
    whole_duration = duration(path)
    detected = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-i", str(path),
            "-af", f"silencedetect=noise=-50dB:d={VAD_PHRASE_GAP_SECONDS}", "-f", "null", "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=True,
    ).stdout
    events = []
    for match in re.finditer(r"silence_(start|end): ([0-9.]+)", detected):
        events.append((match.group(1), float(match.group(2))))

    silences, start = [], None
    for kind, point in events:
        if kind == "start":
            start = point
        elif start is not None:
            silences.append((start, point))
            start = None
    if start is not None:
        silences.append((start, whole_duration))

    regions, cursor = [], 0.0
    for silence_start, silence_end in silences:
        if silence_start - cursor >= MIN_SPEECH_SECONDS:
            regions.append((cursor, silence_start))
        cursor = max(cursor, silence_end)
    if whole_duration - cursor >= MIN_SPEECH_SECONDS:
        regions.append((cursor, whole_duration))
    if not regions and whole_duration >= 0.25:
        regions = [(0.0, whole_duration)]
    return [
        {"index": index, "startSeconds": round(start, 3), "endSeconds": round(end, 3)}
        for index, (start, end) in enumerate(regions)
    ]


def audio_segment(path, start, end):
    audio, _ = librosa.load(path, sr=16000, mono=True, offset=start, duration=end - start)
    return audio


def router_runtime():
    if "router" not in RUNTIME:
        artifact = load(ROUTER_ARTIFACT)
        extractor = AutoFeatureExtractor.from_pretrained(ROUTER_MODEL, trust_remote_code=True)
        model = AutoModelForAudioClassification.from_pretrained(
            ROUTER_MODEL, trust_remote_code=True, torch_dtype=torch.float16
        ).to("cuda").eval()
        RUNTIME["router"] = (artifact, extractor, model)
    return RUNTIME["router"]


def whisper_runtime(language):
    key = f"whisper:{language}"
    if key not in RUNTIME:
        source = ENGLISH_MODEL if language == "english" else HINDI_MODEL
        cache = ENGLISH_CACHE if language == "english" else HINDI_CACHE
        processor_source = ENGLISH_PROCESSOR if language == "english" else source
        processor = AutoProcessor.from_pretrained(processor_source, cache_dir=cache, local_files_only=True)
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            source, cache_dir=cache, local_files_only=True, torch_dtype=torch.float16,
            low_cpu_mem_usage=True, use_safetensors=True,
        ).to("cuda").eval()
        if language == "english":
            model.generation_config = GenerationConfig.from_pretrained(ENGLISH_PROCESSOR)
        else:
            model.generation_config.forced_decoder_ids = processor.get_decoder_prompt_ids(language="hi", task="transcribe")
        RUNTIME[key] = (source, processor, model)
    return RUNTIME[key]


def odia_runtime():
    if "odia" not in RUNTIME:
        processor = AutoProcessor.from_pretrained(ODIA_MODEL, local_files_only=True)
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            ODIA_MODEL, local_files_only=True, torch_dtype=torch.float16, low_cpu_mem_usage=True
        ).to("cuda").eval()
        model.config.forced_decoder_ids = None
        model.generation_config.forced_decoder_ids = None
        RUNTIME["odia"] = (processor, model)
    return RUNTIME["odia"]


def preload_runtime():
    """Load the production-test lanes once for a persistent worker."""
    started = time.monotonic()
    router_runtime()
    whisper_runtime("english")
    whisper_runtime("hindi")
    odia_runtime()
    return round(time.monotonic() - started, 3)


def route_segments(analysis_wav, segments):
    """Route speech with fixed language-ID windows, independent of pauses.

    Silence is used only to exclude non-speech from model work.  It is never a
    condition for a language boundary.  Each speech region is classified in
    short sequential audio windows, so Hindi → Odia → English can be detected
    even when the speaker switches mid-sentence without pausing.
    """
    artifact, extractor, model = router_runtime()
    classifier = artifact["classifier"]

    def classify(row):
        audio = audio_segment(analysis_wav, row["startSeconds"], row["endSeconds"])
        values = extractor(audio, sampling_rate=16000, return_tensors="pt")
        values = {
            key: value.to("cuda", dtype=torch.float16 if value.is_floating_point() else value.dtype)
            for key, value in values.items()
        }
        with torch.inference_mode():
            logits = model(**values).logits[0].float().cpu().numpy()[None, :]
        probabilities = classifier.predict_proba(logits)[0]
        ranked = sorted(zip(classifier.classes_, probabilities), key=lambda item: item[1], reverse=True)
        row["language"] = str(ranked[0][0]).lower()
        row["routeConfidence"] = round(float(ranked[0][1]), 6)
        row["routeMargin"] = round(float(ranked[0][1] - ranked[1][1]), 6)
        row["routeState"] = "confirmed" if (
            row["routeConfidence"] >= CONFIRMED_CONFIDENCE
            and row["routeMargin"] >= CONFIRMED_MARGIN
        ) else "uncertain"
        row["routeProbabilities"] = {
            str(key).lower(): round(float(value), 6)
            for key, value in zip(classifier.classes_, probabilities)
        }
        row["rankedLanguages"] = [str(key).lower() for key, _value in ranked]

    refined = []
    for original in segments:
        span = original["endSeconds"] - original["startSeconds"]
        if span <= LID_WINDOW_SECONDS:
            original["segmentationMethod"] = "speech-vad-region"
            classify(original)
            refined.append(original)
            continue

        # Non-overlapping windows deliberately preserve a one-to-one time
        # mapping into the final transcript.  Overlap would duplicate words at
        # the timestamp-order merge stage.
        cursor = original["startSeconds"]
        while cursor < original["endSeconds"] - 0.05:
            end = min(cursor + LID_WINDOW_SECONDS, original["endSeconds"])
            window = {
                "startSeconds": round(cursor, 3),
                "endSeconds": round(end, 3),
                "segmentationMethod": "fixed-lid-window",
            }
            classify(window)
            refined.append(window)
            cursor = end

    # Rejoin adjacent windows only when their independently detected language
    # agrees.  Retain the per-window evidence so the tester can show why a
    # boundary exists.
    merged = []
    for row in refined:
        previous = merged[-1] if merged else None
        if (
            previous
            and previous["language"] == row["language"]
            and previous["segmentationMethod"] == "fixed-lid-window"
            and row["segmentationMethod"] == "fixed-lid-window"
            and abs(previous["endSeconds"] - row["startSeconds"]) < 0.01
        ):
            previous["endSeconds"] = row["endSeconds"]
            previous["mergedRouteWindows"] = previous.get("mergedRouteWindows", 1) + 1
            continue
        merged.append(row)

    for index, row in enumerate(merged):
        row["index"] = index
    return merged


def transcribe_whisper_row(analysis_wav, row, language):
    source, processor, model = whisper_runtime(language)
    audio = audio_segment(analysis_wav, row["startSeconds"], row["endSeconds"])
    values = processor(audio, sampling_rate=16000, return_tensors="pt", return_attention_mask=True)
    kwargs = {"attention_mask": values.attention_mask.to("cuda"), "max_new_tokens": 256}
    if language == "english":
        kwargs.update({"language": "english", "task": "transcribe"})
    with torch.inference_mode():
        sequence = model.generate(values.input_features.to("cuda", dtype=torch.float16), **kwargs)
    transcript = processor.batch_decode(sequence, skip_special_tokens=True)[0].strip()
    return {
        "language": language,
        "engine": source,
        "nativeText": transcript if language == "english" else None,
        "romanText": transcript,
    }


def transcribe_whisper(analysis_wav, segments, language):
    for row in [row for row in segments if row["language"] == language]:
        row.update(transcribe_whisper_row(analysis_wav, row, language))


def romanize_odia(text):
    tokens = []
    for token in text.split():
        clean = re.sub(r"[^\u0B00-\u0B7F]", "", token)
        if clean and clean not in tokens:
            tokens.append(clean)
    if not tokens:
        return text
    prepared = "\n".join(" ".join(token) for token in tokens) + "\n"
    languages = ["as", "bn", "brx", "gom", "gu", "hi", "kn", "ks", "mai", "ml", "mni", "mr", "ne", "or", "pa", "sa", "sd", "si", "ta", "te", "ur"]
    run = subprocess.run(
        [
            "/root/indicxlit-venv/bin/fairseq-interactive", "corpus-bin", "--path", "transformer/indicxlit.pt",
            "--task", "translation_multi_simple_epoch", "--beam", "5", "--nbest", "1",
            "--source-lang", "or", "--target-lang", "en", "--encoder-langtok", "src",
            "--lang-dict", str(INDICXLIT_LANG_DICT), "--lang-pairs", ",".join(f"{lang}-en" for lang in languages),
            "--buffer-size", "64", "--batch-size", "32", "--cpu",
        ],
        cwd=INDICXLIT_ROOT,
        input=prepared,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=True,
    )
    outputs = {}
    for line in run.stdout.splitlines():
        if line.startswith("H-"):
            prefix, _, value = line.split("\t", 2)
            outputs.setdefault(int(prefix[2:]), "".join(value.split()))
    replacements = {token: outputs[index] for index, token in enumerate(tokens)}
    return " ".join(replacements.get(re.sub(r"[^\u0B00-\u0B7F]", "", token), token) for token in text.split())


def transcribe_odia_row(analysis_wav, row):
    processor, model = odia_runtime()
    audio = audio_segment(analysis_wav, row["startSeconds"], row["endSeconds"])
    values = processor(audio, sampling_rate=16000, return_tensors="pt", return_attention_mask=True)
    with torch.inference_mode():
        sequence = model.generate(
            values.input_features.to("cuda", dtype=torch.float16),
            attention_mask=values.attention_mask.to("cuda"), max_new_tokens=256,
        )
    native = processor.batch_decode(sequence, skip_special_tokens=True)[0].strip()
    return {
        "language": "odia",
        "engine": "ARTPARK-IISc/whisper-large-v3-vaani-odia + AI4Bharat/IndicXlit",
        "nativeText": native,
        "romanText": romanize_odia(native),
    }


def transcribe_odia(analysis_wav, segments):
    for row in [row for row in segments if row["language"] == "odia"]:
        row.update(transcribe_odia_row(analysis_wav, row))


def transcribe_uncertain_alternatives(analysis_wav, segments):
    """Preserve competing model-only outputs for low-confidence routing.

    We never silently replace an uncertain primary transcript with an LLM
    guess. The tester returns both top lane outputs as audit evidence; a later
    trained arbitration policy can choose between them deterministically.
    """
    for row in [row for row in segments if row["routeState"] == "uncertain"]:
        alternatives = []
        for language in row["rankedLanguages"][:2]:
            if language == row["language"]:
                alternatives.append({
                    "language": language,
                    "engine": row["engine"],
                    "nativeText": row.get("nativeText"),
                    "romanText": row.get("romanText", ""),
                    "selectedByRouter": True,
                })
            elif language == "odia":
                candidate = transcribe_odia_row(analysis_wav, row)
                candidate["selectedByRouter"] = False
                alternatives.append(candidate)
            else:
                candidate = transcribe_whisper_row(analysis_wav, row, language)
                candidate["selectedByRouter"] = False
                alternatives.append(candidate)
        row["alternateLaneResults"] = alternatives
        row["finalState"] = "needs-arbitration"


def transcribe_file(input_path, output_path):
    """Run one job using any models already retained in ``RUNTIME``."""
    started = time.monotonic()
    source, output = Path(input_path), Path(output_path)
    if not source.is_file():
        raise ValueError("Input file does not exist")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="grav-stt-") as temp:
        analysis_wav = Path(temp) / "analysis.wav"
        to_analysis_wav(source, analysis_wav)
        segments = route_segments(analysis_wav, speech_segments(analysis_wav))
        transcribe_whisper(analysis_wav, segments, "english")
        transcribe_whisper(analysis_wav, segments, "hindi")
        transcribe_odia(analysis_wav, segments)
        transcribe_uncertain_alternatives(analysis_wav, segments)
        segments.sort(key=lambda row: row["startSeconds"])
        result = {
            "architecture": [
                "phrase-level VAD for ASR alignment; language switches do not depend on silence",
                "ARTPARK-IISc/Vaani-LID_v0 calibrated to English/Hindi/Odia",
                "fixed 2.4-second language-ID windows with timestamp-order merge",
                "Whisper large-v3-turbo English lane",
                "Oriserve Whisper-Hindi2Hinglish-Apex Hindi/Hinglish lane",
                "ARTPARK-IISc whisper-large-v3-vaani-odia Odia lane",
                "AI4Bharat IndicXlit Odia native-to-Roman",
                "timestamp-ordered deterministic merge",
            ],
            "manualOrLlmEditing": False,
            "processedAt": datetime.now(timezone.utc).isoformat(),
            "processingSeconds": round(time.monotonic() - started, 3),
            "durationSeconds": round(duration(analysis_wav), 3),
            "segments": segments,
            "romanTranscript": " ".join(row.get("romanText", "") for row in segments).strip(),
        }
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--preload", action="store_true")
    args = parser.parse_args()
    preload_seconds = preload_runtime() if args.preload else None
    result = transcribe_file(args.input, args.output)
    print(json.dumps({
        "success": True,
        "output": str(args.output),
        "segments": len(result["segments"]),
        "preloadSeconds": preload_seconds,
        "processingSeconds": result["processingSeconds"],
    }))


if __name__ == "__main__":
    main()
