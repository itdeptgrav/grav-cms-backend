#!/usr/bin/env python3
"""Research-only fabric roll layer analyser.

The analyser deliberately separates observable geometry from an accuracy claim.
It can propose likely wrap boundaries and, when given a physical image scale,
convert the proposed perimeters to metres. It cannot establish metrological
accuracy without comparison against independently measured rolls.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import cv2
import numpy as np
from PIL import Image, ImageOps


@dataclass(frozen=True)
class Geometry:
    center_x: float
    center_y: float
    outer_radius_x: float
    outer_radius_y: float
    inner_fraction: float


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


def parse_ranges(value: str) -> list[tuple[float, float]]:
    ranges: list[tuple[float, float]] = []
    if not value.strip():
        return ranges
    for item in value.split(","):
        parts = item.split(":")
        if len(parts) != 2:
            raise argparse.ArgumentTypeError("expected START:END ranges")
        ranges.append((float(parts[0]) % 360.0, float(parts[1]) % 360.0))
    return ranges


def load_rgb(path: Path) -> np.ndarray:
    """Load JPEG/PNG/TIFF/DNG through Pillow and honor orientation metadata."""
    with Image.open(path) as image:
        oriented = ImageOps.exif_transpose(image).convert("RGB")
        return np.asarray(oriented)


def validate_geometry(image: np.ndarray, geometry: Geometry) -> None:
    height, width = image.shape[:2]
    if not (0 <= geometry.center_x < width and 0 <= geometry.center_y < height):
        raise ValueError("roll center must be inside the image")
    if geometry.outer_radius_x <= 0 or geometry.outer_radius_y <= 0:
        raise ValueError("outer radii must be positive")
    if not (0 <= geometry.inner_fraction < 1):
        raise ValueError("inner fraction must be in [0, 1)")
    if (
        geometry.center_x - geometry.outer_radius_x < 0
        or geometry.center_x + geometry.outer_radius_x >= width
        or geometry.center_y - geometry.outer_radius_y < 0
        or geometry.center_y + geometry.outer_radius_y >= height
    ):
        raise ValueError("the configured outer ellipse must fit inside the image")


def millimetres_per_pixel(
    scale_points: tuple[float, float, float, float] | None,
    scale_distance_mm: float | None,
) -> float | None:
    if scale_points is None and scale_distance_mm is None:
        return None
    if scale_points is None or scale_distance_mm is None:
        raise ValueError("scale points and scale distance must be supplied together")
    if scale_distance_mm <= 0:
        raise ValueError("scale distance must be positive")
    x1, y1, x2, y2 = scale_points
    distance_px = math.hypot(x2 - x1, y2 - y1)
    if distance_px <= 0:
        raise ValueError("scale points must be distinct")
    return scale_distance_mm / distance_px


def angle_mask(angle_count: int, excluded_ranges: Sequence[tuple[float, float]]) -> np.ndarray:
    angles = np.arange(angle_count, dtype=np.float32) * 360.0 / angle_count
    included = np.ones(angle_count, dtype=bool)
    for start, end in excluded_ranges:
        if start <= end:
            included &= ~((angles >= start) & (angles <= end))
        else:
            included &= ~((angles >= start) | (angles <= end))
    return included


def elliptical_polar_unwrap(
    image_rgb: np.ndarray,
    geometry: Geometry,
    angle_count: int = 1440,
    radius_count: int | None = None,
) -> np.ndarray:
    """Map nested ellipses to rows of angle x columns of normalized radius."""
    if radius_count is None:
        radius_count = max(256, int(round(max(geometry.outer_radius_x, geometry.outer_radius_y))))
    theta = np.linspace(0.0, 2.0 * math.pi, angle_count, endpoint=False, dtype=np.float32)
    radial = np.linspace(
        geometry.inner_fraction,
        1.0,
        radius_count,
        endpoint=True,
        dtype=np.float32,
    )
    map_x = geometry.center_x + np.cos(theta)[:, None] * geometry.outer_radius_x * radial[None, :]
    map_y = geometry.center_y + np.sin(theta)[:, None] * geometry.outer_radius_y * radial[None, :]
    return cv2.remap(
        image_rgb,
        map_x.astype(np.float32),
        map_y.astype(np.float32),
        interpolation=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )


def smooth_profile(profile: np.ndarray, sigma: float = 1.5) -> np.ndarray:
    width = max(3, int(round(sigma * 6)) | 1)
    return cv2.GaussianBlur(profile.reshape(1, -1), (width, 1), sigmaX=sigma).reshape(-1)


def detect_profile_peaks(
    profile: np.ndarray,
    min_spacing: int,
    threshold_mad: float,
) -> list[int]:
    """Deterministic non-maximum suppression over a robust threshold."""
    smoothed = smooth_profile(profile)
    median = float(np.median(smoothed))
    mad = float(np.median(np.abs(smoothed - median)))
    robust_sigma = max(1e-6, 1.4826 * mad)
    threshold = median + threshold_mad * robust_sigma
    candidates = [
        index
        for index in range(1, len(smoothed) - 1)
        if smoothed[index] >= threshold
        and smoothed[index] >= smoothed[index - 1]
        and smoothed[index] > smoothed[index + 1]
    ]
    accepted: list[int] = []
    for index in sorted(candidates, key=lambda item: float(smoothed[item]), reverse=True):
        if all(abs(index - prior) >= min_spacing for prior in accepted):
            accepted.append(index)
    return sorted(accepted)


def ellipse_perimeter(radius_x: float, radius_y: float) -> float:
    """Ramanujan's second approximation, adequate for diagnostic geometry."""
    if radius_x <= 0 or radius_y <= 0:
        raise ValueError("ellipse radii must be positive")
    h = ((radius_x - radius_y) ** 2) / ((radius_x + radius_y) ** 2)
    return math.pi * (radius_x + radius_y) * (
        1.0 + (3.0 * h) / (10.0 + math.sqrt(4.0 - 3.0 * h))
    )


