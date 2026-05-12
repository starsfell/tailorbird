from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any


EXIFTOOL_BIN = "/opt/homebrew/bin/exiftool"


# Tags worth pulling on every scan. Vendor-specific AF tags are included
# unconditionally — exiftool just returns null for tags the file doesn't have.
_BASIC_TAGS = [
    "-DateTimeOriginal",
    "-SubSecTimeOriginal",
    "-CreateDate",
    "-ImageWidth",
    "-ImageHeight",
    "-Orientation",
    "-Make",
    "-Model",
    "-LensModel",
    "-FocalLength",
    "-FNumber",
    "-ExposureTime",
    "-ISO",
    "-Rating",
    "-XMP:Rating",
    "-XMP:Label",
]

_FOCUS_TAGS = [
    # Sony
    "-FocusLocation",
    "-AFAreaMode",
    "-FocusFrameSize",
    "-FocusMode",
    # Nikon
    "-AFAreaXPosition",
    "-AFAreaYPosition",
    "-AFAreaWidth",
    "-AFAreaHeight",
    "-AFImageWidth",
    "-AFImageHeight",
    "-FocusResult",
    "-AFPointPosition",
    # Canon
    "-AFPointsInFocus",
    "-AFAreaXPositions",
    "-AFAreaYPositions",
]


def read_exif(path: Path) -> dict[str, Any]:
    """Run exiftool once and return a flat dict. Returns empty dict on failure."""
    try:
        result = subprocess.run(
            [EXIFTOOL_BIN, "-j", "-n", *_BASIC_TAGS, *_FOCUS_TAGS, str(path)],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return {}
        data = json.loads(result.stdout)
        return data[0] if data else {}
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return {}


def parse_shot_at(exif: dict[str, Any]) -> float | None:
    import datetime as _dt

    dt_str = exif.get("DateTimeOriginal") or exif.get("CreateDate")
    if not dt_str:
        return None
    try:
        dt = _dt.datetime.strptime(dt_str, "%Y:%m:%d %H:%M:%S")
    except ValueError:
        try:
            dt = _dt.datetime.strptime(str(dt_str).split(".")[0], "%Y:%m:%d %H:%M:%S")
        except ValueError:
            return None
    subsec = exif.get("SubSecTimeOriginal")
    if subsec is not None:
        try:
            dt = dt.replace(microsecond=int(str(subsec).ljust(6, "0")[:6]))
        except (ValueError, TypeError):
            pass
    return dt.timestamp()


def parse_focus_point(exif: dict[str, Any]) -> dict[str, Any] | None:
    """Try every vendor's AF point fields, return a normalized dict:
        { x, y, w, h, image_w, image_h, mode, vendor }
    where x/y/w/h are pixels in the original sensor image. Returns None if not found.
    """
    make = (exif.get("Make") or "").upper()

    image_w = exif.get("ImageWidth") or exif.get("AFImageWidth")
    image_h = exif.get("ImageHeight") or exif.get("AFImageHeight")

    # Sony: FocusLocation = "image_w image_h focus_x focus_y"
    fl = exif.get("FocusLocation")
    if fl and isinstance(fl, str):
        m = re.findall(r"-?\d+", fl)
        if len(m) >= 4:
            iw, ih, fx, fy = int(m[0]), int(m[1]), int(m[2]), int(m[3])
            ffs = exif.get("FocusFrameSize") or ""
            fw, fh = 100, 100
            ms = re.findall(r"\d+", str(ffs))
            if len(ms) >= 2:
                fw, fh = int(ms[0]), int(ms[1])
            return {
                "x": fx, "y": fy, "w": fw, "h": fh,
                "image_w": iw, "image_h": ih,
                "mode": exif.get("AFAreaMode") or exif.get("FocusMode"),
                "vendor": "sony",
            }

    # Nikon: AFAreaXPosition / AFAreaYPosition (pixels from top-left of AFImage)
    if exif.get("AFAreaXPosition") is not None and exif.get("AFAreaYPosition") is not None:
        return {
            "x": int(exif["AFAreaXPosition"]),
            "y": int(exif["AFAreaYPosition"]),
            "w": int(exif.get("AFAreaWidth") or 100),
            "h": int(exif.get("AFAreaHeight") or 100),
            "image_w": int(exif.get("AFImageWidth") or image_w or 0) or None,
            "image_h": int(exif.get("AFImageHeight") or image_h or 0) or None,
            "mode": exif.get("AFAreaMode"),
            "vendor": "nikon",
        }

    # Canon: AFPointsInFocus (indices) + AFAreaXPositions/YPositions (center-offset)
    if exif.get("AFPointsInFocus") is not None and exif.get("AFAreaXPositions"):
        try:
            idxs = [int(x) for x in re.findall(r"\d+", str(exif["AFPointsInFocus"]))]
            xs = [int(x) for x in re.findall(r"-?\d+", str(exif["AFAreaXPositions"]))]
            ys = [int(y) for y in re.findall(r"-?\d+", str(exif["AFAreaYPositions"]))]
            if idxs and xs and ys:
                i = idxs[0]
                iw = int(exif.get("AFImageWidth") or image_w or 0)
                ih = int(exif.get("AFImageHeight") or image_h or 0)
                cx = xs[i] + iw // 2
                cy = ys[i] + ih // 2
                return {
                    "x": cx, "y": cy, "w": 100, "h": 100,
                    "image_w": iw, "image_h": ih,
                    "mode": exif.get("AFAreaMode"),
                    "vendor": "canon",
                }
        except (IndexError, ValueError):
            pass

    return None
