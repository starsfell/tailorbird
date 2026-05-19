from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import json

from app.config import (
    BURST_GAP_SECONDS,
    DEFAULT_SKILL,
    PHASH_HAMMING_THRESHOLD,
    SKILL_PRESETS,
    SUPPORTED_EXTS,
    THUMB_SIZE,
    THUMBS_DIR,
)
from app.core.decode import load_preview, make_thumbnail, to_grayscale_array
from app.core.exif import parse_focus_point, parse_shot_at, read_exif
from app.core.hashing import compute_phash, hamming
from app.core.rating import RatingInput, compute_rating
from app.core.sharpness import sharpness_score
from app.db.schema import tx


@dataclass
class ScanProgress:
    total: int = 0
    done: int = 0
    failed: int = 0
    current_path: str = ""
    phase: str = "idle"  # idle | scanning | analyzing | clustering | ai_analyzing | done
    run_ai: bool = True


def discover_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for p in root.rglob("*"):
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS:
            files.append(p)
    return files


def _register_folder(folder: Path) -> int:
    with tx() as conn:
        cur = conn.execute("INSERT OR IGNORE INTO folders(path) VALUES(?)", (str(folder),))
        if cur.lastrowid:
            return cur.lastrowid
        row = conn.execute("SELECT id FROM folders WHERE path=?", (str(folder),)).fetchone()
        return row["id"]


def _existing_paths(folder_id: int) -> dict[str, dict]:
    with tx() as conn:
        rows = conn.execute(
            "SELECT path, mtime, size, analyzed_at FROM photos WHERE folder_id=?",
            (folder_id,),
        ).fetchall()
    return {r["path"]: dict(r) for r in rows}


def _parse_basic_exif(exif: dict) -> dict:
    """Pull just the shooting params we persist. EXIF tag values come in as
    strings or numbers from exiftool's -n flag; coerce carefully."""
    def _num(key):
        v = exif.get(key)
        if v is None or v == "":
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None
    def _intval(key):
        v = exif.get(key)
        if v is None or v == "":
            return None
        try:
            return int(float(v))
        except (TypeError, ValueError):
            return None
    def _strval(key):
        v = exif.get(key)
        s = str(v).strip() if v is not None else ""
        return s or None
    return {
        "iso": _intval("ISO"),
        "f_number": _num("FNumber"),
        "exposure_time": _num("ExposureTime"),
        "focal_length": _num("FocalLength"),
        "lens_model": _strval("LensModel"),
        "camera_model": _strval("Model"),
    }


def _analyze_one(path: Path) -> dict:
    """Heavy per-file work: decode preview, EXIF (incl. AF point), thumb, sharpness, phash."""
    base = {
        "path": str(path),
        "stem": path.stem,
        "ext": path.suffix.lower(),
        "size": path.stat().st_size if path.exists() else 0,
        "mtime": path.stat().st_mtime if path.exists() else 0,
        "shot_at": None,
        "width": None, "height": None,
        "thumb_path": None,
        "subject_sharpness": None,
        "phash": None,
        "focus_point": None,
        "iso": None, "f_number": None, "exposure_time": None,
        "focal_length": None, "lens_model": None, "camera_model": None,
        "analyzed_at": time.time(),
        "error": None,
    }
    try:
        img = load_preview(path)
        exif = read_exif(path)
        shot_at = parse_shot_at(exif)
        focus = parse_focus_point(exif)
        basic = _parse_basic_exif(exif)
        w, h = img.size

        thumb = make_thumbnail(img, THUMB_SIZE)
        thumb_path = THUMBS_DIR / f"{path.stem}_{abs(hash(str(path))) & 0xFFFFFFFF:08x}.webp"
        thumb.save(thumb_path, "WEBP", quality=82)

        gray = to_grayscale_array(img, max_side=1024)
        sharp = sharpness_score(gray)
        phash = compute_phash(img)

        base.update({
            "shot_at": shot_at,
            "width": w, "height": h,
            "thumb_path": str(thumb_path),
            "subject_sharpness": sharp,
            "phash": phash,
            "focus_point": json.dumps(focus) if focus else None,
            **basic,
        })
        return base
    except Exception as e:
        base["error"] = f"{type(e).__name__}: {e}"
        return base


