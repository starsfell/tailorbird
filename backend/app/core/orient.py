"""EXIF Orientation handling.

Previews, AI boxes/eye points and AF points are all stored in the *sensor*
frame (unrotated — the embedded ARW JPEG has no rotation applied). Rotation is
applied only at the API edge: images are turned upright when served, and
normalized coordinates are mapped into the upright frame on the way out (and
back on the way in, for manual annotation). That way existing analysis never
needs recomputing.

Only the pure rotations are handled (1/3/6/8); mirrored values are rare in
camera output and are treated as 1.
"""
from __future__ import annotations

from typing import Any

from PIL import Image

_TRANSPOSE = {
    3: Image.Transpose.ROTATE_180,
    6: Image.Transpose.ROTATE_270,   # PIL rotates counter-clockwise: 270 CCW = 90 CW
    8: Image.Transpose.ROTATE_90,
}
_INVERSE = {1: 1, 3: 3, 6: 8, 8: 6}


def norm(o: Any) -> int:
    try:
        o = int(o)
    except (TypeError, ValueError):
        return 1
    return o if o in _TRANSPOSE else 1


def swaps_axes(o: Any) -> bool:
    return norm(o) in (6, 8)


def rotate_image(img: Image.Image, o: Any) -> Image.Image:
    t = _TRANSPOSE.get(norm(o))
    return img.transpose(t) if t is not None else img


def map_point(pt, o: Any):
    """Normalized [x, y] in the sensor frame → upright frame."""
    if not pt or len(pt) != 2:
        return pt
    x, y = pt
    o = norm(o)
    if o == 3:
        return [1 - x, 1 - y]
    if o == 6:
        return [1 - y, x]
    if o == 8:
        return [y, 1 - x]
    return [x, y]


def map_bbox(b, o: Any):
    """Normalized [x, y, w, h] in the sensor frame → upright frame."""
    if not b or len(b) != 4:
        return b
    x, y, w, h = b
    o = norm(o)
    if o == 1:
        return [x, y, w, h]
    (ax, ay), (bx, by) = map_point([x, y], o), map_point([x + w, y + h], o)
    return [min(ax, bx), min(ay, by), abs(bx - ax), abs(by - ay)]


def unmap_point(pt, o: Any):
    return map_point(pt, _INVERSE[norm(o)])


def unmap_bbox(b, o: Any):
    return map_bbox(b, _INVERSE[norm(o)])


def map_focus(fp: dict | None, o: Any, fallback_wh: tuple[Any, Any] = (None, None)) -> dict | None:
    """AF point dict ({x, y, w, h, image_w, image_h} in sensor pixels) → upright frame."""
    o = norm(o)
    if not fp or o == 1:
        return fp
    iw = fp.get("image_w") or fallback_wh[0]
    ih = fp.get("image_h") or fallback_wh[1]
    if not iw or not ih:
        return fp
    cx, cy = map_point([fp["x"] / iw, fp["y"] / ih], o)
    out = dict(fp)
    if o in (6, 8):
        iw, ih = ih, iw
        out["w"], out["h"] = fp.get("h"), fp.get("w")
    out.update(x=cx * iw, y=cy * ih, image_w=iw, image_h=ih)
    return out
