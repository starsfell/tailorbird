from __future__ import annotations

import numpy as np


def laplacian_variance(gray: np.ndarray) -> float:
    """Variance of the Laplacian. Higher = sharper. Pure numpy, no opencv dep."""
    if gray.ndim != 2:
        raise ValueError("expected 2-D grayscale array")
    g = gray.astype(np.float32)
    # 3x3 Laplacian kernel applied via shifts (avoids scipy/opencv dependency)
    lap = (
        -4.0 * g
        + np.roll(g, 1, axis=0)
        + np.roll(g, -1, axis=0)
        + np.roll(g, 1, axis=1)
        + np.roll(g, -1, axis=1)
    )
    # exclude 1-px border (wrap artifacts)
    inner = lap[1:-1, 1:-1]
    return float(inner.var())


def tenengrad(gray: np.ndarray) -> float:
    """Average of Sobel gradient magnitude squared. Higher = sharper."""
    g = gray.astype(np.float32)
    gx = np.zeros_like(g)
    gy = np.zeros_like(g)
    gx[:, 1:-1] = g[:, 2:] - g[:, :-2]
    gy[1:-1, :] = g[2:, :] - g[:-2, :]
    mag2 = gx * gx + gy * gy
    return float(mag2[1:-1, 1:-1].mean())


def sharpness_score(gray: np.ndarray) -> float:
    """Combined sharpness score, unbounded.

    Cross-scene comparison is NOT meaningful (a landscape and a tight bird shot
    will score very differently for reasons unrelated to focus). Designed to be
    compared **within a cluster** of similar shots, where small differences in
    focus dominate the result. Returned with full float precision; the UI shows
    4 decimals.
    """
    lap = laplacian_variance(gray)
    ten = tenengrad(gray)
    lap_n = np.sqrt(lap) * 0.6
    ten_n = np.sqrt(ten) * 1.2
    return float(lap_n + ten_n)