def candidate_length_pixels(
    peaks: Iterable[int],
    radius_count: int,
    geometry: Geometry,
) -> float:
    if radius_count < 2:
        raise ValueError("radius count must be at least two")
    total = 0.0
    span = 1.0 - geometry.inner_fraction
    for peak in peaks:
        fraction = geometry.inner_fraction + span * peak / (radius_count - 1)
        total += ellipse_perimeter(
            geometry.outer_radius_x * fraction,
            geometry.outer_radius_y * fraction,
        )
    return total


def layer_signal_quality(
    gradient: np.ndarray,
    included_angles: np.ndarray,
    peaks: Sequence[int],
) -> tuple[str, float]:
    if not peaks or not np.any(included_angles):
        return "insufficient", 0.0
    selected = gradient[included_angles]
    per_angle_cutoff = np.percentile(selected, 70, axis=1)
    coverage = [float(np.mean(selected[:, peak] >= per_angle_cutoff)) for peak in peaks]
    median_coverage = float(np.median(coverage))
    if median_coverage >= 0.65:
        label = "strong"
    elif median_coverage >= 0.45:
        label = "moderate"
    else:
        label = "weak"
    return label, median_coverage


def sector_candidates(
    gradient: np.ndarray,
    included_angles: np.ndarray,
    geometry: Geometry,
    sector_width_degrees: float,
    min_spacing: int,
    threshold_mad: float,
) -> list[dict[str, object]]:
    """Detect radial peaks locally so irregular wraps do not cancel globally."""
    angle_count, radius_count = gradient.shape
    sector_rows = max(3, int(round(angle_count * sector_width_degrees / 360.0)))
    sectors: list[dict[str, object]] = []
    for start in range(0, angle_count, sector_rows):
        stop = min(angle_count, start + sector_rows)
        local_mask = included_angles[start:stop]
        if len(local_mask) < 3 or float(np.mean(local_mask)) < 0.8:
            continue
        local_gradient = gradient[start:stop][local_mask]
        profile = np.median(local_gradient, axis=0)
        peaks = detect_profile_peaks(profile, min_spacing, threshold_mad)
        length_px = candidate_length_pixels(peaks, radius_count, geometry)
        sectors.append(
            {
                "startDegrees": start * 360.0 / angle_count,
                "endDegrees": stop * 360.0 / angle_count,
                "peaks": peaks,
                "count": len(peaks),
                "lengthPixels": length_px,
            }
        )
    return sectors


def choose_representative_sector(sectors: Sequence[dict[str, object]]) -> dict[str, object] | None:
    if not sectors:
        return None
    counts = np.asarray([int(sector["count"]) for sector in sectors], dtype=np.float32)
    lengths = np.asarray([float(sector["lengthPixels"]) for sector in sectors], dtype=np.float32)
    median_count = float(np.median(counts))
    median_length = float(np.median(lengths))
    count_scale = max(1.0, median_count)
    length_scale = max(1.0, median_length)
    scores = np.abs(counts - median_count) / count_scale + np.abs(lengths - median_length) / length_scale
    return sectors[int(np.argmin(scores))]