def _upsert_photo(folder_id: int, rec: dict) -> None:
    with tx() as conn:
        conn.execute(
            """
            INSERT INTO photos(folder_id, path, stem, ext, size, mtime, shot_at, width, height,
                              thumb_path, subject_sharpness, phash, focus_point,
                              iso, f_number, exposure_time, focal_length, lens_model, camera_model,
                              analyzed_at, error)
            VALUES(:folder_id, :path, :stem, :ext, :size, :mtime, :shot_at, :width, :height,
                   :thumb_path, :subject_sharpness, :phash, :focus_point,
                   :iso, :f_number, :exposure_time, :focal_length, :lens_model, :camera_model,
                   :analyzed_at, :error)
            ON CONFLICT(path) DO UPDATE SET
                size=excluded.size, mtime=excluded.mtime, shot_at=excluded.shot_at,
                width=excluded.width, height=excluded.height, thumb_path=excluded.thumb_path,
                subject_sharpness=excluded.subject_sharpness, phash=excluded.phash,
                focus_point=excluded.focus_point,
                iso=excluded.iso, f_number=excluded.f_number,
                exposure_time=excluded.exposure_time, focal_length=excluded.focal_length,
                lens_model=excluded.lens_model, camera_model=excluded.camera_model,
                analyzed_at=excluded.analyzed_at, error=excluded.error
            """,
            {**rec, "folder_id": folder_id},
        )


