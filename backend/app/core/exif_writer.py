"""Write tailorbird's rating / pick / labels / tags back to original RAW/JPEG via exiftool.

Compatible with Lightroom / Capture One / Bridge XMP conventions:
- XMP:Rating  (1-5 integer; we use 0-3)
- XMP:Label   (e.g. "Green" for flying, "Red" for pick/best-focus)
- IPTC:Keywords + XMP-dc:Subject  (user-defined tags, via -Keywords shortcut)

For tag writes we use -Keywords+= / -Keywords-= deltas against the last set we
wrote (stored in photos.xmp_tags as JSON), so foreign keywords added in
Lightroom / Capture One are preserved across round-trips.
"""
from __future__ import annotations

import json
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


def _load_prev_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        v = json.loads(raw)
        return [str(x) for x in v] if isinstance(v, list) else []
    except Exception:
        return []


def write_xmp(photo_ids: Iterable[int]) -> dict:
    """For each photo, write rating + label + tags into its XMP block. Original
    file is modified IN PLACE; we pass `-overwrite_original` to avoid littering
    the folder with .ARW_original duplicates."""
    photo_ids = list(photo_ids)
    if not photo_ids:
        return {"updated": [], "failed": []}

    with tx() as conn:
        placeholders = ",".join(["?"] * len(photo_ids))
        rows = conn.execute(
            f"""SELECT id, path, rating, pick, is_flying, focus_weight, xmp_tags
                FROM photos WHERE id IN ({placeholders}) AND deleted_at IS NULL""",
            photo_ids,
        ).fetchall()
        targets = [dict(r) for r in rows]
        # Resolve current tag set per photo, expanded to include ALL ancestors
        # (Lightroom-style: tag "白鹭" under "水鸟/鸟类" writes 3 keywords).
        cur_tags: dict[int, list[str]] = {pid: [] for pid in photo_ids}
        tag_rows = conn.execute(
            f"""WITH RECURSIVE chain(photo_id, tag_id) AS (
                    SELECT photo_id, tag_id FROM photo_tags
                    WHERE photo_id IN ({placeholders})
                    UNION
                    SELECT c.photo_id, t.parent_id
                    FROM chain c JOIN tags t ON t.id = c.tag_id
                    WHERE t.parent_id IS NOT NULL
                )
                SELECT DISTINCT c.photo_id, t.name
                FROM chain c JOIN tags t ON t.id = c.tag_id""",
            photo_ids,
        ).fetchall()
        for tr in tag_rows:
            cur_tags.setdefault(tr["photo_id"], []).append(tr["name"])

    updated, failed, tag_updates = [], [], []
    for rec in targets:
        p = Path(rec["path"])
        if not p.exists():
            failed.append({"path": str(p), "error": "missing"}); continue
        rating = max(0, min(5, int(rec.get("rating") or 0)))
        label = _label_for(rec)
        prev = set(_load_prev_tags(rec.get("xmp_tags")))
        cur = set(cur_tags.get(rec["id"], []))
        to_add = sorted(cur - prev)
        to_remove = sorted(prev - cur)

        args = [
            EXIFTOOL_BIN, "-overwrite_original", "-q", "-q",
            f"-XMP:Rating={rating}",
        ]
        if label:
            args.append(f"-XMP:Label={label}")
        else:
            args.append("-XMP:Label=")
        # -Keywords is a shortcut that writes IPTC:Keywords + XMP-dc:Subject
        for kw in to_remove:
            args.append(f"-Keywords-={kw}")
        for kw in to_add:
            args.append(f"-Keywords+={kw}")
        args.append("-XMP:CreatorTool=tailorbird")
        args.append(str(p))
        try:
            r = subprocess.run(args, capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                updated.append({
                    "id": rec["id"], "path": str(p), "rating": rating, "label": label,
                    "tags_added": to_add, "tags_removed": to_remove,
                })
                tag_updates.append((rec["id"], sorted(cur)))
            else:
                failed.append({"path": str(p), "error": r.stderr.strip() or "exiftool error"})
        except Exception as e:
            failed.append({"path": str(p), "error": f"{type(e).__name__}: {e}"})

    # Persist new xmp_tags snapshot for successful writes.
    if tag_updates:
        with tx() as conn:
            for pid, names in tag_updates:
                conn.execute(
                    "UPDATE photos SET xmp_tags = ? WHERE id = ?",
                    (json.dumps(names, ensure_ascii=False), pid),
                )

    return {"updated": updated, "failed": failed}


def clear_xmp(photo_ids: Iterable[int]) -> dict:
    """Undo: clear rating/label and any tag keywords previously written by tailorbird."""
    photo_ids = list(photo_ids)
    if not photo_ids:
        return {"cleared": [], "failed": []}
    with tx() as conn:
        placeholders = ",".join(["?"] * len(photo_ids))
        rows = conn.execute(
            f"SELECT id, path, xmp_tags FROM photos WHERE id IN ({placeholders})", photo_ids
        ).fetchall()
        targets = [dict(r) for r in rows]
    cleared, failed, cleared_ids = [], [], []
    for rec in targets:
        p = Path(rec["path"])
        if not p.exists():
            failed.append({"path": str(p), "error": "missing"}); continue
        prev = _load_prev_tags(rec.get("xmp_tags"))
        args = [
            EXIFTOOL_BIN, "-overwrite_original", "-q", "-q",
            "-XMP:Rating=", "-XMP:Label=", "-XMP:CreatorTool=",
        ]
        for kw in prev:
            args.append(f"-Keywords-={kw}")
        args.append(str(p))
        try:
            r = subprocess.run(args, capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                cleared.append({"id": rec["id"], "path": str(p), "tags_removed": prev})
                cleared_ids.append(rec["id"])
            else:
                failed.append({"path": str(p), "error": r.stderr.strip()})
        except Exception as e:
            failed.append({"path": str(p), "error": f"{type(e).__name__}: {e}"})
    if cleared_ids:
        with tx() as conn:
            ph = ",".join(["?"] * len(cleared_ids))
            conn.execute(f"UPDATE photos SET xmp_tags = NULL WHERE id IN ({ph})", cleared_ids)
    return {"cleared": cleared, "failed": failed}