def sector_consistency_quality(sectors: Sequence[dict[str, object]]) -> tuple[str, dict[str, float]]:
    if not sectors:
        return "insufficient", {
            "medianCount": 0.0,
            "countIqr": 0.0,
            "medianLengthPixels": 0.0,
            "lengthRelativeIqr": 0.0,
        }
    counts = np.asarray([int(sector["count"]) for sector in sectors], dtype=np.float32)
    lengths = np.asarray([float(sector["lengthPixels"]) for sector in sectors], dtype=np.float32)
    count_iqr = float(np.percentile(counts, 75) - np.percentile(counts, 25))
    median_length = float(np.median(lengths))
    length_iqr = float(np.percentile(lengths, 75) - np.percentile(lengths, 25))
    relative_iqr = length_iqr / max(1.0, median_length)
    if count_iqr <= 1.0 and relative_iqr <= 0.08:
        label = "strong"
    elif count_iqr <= 3.0 and relative_iqr <= 0.20:
        label = "moderate"
    else:
        label = "weak"
    return label, {
        "medianCount": float(np.median(counts)),
        "countIqr": count_iqr,
        "medianLengthPixels": median_length,
        "lengthRelativeIqr": relative_iqr,
    }


def draw_diagnostics(
    image_rgb: np.ndarray,
    geometry: Geometry,
    peaks: Sequence[int],
    radius_count: int,
) -> np.ndarray:
    canvas = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)
    center = (int(round(geometry.center_x)), int(round(geometry.center_y)))
    cv2.circle(canvas, center, 5, (0, 0, 255), -1)
    span = 1.0 - geometry.inner_fraction
    for peak in peaks:
        fraction = geometry.inner_fraction + span * peak / (radius_count - 1)
        axes = (
            max(1, int(round(geometry.outer_radius_x * fraction))),
            max(1, int(round(geometry.outer_radius_y * fraction))),
        )
        cv2.ellipse(canvas, center, axes, 0, 0, 360, (0, 180, 0), 1, cv2.LINE_AA)
    outer_axes = (int(round(geometry.outer_radius_x)), int(round(geometry.outer_radius_y)))
    cv2.ellipse(canvas, center, outer_axes, 0, 0, 360, (255, 0, 0), 2, cv2.LINE_AA)
    return canvas


def draw_profile(profile: np.ndarray, peaks: Sequence[int], width: int = 1200, height: int = 360) -> np.ndarray:
    canvas = np.full((height, width, 3), 255, dtype=np.uint8)
    normalized = cv2.normalize(profile, None, 0, height - 30, cv2.NORM_MINMAX).reshape(-1)
    xs = np.linspace(0, width - 1, len(profile)).astype(np.int32)
    ys = (height - 15 - normalized).astype(np.int32)
    cv2.polylines(canvas, [np.column_stack([xs, ys])], False, (40, 40, 40), 1, cv2.LINE_AA)
    for peak in peaks:
        x = int(round(peak * (width - 1) / max(1, len(profile) - 1)))
        cv2.line(canvas, (x, 0), (x, height - 1), (0, 150, 0), 1)
    cv2.putText(
        canvas,
        "Aggregated radial edge signal; green lines are candidate wrap boundaries",
        (16, 24),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.55,
        (0, 0, 0),
        1,
        cv2.LINE_AA,
    )
    return canvas