def _apply_ratings(folder_id: int, skill: str = DEFAULT_SKILL) -> None:
    """Compute 0-3 star rating for each photo using the chosen skill preset."""
    preset = SKILL_PRESETS.get(skill, SKILL_PRESETS[DEFAULT_SKILL])
    with tx() as conn:
        rows = conn.execute(
            """
            SELECT id, subject_sharpness, eye_sharpness, eye_visibility, aesthetic_score,
                   bird_confidence, focus_weight, is_flying, is_cluster_best,
                   is_over, is_under
            FROM photos
            WHERE folder_id=? AND deleted_at IS NULL
            """,
            (folder_id,),
        ).fetchall()
        for r in rows:
            inp = RatingInput(
                bird_confidence=r["bird_confidence"],
                subject_sharpness=r["subject_sharpness"],
                eye_sharpness=r["eye_sharpness"],
                eye_visibility=r["eye_visibility"],
                aesthetic_score=r["aesthetic_score"],
                focus_weight=r["focus_weight"] or 1.0,
                is_flying=bool(r["is_flying"]),
                is_cluster_best=bool(r["is_cluster_best"]),
                is_over=bool(r["is_over"]) if "is_over" in r.keys() else False,
                is_under=bool(r["is_under"]) if "is_under" in r.keys() else False,
            )
            out = compute_rating(inp, preset)
            conn.execute(
                "UPDATE photos SET rating=? WHERE id=?", (out.rating, r["id"])
            )

        # Pick flag: top 25% of 3-star photos by sharpness*aesthetic (or sharpness alone)
        conn.execute("UPDATE photos SET pick=0 WHERE folder_id=?", (folder_id,))
        three_stars = conn.execute(
            """
            SELECT id, subject_sharpness, aesthetic_score
            FROM photos WHERE folder_id=? AND rating=3 AND deleted_at IS NULL
            """,
            (folder_id,),
        ).fetchall()
        scored = [
            (
                r["id"],
                (r["subject_sharpness"] or 0) * (r["aesthetic_score"] or 5.0),
            )
            for r in three_stars
        ]
        scored.sort(key=lambda x: -x[1])
        cutoff = max(1, len(scored) // 4)
        for pid, _ in scored[:cutoff]:
            conn.execute("UPDATE photos SET pick=1 WHERE id=?", (pid,))


def _cluster_photos(folder_id: int) -> None:
    """Cluster at SHOT level (group by stem first), then propagate cluster_id back to all members."""
    with tx() as conn:
        rows = conn.execute(
            """
            SELECT id, stem, ext, shot_at, phash, subject_sharpness
            FROM photos
            WHERE folder_id=? AND deleted_at IS NULL AND phash IS NOT NULL
            ORDER BY shot_at IS NULL, shot_at, id
            """,
            (folder_id,),
        ).fetchall()

        # Group photo rows into shots by stem; one shot may contain ARW+HIF
        shots: dict[str, dict] = {}
        for r in rows:
            d = dict(r)
            stem = d["stem"]
            if stem not in shots:
                shots[stem] = {
                    "stem": stem,
                    "shot_at": d["shot_at"],
                    "phash": d["phash"],
                    "sharpness": d["subject_sharpness"] or 0.0,
                    "member_ids": [d["id"]],
                    "best_ext": d["ext"],
                }
            else:
                s = shots[stem]
                s["member_ids"].append(d["id"])
                if (d["subject_sharpness"] or 0) > s["sharpness"]:
                    s["sharpness"] = d["subject_sharpness"] or 0
                # prefer ARW phash as representative (more reliable than HIF preview)
                if d["ext"] == ".arw":
                    s["phash"] = d["phash"]
                    s["best_ext"] = ".arw"
                if d["shot_at"] is not None and s["shot_at"] is None:
                    s["shot_at"] = d["shot_at"]

        shot_list = sorted(
            shots.values(),
            key=lambda s: (s["shot_at"] is None, s["shot_at"] or 0, s["stem"]),
        )

        # Cluster shots by time + phash
        clusters: list[list[dict]] = []
        current: list[dict] = []
        last_t: float | None = None
        for s in shot_list:
            t = s["shot_at"]
            if not current:
                current = [s]
                last_t = t
                continue
            same_time = (
                t is not None and last_t is not None and (t - last_t) <= BURST_GAP_SECONDS
            )
            same_hash = any(
                hamming(s["phash"], c["phash"]) <= PHASH_HAMMING_THRESHOLD for c in current
            )
            if same_time or same_hash:
                current.append(s)
            else:
                clusters.append(current)
                current = [s]
            last_t = t
        if current:
            clusters.append(current)

        # Reset, then write back per photo row
        conn.execute(
            "UPDATE photos SET cluster_id=NULL, is_cluster_best=0 WHERE folder_id=?",
            (folder_id,),
        )
        for idx, group in enumerate(clusters):
            best_shot = max(group, key=lambda s: s["sharpness"])
            for s in group:
                is_best = 1 if s["stem"] == best_shot["stem"] else 0
                for pid in s["member_ids"]:
                    conn.execute(
                        "UPDATE photos SET cluster_id=?, is_cluster_best=? WHERE id=?",
                        (idx, is_best, pid),
                    )




def _get_or_create_tag(conn, name: str, parent_id: int | None = None) -> int:
    """Find tag by globally-unique name (tags.name is UNIQUE COLLATE NOCASE).
    Create under given parent if missing. Returns tag id."""
    row = conn.execute("SELECT id FROM tags WHERE name=? COLLATE NOCASE", (name,)).fetchone()
    if row:
        return row["id"]
    cur = conn.execute(
        "INSERT INTO tags(name, parent_id, created_at) VALUES(?, ?, ?)",
        (name, parent_id, time.time()),
    )
    return cur.lastrowid


# Standard 1/3-stop f-numbers (Sony A7R5 uses these increments).
# Round the EXIF FNumber to the closest one for human-readable bucketing.
_F_STOP_BUCKETS = [
    1.4, 1.6, 1.8, 2.0, 2.2, 2.5, 2.8, 3.2, 3.5, 4.0, 4.5, 5.0,
    5.6, 6.3, 7.1, 8.0, 9.0, 10.0, 11.0, 13.0, 14.0, 16.0, 18.0, 20.0, 22.0,
]


def _bucket_focal(mm: float) -> str | None:
    """Round focal length to nearest 100mm. < 50mm gets its own bucket."""
    if mm <= 0:
        return None
    if mm < 50:
        return f"{int(round(mm / 10) * 10)}mm"
    bucket = int(round(mm / 100) * 100)
    return f"{bucket}mm"


def _bucket_f_number(f: float) -> str | None:
    """Round f-number to the nearest standard 1/3-stop label."""
    if f <= 0:
        return None
    closest = min(_F_STOP_BUCKETS, key=lambda s: abs(s - f))
    return f"f/{closest:g}"  # %g strips trailing zero: 4.0 → "4", 5.6 → "5.6"


def _apply_auto_tags(folder_id: int) -> None:
    """Auto-create tags from the photo's persisted EXIF columns and attach
    them to matching photos.

    Tag tree built (under '拍摄参数' parent):
      ISO   → 'ISO 100', 'ISO 12800', …          (exact value)
      镜头  → 'FE 200-600mm F5.6-6.3 G OSS', …   (full lens model string)
      焦距  → '200mm', '300mm', …                 (rounded to nearest 100mm)
      光圈  → 'f/4', 'f/5.6', 'f/6.3', …          (nearest 1/3 stop)

    Uses INSERT OR IGNORE so re-running is idempotent. Doesn't remove old
    auto-tags from photos whose EXIF changed (rare on raw files)."""
    with tx() as conn:
        rows = conn.execute(
            "SELECT id, iso, lens_model, focal_length, f_number FROM photos "
            "WHERE folder_id=? AND deleted_at IS NULL",
            (folder_id,),
        ).fetchall()
        if not rows:
            return

        iso_groups: dict[int, list[int]] = {}
        lens_groups: dict[str, list[int]] = {}
        focal_groups: dict[str, list[int]] = {}
        fnum_groups: dict[str, list[int]] = {}
        for r in rows:
            if r["iso"]:
                iso_groups.setdefault(int(r["iso"]), []).append(r["id"])
            if r["lens_model"]:
                lens_groups.setdefault(r["lens_model"].strip(), []).append(r["id"])
            if r["focal_length"]:
                lbl = _bucket_focal(float(r["focal_length"]))
                if lbl:
                    focal_groups.setdefault(lbl, []).append(r["id"])
            if r["f_number"]:
                lbl = _bucket_f_number(float(r["f_number"]))
                if lbl:
                    fnum_groups.setdefault(lbl, []).append(r["id"])

        if not (iso_groups or lens_groups or focal_groups or fnum_groups):
            return

        root = _get_or_create_tag(conn, "拍摄参数")

        def _attach_group(parent_name: str, groups: dict, sort_key=None):
            if not groups:
                return
            parent = _get_or_create_tag(conn, parent_name, parent_id=root)
            items = sorted(groups.items(), key=sort_key) if sort_key else groups.items()
            for name, pids in items:
                tid = _get_or_create_tag(conn, str(name) if not isinstance(name, str) else name, parent_id=parent)
                conn.executemany(
                    "INSERT OR IGNORE INTO photo_tags(photo_id, tag_id) VALUES(?, ?)",
                    [(pid, tid) for pid in pids],
                )

        _attach_group("ISO", {f"ISO {v}": pids for v, pids in iso_groups.items()},
                     sort_key=lambda kv: int(kv[0].split()[1]))
        _attach_group("镜头", lens_groups)
        _attach_group("焦距", focal_groups,
                     sort_key=lambda kv: int(kv[0].rstrip("m")))
        _attach_group("光圈", fnum_groups,
                     sort_key=lambda kv: float(kv[0].split("/")[1]))


def scan_folder(
    folder: str | Path,
    progress: ScanProgress | None = None,
    max_workers: int = 4,
    on_update: Callable[[ScanProgress], None] | None = None,
) -> ScanProgress:
    folder = Path(folder).expanduser().resolve()
    if not folder.is_dir():
        raise ValueError(f"not a directory: {folder}")

    progress = progress or ScanProgress()
    progress.phase = "scanning"
    if on_update:
        on_update(progress)

    folder_id = _register_folder(folder)
    files = discover_files(folder)
    existing = _existing_paths(folder_id)

    todo: list[Path] = []
    for f in files:
        key = str(f)
        st = f.stat()
        prev = existing.get(key)
        if (
            prev
            and prev.get("analyzed_at")
            and prev.get("mtime") == st.st_mtime
            and prev.get("size") == st.st_size
        ):
            continue
        todo.append(f)

    progress.total = len(todo)
    progress.done = 0
    progress.failed = 0
    progress.phase = "analyzing"
    if on_update:
        on_update(progress)

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(_analyze_one, f): f for f in todo}
        for fut in as_completed(futures):
            rec = fut.result()
            _upsert_photo(folder_id, rec)
            progress.done += 1
            if rec.get("error"):
                progress.failed += 1
            progress.current_path = rec["path"]
            if on_update:
                on_update(progress)

    progress.phase = "clustering"
    if on_update:
        on_update(progress)
    _cluster_photos(folder_id)

    # AI pass (optional, controlled by progress.run_ai)
    if getattr(progress, "run_ai", True):
        try:
            from app.core.ai_pipeline import run_ai_for_folder
            progress.phase = "ai_analyzing"
            if on_update:
                on_update(progress)

            def _ai_cb(done: int, total: int) -> None:
                progress.total = total
                progress.done = done
                if on_update:
                    on_update(progress)

            run_ai_for_folder(folder_id, on_progress=_ai_cb)
        except Exception as e:
            progress.current_path = f"AI 失败: {type(e).__name__}: {e}"

    _apply_ratings(folder_id)
    _apply_auto_tags(folder_id)

    with tx() as conn:
        conn.execute(
            "UPDATE folders SET last_scanned_at=? WHERE id=?",
            (time.time(), folder_id),
        )

    progress.phase = "done"
    if on_update:
        on_update(progress)
    return progress
