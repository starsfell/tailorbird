from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from PIL import Image

from app.config import HEIF_EXTS, JPEG_EXTS, RAW_EXTS

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:
    pillow_heif = None


def load_preview(path: Path) -> Image.Image:
    """Return a PIL Image preview for any supported format.

    For Sony ARW, extracts the embedded high-resolution JPEG thumbnail
    (vastly faster than full RAW demosaic). For HIF/HEIF and JPEG, decodes
    directly.
    """
    ext = path.suffix.lower()
    if ext in RAW_EXTS:
        return _load_raw_preview(path)
    if ext in HEIF_EXTS:
        if pillow_heif is None:
            raise RuntimeError("pillow-heif not installed")
        return Image.open(path).convert("RGB")
    if ext in JPEG_EXTS:
        return Image.open(path).convert("RGB")
    raise ValueError(f"unsupported extension: {ext}")


def _load_raw_preview(path: Path) -> Image.Image:
    """Extract Sony ARW embedded JPEG preview. Falls back to demosaic if needed."""
    import rawpy

    with rawpy.imread(str(path)) as raw:
        try:
            thumb = raw.extract_thumb()
        except rawpy.LibRawNoThumbnailError:
            arr = raw.postprocess(use_camera_wb=True, half_size=True, no_auto_bright=False)
            return Image.fromarray(arr)
        if thumb.format == rawpy.ThumbFormat.JPEG:
            return Image.open(io.BytesIO(thumb.data)).convert("RGB")
        if thumb.format == rawpy.ThumbFormat.BITMAP:
            return Image.fromarray(thumb.data)
    raise RuntimeError(f"could not extract preview from {path}")


def make_thumbnail(img: Image.Image, size: int) -> Image.Image:
    img = img.copy()
    img.thumbnail((size, size), Image.Resampling.LANCZOS)
    return img


def to_grayscale_array(img: Image.Image, max_side: int = 1024) -> np.ndarray:
    """Convert PIL image to grayscale numpy array, downscaled for fast analysis."""
    if max(img.size) > max_side:
        scale = max_side / max(img.size)
        new_size = (int(img.size[0] * scale), int(img.size[1] * scale))
        img = img.resize(new_size, Image.Resampling.BILINEAR)
    return np.asarray(img.convert("L"), dtype=np.uint8)
