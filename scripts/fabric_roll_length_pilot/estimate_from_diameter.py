#!/usr/bin/env python3
"""Estimate roll geometry and optional length from calibrated diameters.

This is the simpler operational pilot. Absolute length is emitted only when an
effective packed layer pitch is explicitly supplied. The pitch should come from
an independently metered roll of the same material and winding process.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


def parse_pair(value: str) -> tuple[float, float]:
    parts = value.split(",")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("expected X,Y")
    return float(parts[0]), float(parts[1])


def parse_four(value: str) -> tuple[float, float, float, float]:
    parts = value.split(",")
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("expected X1,Y1,X2,Y2")
    return tuple(float(part) for part in parts)  # type: ignore[return-value]


def millimetres_per_pixel(points: tuple[float, float, float, float], distance_mm: float) -> float:
    x1, y1, x2, y2 = points
    pixel_distance = math.hypot(x2 - x1, y2 - y1)
    if pixel_distance <= 0 or distance_mm <= 0:
        raise ValueError("scale points must be distinct and distance must be positive")
    return distance_mm / pixel_distance


def annulus_area_mm2(
    outer_radii_px: tuple[float, float],
    core_radii_px: tuple[float, float],
    mm_per_px: float,
) -> tuple[float, float, float]:
    outer = math.pi * outer_radii_px[0] * outer_radii_px[1] * mm_per_px**2
    core = math.pi * core_radii_px[0] * core_radii_px[1] * mm_per_px**2
    if outer <= core:
        raise ValueError("outer area must exceed core area")
    return outer, core, outer - core


def length_from_area(area_mm2: float, effective_pitch_mm: float) -> float:
    if area_mm2 <= 0 or effective_pitch_mm <= 0:
        raise ValueError("area and effective pitch must be positive")
    return area_mm2 / (effective_pitch_mm * 1000.0)


def effective_pitch_from_known_length(area_mm2: float, known_length_m: float) -> float:
    if area_mm2 <= 0 or known_length_m <= 0:
        raise ValueError("area and known length must be positive")
    return area_mm2 / (known_length_m * 1000.0)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--center", type=parse_pair, required=True)
    parser.add_argument("--outer-radii", type=parse_pair, required=True)
    parser.add_argument("--core-radii", type=parse_pair, required=True)
    parser.add_argument("--scale-points", type=parse_four, required=True)
    parser.add_argument("--scale-distance-mm", type=float, required=True)
    parser.add_argument("--fabric-width-cm", type=float)
    calibration = parser.add_mutually_exclusive_group()
    calibration.add_argument("--effective-pitch-mm", type=float)
    calibration.add_argument("--known-length-m", type=float)
    args = parser.parse_args()

    image_path = Path(args.image).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    with Image.open(image_path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    cx, cy = args.center
    outer_rx, outer_ry = args.outer_radii
    core_rx, core_ry = args.core_radii
    if min(outer_rx, outer_ry, core_rx, core_ry) <= 0:
        raise SystemExit("all radii must be positive")

    scale = millimetres_per_pixel(args.scale_points, args.scale_distance_mm)
    outer_area, core_area, fabric_area = annulus_area_mm2(
        args.outer_radii, args.core_radii, scale
    )

    effective_pitch = args.effective_pitch_mm
    calibration_mode = "explicit_effective_pitch" if effective_pitch is not None else None
    if args.known_length_m is not None:
        effective_pitch = effective_pitch_from_known_length(fabric_area, args.known_length_m)
        calibration_mode = "derived_from_known_length"

    estimate = None
    if effective_pitch is not None:
        estimate = length_from_area(fabric_area, effective_pitch)

    draw = ImageDraw.Draw(image)
    draw.ellipse(
        (cx - outer_rx, cy - outer_ry, cx + outer_rx, cy + outer_ry),
        outline=(0, 90, 255),
        width=4,
    )
    draw.ellipse(
        (cx - core_rx, cy - core_ry, cx + core_rx, cy + core_ry),
        outline=(255, 40, 40),
        width=4,
    )
    annotated_path = output_dir / "diameter-geometry.jpg"
    image.save(annotated_path, quality=95)

    result = {
        "status": "estimate_requires_validation" if estimate is not None else "calibration_required",
        "accuracyClaimed": False,
        "image": str(image_path),
        "millimetresPerPixel": scale,
        "outerDiameterMm": [2 * outer_rx * scale, 2 * outer_ry * scale],
        "coreDiameterMm": [2 * core_rx * scale, 2 * core_ry * scale],
        "outerAreaMm2": outer_area,
        "coreAreaMm2": core_area,
        "fabricCrossSectionAreaMm2": fabric_area,
        "fabricWidthCm": args.fabric_width_cm,
        "fabricWidthUsedByDiameterMethod": False,
        "effectivePitchMm": effective_pitch,
        "calibrationMode": calibration_mode,
        "estimatedLengthM": estimate,
        "warning": (
            "Length depends directly on effective packed pitch; validate this roll family "
            "against independently metered rolls before inventory use."
        ),
        "annotatedImage": str(annotated_path),
    }
    (output_dir / "diameter-result.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
