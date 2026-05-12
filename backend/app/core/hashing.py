from __future__ import annotations

from PIL import Image


def compute_phash(img: Image.Image, hash_size: int = 16) -> str:
    """Perceptual hash as a hex string (returns "" on failure)."""
    try:
        import imagehash

        return str(imagehash.phash(img, hash_size=hash_size))
    except Exception:
        return ""


def hamming(a: str, b: str) -> int:
    """Hamming distance between two hex-string hashes. Returns large number on mismatch."""
    if not a or not b or len(a) != len(b):
        return 1_000_000
    try:
        ia = int(a, 16)
        ib = int(b, 16)
    except ValueError:
        return 1_000_000
    return bin(ia ^ ib).count("1")
