"""Rating engine — produces 0..3 stars from per-photo signals.

Inspired by SuperPicky's rating_engine.py (GPL-3.0). Re-implemented from scratch.

Inputs (any may be None when feature is disabled):
- bird_confidence: 0-1 from YOLO bird detection
- subject_sharpness: raw sharpness, computed inside bird bbox if available
- eye_sharpness: raw sharpness in a small box around the eye
- eye_visibility: 0-1, both-eyes-best
- aesthetic_score: TOPIQ 0-10
- focus_weight: 1.1 head / 1.0 seg / 0.7 bbox / 0.5 outside
- is_flying

When AI signals are absent (Phase 2.1 before YOLO is online), we fall back to
sharpness-only rating: cluster_best + sharpness above the preset threshold → 2/3
stars, otherwise 1.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class RatingInput:
    bird_confidence: Optional[float] = None
    subject_sharpness: Optional[float] = None
    eye_sharpness: Optional[float] = None
    eye_visibility: Optional[float] = None
    aesthetic_score: Optional[float] = None
    focus_weight: float = 1.0
    is_flying: bool = False
    is_cluster_best: bool = False
    is_over: bool = False
    is_under: bool = False


@dataclass
class RatingOutput:
    rating: int
    reason: str


def compute_rating(inp: RatingInput, preset: dict) -> RatingOutput:
    sharpness_th = preset["sharpness_th"]
    aesthetics_th = preset["aesthetics_th"]
    min_sharp = preset["min_sharpness"]
    min_aes = preset["min_aesthetics"]

    # Path A: AI signals absent → degenerate rating based on sharpness + cluster_best
    if inp.bird_confidence is None and inp.eye_sharpness is None:
        s = inp.subject_sharpness or 0.0
        if s < min_sharp:
            return RatingOutput(0, "锐度过低")
        if s >= sharpness_th and inp.is_cluster_best:
            return RatingOutput(3, "组内最佳且达标")
        if s >= sharpness_th:
            return RatingOutput(2, "达标但非组内最佳")
        return RatingOutput(1, "通过最低标准")

    # Path B: full AI rating
    if (inp.bird_confidence or 0) < 0.3:
        return RatingOutput(-1, "未检出鸟")

    sharp = inp.eye_sharpness if inp.eye_sharpness is not None else (inp.subject_sharpness or 0)
    sharp = sharp * inp.focus_weight
    if inp.is_flying:
        sharp *= 1.2

    aes = inp.aesthetic_score
    if aes is None:
        aes_ok = False
    else:
        adj_aes = aes * (0.9 if inp.focus_weight < 1.0 else 1.0)
        if inp.is_flying:
            adj_aes *= 1.1
        aes_ok = adj_aes >= aesthetics_th

    if sharp < min_sharp:
        return RatingOutput(0, f"锐度 {sharp:.0f} < 最低 {min_sharp:.0f}")
    if aes is not None and aes < min_aes:
        return RatingOutput(0, f"美学 {aes:.2f} < 最低 {min_aes:.2f}")

    sharp_ok = sharp >= sharpness_th

    if sharp_ok and aes_ok:
        base = 3
        reason = "锐度+美学双达标"
    elif sharp_ok:
        base = 2
        reason = "锐度达标"
    elif aes_ok:
        base = 2
        reason = "美学达标"
    else:
        base = 1
        reason = "通过最低标准"

    if inp.eye_visibility is not None and inp.eye_visibility < 0.5:
        weight = max(0.5, min(1.0, inp.eye_visibility * 2))
        base = round(base * weight)
        reason += f" (眼可见 {inp.eye_visibility:.2f} 降权)"

    # Exposure penalty
    if inp.is_over or inp.is_under:
        base = max(0, base - 1)
        if inp.is_over and inp.is_under:
            reason += " · 过曝+欠曝降级"
        elif inp.is_over:
            reason += " · 过曝降级"
        else:
            reason += " · 欠曝降级"

    return RatingOutput(max(0, min(3, base)), reason)
