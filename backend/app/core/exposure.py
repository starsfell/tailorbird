"""Histogram-based over/under exposure detector applied to bird bbox region."""
from __future__ import annotations

import numpy as np
from PIL import Image


def detect_exposure(
    img: Image.Image,
    bird_bbox_px: tuple[int, int, int, int] | None = None,
    bright_cutoff: int = 235,
    dark_cutoff: int = 15,
    threshold: float = 0.10,
) -> dict:
    """Returns dict with is_over, is_under, over_ratio, under_ratio.

    If bird_bbox_px given, computes on that crop; otherwise whole image.
    """
    if bird_bbox_px:
        x, y, w, h = bird_bbox_px
        crop = img.crop((x, y, x + w, y + h))
    else:
        crop = img
    arr = np.asarray(crop.convert("L"))
    if arr.size == 0:
        return {"is_over": False, "is_under": False, "over_ratio": 0.0, "under_ratio": 0.0}
    over = float((arr >= bright_cutoff).mean())
    under = float((arr <= dark_cutoff).mean())
    return {
        "is_over": over >= threshold,
        "is_under": under >= threshold,
        "over_ratio": over,
        "under_ratio": under,
    }
