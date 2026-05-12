"""Write tailorbird's rating / pick / labels back to original RAW/JPEG via exiftool.

Compatible with Lightroom / Capture One / Bridge XMP conventions:
- XMP:Rating  (1-5 integer; we use 0-3)
- XMP:Label   (e.g. "Green" for flying, "Red" for pick/best-focus)
- IPTC:Keywords (we don't write species yet since species ID is not built)
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Iterable

from app.core.exif import EXIFTOOL_BIN
from app.db.schema import tx


def _label_for(rec: dict) -> str | None:
    if rec.get("is_flying"):
        return "Green"
    if rec.get("pick"):
        return "Red"
    return None


def write_xmp(photo_ids: Iterable[int]) -> dict:
    """For each photo, write rating + label into its XMP block. Original file is
    modified IN PLACE; exiftool keeps a `_original` backup unless we pass
    `-overwrite_original`. We use `-overwrite_original` to avoid littering the
    folder with .ARW_original duplicates, since tailorbird's DB is the audit trail."""
    photo_ids = list(photo_ids)
    if not photo_ids:
        return {"updated": [], "failed": []}

    with tx() as conn:
        placeholders = ",".join(["?"] * len(photo_ids))
        rows = conn.execute(
            f"""SELECT id, path, rating, pick, is_flying, focus_weight
                FROM photos WHERE id IN ({placeholders}) AND deleted_at IS NULL""",
            photo_ids,
        ).fetchall()
        targets = [dict(r) for r in rows]

    updated, failed = [], []
    for rec in targets:
        p = Path(rec["path"])
        if not p.exists():
            failed.append({"path": str(p), "error": "missing"}); continue
        rating = max(0, min(5, int(rec.get("rating") or 0)))
        label = _label_for(rec)
        args = [
            EXIFTOOL_BIN, "-overwrite_original", "-q", "-q",
            f"-XMP:Rating={rating}",
        ]
        if label:
            args.append(f"-XMP:Label={label}")
        else:
            args.append("-XMP:Label=")
        # Mark with CreatorTool=birdye (legacy name, kept stable so old XMP
        # written before the rename can still be recognized and cleared).
        args.append("-XMP:CreatorTool=birdye")
        args.append(str(p))
        try:
            r = subprocess.run(args, capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                updated.append({"id": rec["id"], "path": str(p), "rating": rating, "label": label})
            else:
                failed.append({"path": str(p), "error": r.stderr.strip() or "exiftool error"})
        except Exception as e:
            failed.append({"path": str(p), "error": f"{type(e).__name__}: {e}"})

    return {"updated": updated, "failed": failed}


def clear_xmp(photo_ids: Iterable[int]) -> dict:
    """Undo: clear rating/label written by tailorbird."""
    photo_ids = list(photo_ids)
    if not photo_ids:
        return {"cleared": [], "failed": []}
    with tx() as conn:
        placeholders = ",".join(["?"] * len(photo_ids))
        rows = conn.execute(
            f"SELECT id, path FROM photos WHERE id IN ({placeholders})", photo_ids
        ).fetchall()
        targets = [dict(r) for r in rows]
    cleared, failed = [], []
    for rec in targets:
        p = Path(rec["path"])
        if not p.exists():
            failed.append({"path": str(p), "error": "missing"}); continue
        try:
            r = subprocess.run(
                [EXIFTOOL_BIN, "-overwrite_original", "-q", "-q",
                 "-XMP:Rating=", "-XMP:Label=", "-XMP:CreatorTool=", str(p)],
                capture_output=True, text=True, timeout=15,
            )
            if r.returncode == 0:
                cleared.append({"id": rec["id"], "path": str(p)})
            else:
                failed.append({"path": str(p), "error": r.stderr.strip()})
        except Exception as e:
            failed.append({"path": str(p), "error": f"{type(e).__name__}: {e}"})
    return {"cleared": cleared, "failed": failed}