def analyse(args: argparse.Namespace) -> dict[str, object]:
    image_path = Path(args.image).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    image_rgb = load_rgb(image_path)
    geometry = Geometry(
        center_x=args.center[0],
        center_y=args.center[1],
        outer_radius_x=args.outer_radii[0],
        outer_radius_y=args.outer_radii[1],
        inner_fraction=args.inner_fraction,
    )
    validate_geometry(image_rgb, geometry)
    mm_per_px = millimetres_per_pixel(args.scale_points, args.scale_distance_mm)

    polar_rgb = elliptical_polar_unwrap(image_rgb, geometry, args.angle_samples, args.radius_samples)
    polar_gray = cv2.cvtColor(polar_rgb, cv2.COLOR_RGB2GRAY)
    enhanced = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(16, 16)).apply(polar_gray)
    enhanced = cv2.GaussianBlur(enhanced, (3, 3), 0.8)
    gradient = np.abs(cv2.Sobel(enhanced, cv2.CV_32F, 1, 0, ksize=3))

    included = angle_mask(gradient.shape[0], args.exclude_degrees)
    if float(np.mean(included)) < 0.25:
        raise ValueError("excluded sectors leave less than 25% of the roll face")
    profile = np.median(gradient[included], axis=0)
    global_peaks = detect_profile_peaks(profile, args.min_layer_spacing_px, args.threshold_mad)
    sectors = sector_candidates(
        gradient,
        included,
        geometry,
        args.sector_width_degrees,
        args.min_layer_spacing_px,
        args.threshold_mad,
    )
    representative = choose_representative_sector(sectors)
    peaks = [] if representative is None else list(representative["peaks"])
    quality, consistency = sector_consistency_quality(sectors)
    _, angular_coverage = layer_signal_quality(gradient, included, global_peaks)

    total_pixels = float(consistency["medianLengthPixels"])
    diagnostic_median_m = None if mm_per_px is None else total_pixels * mm_per_px / 1000.0
    sector_lengths_px = [float(sector["lengthPixels"]) for sector in sectors]
    diagnostic_range_m = None
    if mm_per_px is not None and sector_lengths_px:
        diagnostic_range_m = [
            min(sector_lengths_px) * mm_per_px / 1000.0,
            max(sector_lengths_px) * mm_per_px / 1000.0,
        ]
    estimated_m = diagnostic_median_m if quality == "strong" else None

    cv2.imwrite(str(output_dir / "polar-unwrapped.jpg"), cv2.cvtColor(polar_rgb, cv2.COLOR_RGB2BGR))
    cv2.imwrite(str(output_dir / "radial-gradient.png"), cv2.normalize(gradient, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8))
    cv2.imwrite(str(output_dir / "radial-profile.png"), draw_profile(profile, peaks))
    cv2.imwrite(
        str(output_dir / "candidate-layers.jpg"),
        draw_diagnostics(image_rgb, geometry, peaks, polar_rgb.shape[1]),
    )

    warnings = [
        "Research output only; no accuracy claim is established.",
        "Candidate rings may include texture/folds or omit visually merged wraps.",
        "Nested ellipses approximate the visible end face and do not recover hidden axial variation.",
    ]
    if mm_per_px is None:
        warnings.append("No physical scale supplied; metres cannot be calculated.")
    if quality != "strong":
        warnings.append("Layer signal is not consistently strong across the included angular sectors.")

    result: dict[str, object] = {
        "status": "research_candidate" if quality == "strong" else "research_inconclusive",
        "accuracyClaimed": False,
        "input": str(image_path),
        "imageWidthPx": int(image_rgb.shape[1]),
        "imageHeightPx": int(image_rgb.shape[0]),
        "geometry": {
            "centerPx": [geometry.center_x, geometry.center_y],
            "outerRadiiPx": [geometry.outer_radius_x, geometry.outer_radius_y],
            "innerFraction": geometry.inner_fraction,
        },
        "calibration": {
            "millimetresPerPixel": mm_per_px,
            "source": "two_point_manual" if mm_per_px is not None else None,
        },
        "candidateWrapBoundaryCount": len(peaks),
        "globalConsensusBoundaryCount": len(global_peaks),
        "sectorCount": len(sectors),
        "sectorCandidateCounts": [int(sector["count"]) for sector in sectors],
        "sectorConsistency": consistency,
        "representativeSectorDegrees": None
        if representative is None
        else [representative["startDegrees"], representative["endDegrees"]],
        "candidateRadiiNormalized": [
            geometry.inner_fraction
            + (1.0 - geometry.inner_fraction) * peak / (polar_rgb.shape[1] - 1)
            for peak in peaks
        ],
        "layerSignalQuality": quality,
        "medianAngularCoverage": angular_coverage,
        "candidateLengthM": estimated_m,
        "diagnosticMedianLengthM": diagnostic_median_m,
        "diagnosticSectorLengthRangeM": diagnostic_range_m,
        "warnings": warnings,
        "artifacts": {
            "candidateLayers": str(output_dir / "candidate-layers.jpg"),
            "polarUnwrapped": str(output_dir / "polar-unwrapped.jpg"),
            "radialGradient": str(output_dir / "radial-gradient.png"),
            "radialProfile": str(output_dir / "radial-profile.png"),
        },
    }
    result_path = output_dir / "result.json"
    result_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="JPEG, PNG, TIFF or Pillow-readable DNG")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--center", type=parse_pair, required=True, help="roll centre X,Y in pixels")
    parser.add_argument(
        "--outer-radii",
        type=parse_pair,
        required=True,
        help="outer ellipse horizontal,vertical radii in pixels",
    )
    parser.add_argument("--inner-fraction", type=float, default=0.05)
    parser.add_argument("--scale-points", type=parse_four, help="X1,Y1,X2,Y2 for a known image distance")
    parser.add_argument("--scale-distance-mm", type=float)
    parser.add_argument("--exclude-degrees", type=parse_ranges, default=[])
    parser.add_argument("--angle-samples", type=int, default=1440)
    parser.add_argument("--radius-samples", type=int)
    parser.add_argument("--min-layer-spacing-px", type=int, default=5)
    parser.add_argument("--threshold-mad", type=float, default=1.0)
    parser.add_argument("--sector-width-degrees", type=float, default=12.0)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = analyse(args)
    except (OSError, ValueError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, indent=2))
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
