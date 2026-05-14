from __future__ import annotations

import io
import threading
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

from app.core.decode import load_preview


def _normalize(folder: str | None) -> str | None:
    if not folder:
        return None
    return str(Path(folder).expanduser().resolve())

from app.config import API_PORT, SKILL_PRESETS, DEFAULT_SKILL
from app.core.deleter import delete_photos, list_recent_batches
from app.core.exif_writer import write_xmp, clear_xmp
from app.core.file_mover import move_photos
from app.core.scanner import ScanProgress, scan_folder
from app.db.schema import init_db, tx


app = FastAPI(title="tailorbird", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    init_db()


_scan_state: dict = {"progress": ScanProgress(), "thread": None, "folder": None}
_scan_lock = threading.Lock()


class ScanReq(BaseModel):
    folder: str
    run_ai: bool = True


@app.post("/api/scan")
def start_scan(req: ScanReq) -> dict:
    with _scan_lock:
        prev = _scan_state.get("thread")
        if prev and prev.is_alive():
            raise HTTPException(409, "another scan is in progress")
        progress = ScanProgress(run_ai=req.run_ai)
        _scan_state["progress"] = progress
        _scan_state["folder"] = req.folder

        def _runner() -> None:
            try:
                scan_folder(req.folder, progress=progress)
            except Exception as e:
                progress.phase = "error"
                progress.current_path = f"{type(e).__name__}: {e}"

        t = threading.Thread(target=_runner, daemon=True)
        _scan_state["thread"] = t
        t.start()
    return {"started": True, "folder": req.folder}


@app.get("/api/scan/status")
def scan_status() -> dict:
    p: ScanProgress = _scan_state["progress"]
    return asdict(p) | {"folder": _scan_state.get("folder")}


@app.get("/api/photos")
def list_photos(
    folder: Optional[str] = None,
    min_sharpness: float = 0.0,
    only_cluster_best: bool = False,
    include_deleted: bool = False,
    cluster_id: Optional[int] = None,
    limit: int = 1000,
    offset: int = 0,
) -> dict:
    where = ["1=1"]
    params: list = []
    folder = _normalize(folder)
    if folder:
        where.append("photos.folder_id = (SELECT id FROM folders WHERE path=?)")
        params.append(folder)
    if not include_deleted:
        where.append("deleted_at IS NULL")
    if min_sharpness > 0:
        where.append("(subject_sharpness IS NOT NULL AND subject_sharpness >= ?)")
        params.append(min_sharpness)
    if only_cluster_best:
        where.append("is_cluster_best=1")
    if cluster_id is not None:
        where.append("cluster_id=?")
        params.append(cluster_id)
    sql = f"""
        SELECT id, path, stem, ext, width, height, shot_at, subject_sharpness,
               cluster_id, is_cluster_best, user_mark, thumb_path, error
        FROM photos
        WHERE {' AND '.join(where)}
        ORDER BY shot_at IS NULL, shot_at, id
        LIMIT ? OFFSET ?
    """
    with tx() as conn:
        rows = conn.execute(sql, [*params, limit, offset]).fetchall()
        total = conn.execute(
            f"SELECT COUNT(*) AS n FROM photos WHERE {' AND '.join(where)}", params
        ).fetchone()["n"]
    return {"total": total, "items": [dict(r) for r in rows]}


@app.get("/api/similar-groups")
def similar_groups(folder: Optional[str] = None, threshold: int = 16) -> dict:
    """Visually similar photo groups across the whole folder (ignoring time).
    Returns shot-shaped items grouped into clusters of size >= 2."""
    from app.core.similar import find_similar_groups
    folder = _normalize(folder)
    if not folder:
        return {"groups": [], "threshold": threshold}
    with tx() as conn:
        row = conn.execute("SELECT id FROM folders WHERE path=?", (folder,)).fetchone()
    if not row:
        return {"groups": [], "threshold": threshold}
    raw_groups = find_similar_groups(row["id"], threshold)
    import json as _json
    def _maybe_json(v):
        if not v: return None
        try: return _json.loads(v)
        except Exception: return None
    out_groups = []
    for g in raw_groups:
        items = []
        for s in g["shots"]:
            formats = sorted({e.replace(".", "").upper() for e in s["exts_list"]})
            items.append({
                "primary_id": s["primary_id"],
                "stem": s["stem"],
                "formats": formats,
                "member_ids": s["member_ids_list"],
                "shot_at": s["shot_at"],
                "subject_sharpness": s["subj_sharp"],
                "eye_sharpness": s["eye_sharp"],
                "aesthetic_score": s["aes"],
                "bird_confidence": s["conf"],
                "bird_bbox": _maybe_json(s.get("bird_bbox")),
                "eye_xy": _maybe_json(s.get("eye_xy")),
                "rating": s["rating"],
                "pick": bool(s["pick"]),
                "is_flying": bool(s["is_flying"]),
                "is_over": bool(s["is_over"]),
                "is_under": bool(s["is_under"]),
                "focus_weight": s["focus_weight"],
                "eye_visibility": s["eye_visibility"],
                "cluster_id": s["cluster_id"],
                "is_cluster_best": bool(s["is_cluster_best"]),
            })
        out_groups.append({"size": g["size"], "shots": items})
    return {"groups": out_groups, "threshold": threshold}


@app.get("/api/clusters")
def list_clusters(folder: Optional[str] = None) -> dict:
    where = ["deleted_at IS NULL", "cluster_id IS NOT NULL"]
    params: list = []
    folder = _normalize(folder)
    if folder:
        where.append("folder_id = (SELECT id FROM folders WHERE path=?)")
        params.append(folder)
    sql = f"""
        SELECT cluster_id, COUNT(*) AS size,
               MIN(shot_at) AS earliest,
               MAX(subject_sharpness) AS best_score
        FROM photos
        WHERE {' AND '.join(where)}
        GROUP BY cluster_id
        HAVING size > 1
        ORDER BY earliest
    """
    with tx() as conn:
        rows = conn.execute(sql, params).fetchall()
    return {"clusters": [dict(r) for r in rows]}


@app.get("/api/shots")
def list_shots(
    folder: Optional[str] = None,
    min_sharpness: float = 0.0,
    only_cluster_best: bool = False,
    cluster_id: Optional[int] = None,
    tag_ids: Optional[str] = None,    # comma-separated tag ids
    tag_mode: str = "or",             # 'or' | 'and'
    untagged: bool = False,           # only return shots where no sibling has any tag
    limit: int = 5000,
    offset: int = 0,
) -> dict:
    """Return one entry per shot (grouped by stem).

    If tag_ids is given, shots are filtered so they have at least one (or-mode)
    or all (and-mode) of the given tags on any sibling photo. Works across
    folders when `folder` is omitted."""
    folder = _normalize(folder)
    where = ["deleted_at IS NULL"]
    params: list = []
    if folder:
        where.append("folder_id = (SELECT id FROM folders WHERE path=?)")
        params.append(folder)
    if cluster_id is not None:
        where.append("cluster_id=?")
        params.append(cluster_id)
    tag_id_list: list[int] = []
    if tag_ids:
        try:
            tag_id_list = [int(x) for x in tag_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(400, "tag_ids must be comma-separated integers")
    if untagged:
        where.append(
            """(folder_id, stem) NOT IN (
                SELECT p2.folder_id, p2.stem FROM photos p2
                JOIN photo_tags pt ON pt.photo_id = p2.id
                WHERE p2.deleted_at IS NULL
            )"""
        )
    if tag_id_list:
        # For AND-mode we need to know which descendant set satisfies each
        # requested tag, so expand them per-tag (not as a flat union).
        with tx() as _conn:
            per_tag_descendants: list[set[int]] = [
                _descendant_tag_ids(_conn, [tid]) for tid in tag_id_list
            ]
        if tag_mode == "and":
            # For each requested tag (with its descendants), the shot must have
            # at least one photo_tags row pointing into that set.
            for desc_set in per_tag_descendants:
                if not desc_set:
                    where.append("0")  # impossible
                    continue
                ph = ",".join(["?"] * len(desc_set))
                where.append(
                    f"""(folder_id, stem) IN (
                        SELECT p2.folder_id, p2.stem FROM photos p2
                        JOIN photo_tags pt ON pt.photo_id = p2.id
                        WHERE pt.tag_id IN ({ph}) AND p2.deleted_at IS NULL
                    )"""
                )
                params.extend(list(desc_set))
        else:
            # OR-mode: shot is included if any of the descendants of any
            # requested tag is attached.
            all_desc: set[int] = set()
            for s in per_tag_descendants:
                all_desc |= s
            if all_desc:
                ph = ",".join(["?"] * len(all_desc))
                where.append(
                    f"""(folder_id, stem) IN (
                        SELECT p2.folder_id, p2.stem FROM photos p2
                        JOIN photo_tags pt ON pt.photo_id = p2.id
                        WHERE pt.tag_id IN ({ph}) AND p2.deleted_at IS NULL
                    )"""
                )
                params.extend(list(all_desc))

    sql = f"""
        SELECT
            stem,
            MIN(id) AS primary_id,
            GROUP_CONCAT(id) AS member_ids,
            GROUP_CONCAT(ext) AS exts,
            MIN(shot_at) AS shot_at,
            MAX(subject_sharpness) AS subject_sharpness,
            MAX(eye_sharpness) AS eye_sharpness,
            MAX(aesthetic_score) AS aesthetic_score,
            MAX(bird_confidence) AS bird_confidence,
            MAX(bird_bbox) AS bird_bbox,
            MAX(eye_xy) AS eye_xy,
            MAX(rating) AS rating,
            MAX(pick) AS pick,
            MAX(is_flying) AS is_flying,
            MAX(is_over) AS is_over,
            MAX(is_under) AS is_under,
            MAX(focus_weight) AS focus_weight,
            MAX(eye_visibility) AS eye_visibility,
            MAX(cluster_id) AS cluster_id,
            MAX(is_cluster_best) AS is_cluster_best,
            MAX(user_mark) AS user_mark
        FROM photos
        WHERE {' AND '.join(where)}
        GROUP BY folder_id, stem
        ORDER BY shot_at IS NULL, shot_at, primary_id
        LIMIT ? OFFSET ?
    """
    with tx() as conn:
        rows = conn.execute(sql, [*params, limit, offset]).fetchall()
        # Fetch tags for every photo in this page's shots in one shot.
        all_member_ids: list[int] = []
        for r in rows:
            all_member_ids.extend(int(x) for x in r["member_ids"].split(","))
        tags_by_photo: dict[int, list[dict]] = {}
        if all_member_ids:
            placeholders = ",".join(["?"] * len(all_member_ids))
            tag_rows = conn.execute(
                f"""SELECT pt.photo_id, t.id, t.name, t.color
                    FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
                    WHERE pt.photo_id IN ({placeholders})""",
                all_member_ids,
            ).fetchall()
            for tr in tag_rows:
                tags_by_photo.setdefault(tr["photo_id"], []).append(
                    {"id": tr["id"], "name": tr["name"], "color": tr["color"]}
                )
        # For thumbnail we prefer the ARW member's thumb (most accurate preview)
        items = []
        for r in rows:
            d = dict(r)
            member_ids = [int(x) for x in d["member_ids"].split(",")]
            exts = d["exts"].split(",")
            # Pick primary: prefer .arw, then .hif, then anything
            order = {".arw": 0, ".hif": 1, ".heif": 1, ".heic": 1, ".jpg": 2, ".jpeg": 2}
            pairs = sorted(zip(exts, member_ids), key=lambda p: order.get(p[0], 9))
            primary_ext = pairs[0][0]
            primary_id = pairs[0][1]
            formats = sorted({e.replace(".", "").upper() for e in exts})
            if (
                min_sharpness > 0
                and (d["subject_sharpness"] is None or d["subject_sharpness"] < min_sharpness)
            ):
                continue
            if only_cluster_best and not d["is_cluster_best"]:
                continue
            import json as _json
            def _maybe_json(v):
                if not v: return None
                try: return _json.loads(v)
                except Exception: return None
            # Dedup tags across siblings (ARW + HIF should have the same tags,
            # but be defensive in case they drift).
            seen_tag_ids: set[int] = set()
            shot_tags: list[dict] = []
            for mid in member_ids:
                for t in tags_by_photo.get(mid, []):
                    if t["id"] not in seen_tag_ids:
                        seen_tag_ids.add(t["id"])
                        shot_tags.append(t)
            items.append(
                {
                    "primary_id": primary_id,
                    "stem": d["stem"],
                    "formats": formats,
                    "member_ids": member_ids,
                    "tags": shot_tags,
                    "shot_at": d["shot_at"],
                    "subject_sharpness": d["subject_sharpness"],
                    "eye_sharpness": d["eye_sharpness"],
                    "aesthetic_score": d["aesthetic_score"],
                    "bird_confidence": d["bird_confidence"],
                    "bird_bbox": _maybe_json(d["bird_bbox"]),
                    "eye_xy": _maybe_json(d["eye_xy"]),
                    "rating": d["rating"],
                    "pick": bool(d["pick"]),
                    "is_flying": bool(d["is_flying"]),
                    "is_over": bool(d["is_over"]),
                    "is_under": bool(d["is_under"]),
                    "focus_weight": d["focus_weight"],
                    "eye_visibility": d["eye_visibility"],
                    "cluster_id": d["cluster_id"],
                    "is_cluster_best": bool(d["is_cluster_best"]),
                    "user_mark": d["user_mark"],
                }
            )
    return {"total": len(items), "items": items}


@app.get("/api/thumb/{photo_id}")
def get_thumb(photo_id: int):
    with tx() as conn:
        row = conn.execute("SELECT thumb_path FROM photos WHERE id=?", (photo_id,)).fetchone()
    if not row or not row["thumb_path"]:
        raise HTTPException(404, "thumbnail missing")
    p = Path(row["thumb_path"])
    if not p.exists():
        raise HTTPException(404, "thumbnail file missing on disk")
    return FileResponse(p, media_type="image/webp")


@app.get("/api/photo/{photo_id}/detail")
def get_photo_detail(photo_id: int) -> dict:
    """All per-file fields including focus_point JSON for overlay rendering."""
    with tx() as conn:
        row = conn.execute(
            """SELECT id, path, stem, ext, width, height, shot_at, subject_sharpness,
                      eye_sharpness, aesthetic_score, bird_confidence, bird_bbox, eye_xy,
                      eye_visibility, focus_point, focus_weight, is_flying, rating, pick,
                      cluster_id, is_cluster_best, user_mark, error
               FROM photos WHERE id=?""",
            (photo_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "photo not found")
    d = dict(row)
    import json
    for k in ("bird_bbox", "eye_xy", "focus_point"):
        if d.get(k):
            try: d[k] = json.loads(d[k])
            except Exception: pass
    return d


@app.get("/api/full/{photo_id}")
def get_full(photo_id: int, max_side: int = 2400):
    """Return a JPEG preview. Uses the cached medium preview when available
    (avoiding RAW decode entirely); otherwise decodes on demand."""
    with tx() as conn:
        row = conn.execute(
            "SELECT path, medium_path FROM photos WHERE id=?", (photo_id,)
        ).fetchone()
    if not row:
        raise HTTPException(404, "photo not found")

    if row["medium_path"]:
        mp = Path(row["medium_path"])
        if mp.exists():
            return FileResponse(mp, media_type="image/jpeg",
                                headers={"Cache-Control": "public, max-age=86400"})

    p = Path(row["path"])
    if not p.exists():
        raise HTTPException(404, "file missing on disk")
    try:
        img = load_preview(p)
    except Exception as e:
        raise HTTPException(500, f"decode failed: {type(e).__name__}: {e}")
    if max(img.size) > max_side:
        scale = max_side / max(img.size)
        img = img.resize((int(img.size[0] * scale), int(img.size[1] * scale)))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=88)
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/jpeg",
                             headers={"Cache-Control": "public, max-age=86400"})


class DeleteReq(BaseModel):
    photo_ids: list[int]
    pair_with_sidecar: bool = True
    mode: str = "trash"          # "trash" or "move"
    subfolder_name: str = "ToReview"


@app.post("/api/delete")
def delete(req: DeleteReq) -> dict:
    if not req.photo_ids:
        raise HTTPException(400, "no photo_ids provided")
    if req.mode == "move":
        return move_photos(req.photo_ids, subfolder_name=req.subfolder_name,
                           pair_with_sidecar=req.pair_with_sidecar)
    return delete_photos(req.photo_ids, pair_with_sidecar=req.pair_with_sidecar)


class WriteXmpReq(BaseModel):
    photo_ids: list[int]


@app.post("/api/exif/write")
def exif_write(req: WriteXmpReq) -> dict:
    """Write tailorbird's rating/label to original files (XMP, in-place)."""
    return write_xmp(req.photo_ids)


@app.post("/api/exif/clear")
def exif_clear(req: WriteXmpReq) -> dict:
    return clear_xmp(req.photo_ids)


# ---------------- Tags ----------------

class TagCreateReq(BaseModel):
    name: str
    color: Optional[str] = None
    is_favorite: bool = False
    parent_id: Optional[int] = None


class TagPatchReq(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    is_favorite: Optional[bool] = None
    parent_id: Optional[int] = None  # use -1 sentinel to set NULL


class PhotoTagsBatchReq(BaseModel):
    photo_ids: list[int]
    add_tag_ids: list[int] = []
    remove_tag_ids: list[int] = []
    add_tag_names: list[str] = []  # creates if missing; supports "A/B/C" path syntax


def _descendant_tag_ids(conn, tag_ids: list[int]) -> set[int]:
    """Return tag_ids ∪ all transitive descendants via recursive CTE."""
    if not tag_ids:
        return set()
    placeholders = ",".join(["?"] * len(tag_ids))
    rows = conn.execute(
        f"""WITH RECURSIVE d(id) AS (
                SELECT id FROM tags WHERE id IN ({placeholders})
                UNION
                SELECT t.id FROM tags t JOIN d ON t.parent_id = d.id
            ) SELECT id FROM d""",
        tag_ids,
    ).fetchall()
    return {r[0] for r in rows}


def _ancestor_tag_ids(conn, tag_id: int) -> list[int]:
    """Return [tag_id, parent, grandparent, ...] for one tag, leaf-first."""
    out: list[int] = []
    seen: set[int] = set()
    cur: int | None = tag_id
    while cur is not None and cur not in seen:
        seen.add(cur)
        out.append(cur)
        row = conn.execute("SELECT parent_id FROM tags WHERE id = ?", (cur,)).fetchone()
        cur = row["parent_id"] if row else None
    return out


def _resolve_tag_path(conn, path: str, *, create_missing: bool = True) -> int | None:
    """Resolve a slash-separated path like "鸟类/水鸟/白鹭" to a leaf tag id,
    creating intermediates as needed. Returns the leaf id, or None on empty."""
    import time
    parts = [p.strip() for p in path.split("/") if p.strip()]
    if not parts:
        return None
    parent_id: int | None = None
    for i, name in enumerate(parts):
        # Look up by (name, parent_id) — siblings under same parent share a namespace.
        if parent_id is None:
            row = conn.execute(
                "SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND parent_id IS NULL",
                (name,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND parent_id = ?",
                (name, parent_id),
            ).fetchone()
        if row:
            parent_id = row["id"]
        elif create_missing:
            # Names are globally unique (UNIQUE constraint). When the same leaf name
            # appears under different parents we suffix to disambiguate.
            actual_name = name
            tries = 0
            while True:
                try:
                    cur = conn.execute(
                        "INSERT INTO tags (name, parent_id, created_at) VALUES (?, ?, ?)",
                        (actual_name, parent_id, time.time()),
                    )
                    parent_id = cur.lastrowid
                    break
                except Exception:
                    tries += 1
                    if tries > 50:
                        raise
                    # name collision: append disambig suffix
                    actual_name = f"{name} ({tries})"
        else:
            return None
    return parent_id


def _expand_to_siblings(conn, photo_ids: list[int]) -> list[int]:
    """Given primary photo_ids, return ids of all live siblings (same folder + stem)."""
    if not photo_ids:
        return []
    placeholders = ",".join(["?"] * len(photo_ids))
    rows = conn.execute(
        f"""SELECT DISTINCT p2.id
            FROM photos p1 JOIN photos p2
              ON p1.folder_id = p2.folder_id AND p1.stem = p2.stem
            WHERE p1.id IN ({placeholders}) AND p2.deleted_at IS NULL""",
        photo_ids,
    ).fetchall()
    return [r[0] for r in rows]


@app.get("/api/tags")
def list_tags() -> dict:
    with tx() as conn:
        rows = conn.execute(
            """SELECT t.id, t.name, t.color, t.is_favorite, t.parent_id, t.created_at,
                      COUNT(pt.photo_id) AS usage_count
               FROM tags t LEFT JOIN photo_tags pt ON pt.tag_id = t.id
               GROUP BY t.id
               ORDER BY t.is_favorite DESC, t.name COLLATE NOCASE"""
        ).fetchall()
    return {"tags": [dict(r) for r in rows]}


@app.post("/api/tags")
def create_tag(req: TagCreateReq) -> dict:
    import time
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "name is empty")
    with tx() as conn:
        row = conn.execute("SELECT id FROM tags WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
        if row:
            tid = row["id"]
            if req.color is not None or req.is_favorite or req.parent_id is not None:
                conn.execute(
                    "UPDATE tags SET color = COALESCE(?, color), is_favorite = MAX(is_favorite, ?), parent_id = COALESCE(?, parent_id) WHERE id = ?",
                    (req.color, 1 if req.is_favorite else 0, req.parent_id, tid),
                )
        else:
            cur = conn.execute(
                "INSERT INTO tags (name, color, is_favorite, parent_id, created_at) VALUES (?, ?, ?, ?, ?)",
                (name, req.color, 1 if req.is_favorite else 0, req.parent_id, time.time()),
            )
            tid = cur.lastrowid
        out = dict(conn.execute(
            "SELECT id, name, color, is_favorite, parent_id, created_at FROM tags WHERE id = ?", (tid,)
        ).fetchone())
    return out


@app.patch("/api/tags/{tag_id}")
def patch_tag(tag_id: int, req: TagPatchReq) -> dict:
    with tx() as conn:
        if conn.execute("SELECT 1 FROM tags WHERE id = ?", (tag_id,)).fetchone() is None:
            raise HTTPException(404, "tag not found")
        if req.name is not None:
            new_name = req.name.strip()
            if not new_name:
                raise HTTPException(400, "name is empty")
            dup = conn.execute(
                "SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id <> ?",
                (new_name, tag_id),
            ).fetchone()
            if dup:
                raise HTTPException(409, f"tag name already exists (id={dup['id']})")
            conn.execute("UPDATE tags SET name = ? WHERE id = ?", (new_name, tag_id))
        if req.color is not None:
            conn.execute("UPDATE tags SET color = ? WHERE id = ?", (req.color, tag_id))
        if req.is_favorite is not None:
            conn.execute("UPDATE tags SET is_favorite = ? WHERE id = ?", (1 if req.is_favorite else 0, tag_id))
        if req.parent_id is not None:
            # -1 sentinel = set to NULL (move to root)
            new_parent = None if req.parent_id == -1 else req.parent_id
            if new_parent is not None:
                if new_parent == tag_id:
                    raise HTTPException(400, "tag cannot be its own parent")
                if conn.execute("SELECT 1 FROM tags WHERE id = ?", (new_parent,)).fetchone() is None:
                    raise HTTPException(400, f"parent tag {new_parent} does not exist")
                # Cycle check: new_parent must not be a descendant of tag_id
                descendants = _descendant_tag_ids(conn, [tag_id])
                if new_parent in descendants:
                    raise HTTPException(400, "cycle: new parent is a descendant of this tag")
            conn.execute("UPDATE tags SET parent_id = ? WHERE id = ?", (new_parent, tag_id))
        out = dict(conn.execute(
            "SELECT id, name, color, is_favorite, parent_id, created_at FROM tags WHERE id = ?", (tag_id,)
        ).fetchone())
    return out


class MoveTagToSubfolderReq(BaseModel):
    tag_id: int


@app.post("/api/move-tag-to-subfolder")
def move_tag_to_subfolder(req: MoveTagToSubfolderReq) -> dict:
    """Move every photo carrying `tag_id` (or descendant) into a `<tag_name>/`
    subfolder of its OWN source directory. ARW + HIF kept together. Uses the
    same move-to-subfolder convention as the existing 'move to ToReview' flow,
    so photos are marked deleted in tailorbird but visible in Finder right
    next to where they originally lived."""
    with tx() as conn:
        tag_row = conn.execute("SELECT name FROM tags WHERE id = ?", (req.tag_id,)).fetchone()
        if tag_row is None:
            raise HTTPException(404, "tag not found")
        tag_name = tag_row["name"]
        descendants = _descendant_tag_ids(conn, [req.tag_id])
        if not descendants:
            return {"tag_id": req.tag_id, "tag_name": tag_name, "moved": [], "failed": []}
        ph = ",".join(["?"] * len(descendants))
        rows = conn.execute(
            f"""SELECT DISTINCT p.id
                FROM photos p JOIN photo_tags pt ON pt.photo_id = p.id
                WHERE pt.tag_id IN ({ph}) AND p.deleted_at IS NULL""",
            list(descendants),
        ).fetchall()
        photo_ids = [r["id"] for r in rows]
    if not photo_ids:
        return {"tag_id": req.tag_id, "tag_name": tag_name, "moved": [], "failed": []}
    result = move_photos(photo_ids, subfolder_name=tag_name, pair_with_sidecar=True)
    return {"tag_id": req.tag_id, "tag_name": tag_name, **result}


class ExportTagReq(BaseModel):
    tag_id: int
    dest_dir: str
    subfolder_name: Optional[str] = None     # default: tag's own name
    mode: str = "copy"                        # 'copy' | 'move'
    pair_with_sidecar: bool = True


@app.post("/api/export-tag")
def export_tag(req: ExportTagReq) -> dict:
    """Copy or move every photo that carries `tag_id` (or any descendant tag,
    Lightroom-style) into `<dest_dir>/<subfolder_name>/`. ARW + HIF siblings
    are kept together when pair_with_sidecar is true."""
    import shutil
    import time
    import uuid

    if req.mode not in ("copy", "move"):
        raise HTTPException(400, "mode must be 'copy' or 'move'")

    with tx() as conn:
        tag_row = conn.execute("SELECT name FROM tags WHERE id = ?", (req.tag_id,)).fetchone()
        if tag_row is None:
            raise HTTPException(404, "tag not found")
        tag_name = tag_row["name"]
        descendants = _descendant_tag_ids(conn, [req.tag_id])
        if not descendants:
            return {"tag_id": req.tag_id, "destination": None, "exported": [], "failed": []}

        ph = ",".join(["?"] * len(descendants))
        photo_rows = conn.execute(
            f"""SELECT DISTINCT p.id, p.path, p.stem, p.ext, p.folder_id
                FROM photos p JOIN photo_tags pt ON pt.photo_id = p.id
                WHERE pt.tag_id IN ({ph}) AND p.deleted_at IS NULL""",
            list(descendants),
        ).fetchall()
        targets = [dict(r) for r in photo_rows]

        if req.pair_with_sidecar and targets:
            keys = {(r["folder_id"], r["stem"]) for r in targets}
            seen = {r["path"] for r in targets}
            placeholders = " OR ".join(["(folder_id=? AND stem=?)"] * len(keys))
            params: list = []
            for fid, stem in keys:
                params.extend([fid, stem])
            sidecars = conn.execute(
                f"SELECT id, path, stem, ext, folder_id FROM photos "
                f"WHERE ({placeholders}) AND deleted_at IS NULL",
                params,
            ).fetchall()
            for s in sidecars:
                if s["path"] not in seen:
                    targets.append(dict(s))
                    seen.add(s["path"])

    base = Path(req.dest_dir).expanduser().resolve()
    if not base.exists():
        raise HTTPException(400, f"destination base does not exist: {base}")
    if not base.is_dir():
        raise HTTPException(400, f"destination is not a directory: {base}")
    subfolder = (req.subfolder_name or tag_name).strip().replace("/", "_") or tag_name
    dest = base / subfolder
    dest.mkdir(parents=True, exist_ok=True)

    successes: list[dict] = []
    failures: list[dict] = []
    for rec in targets:
        src = Path(rec["path"])
        if not src.exists():
            failures.append({**rec, "error": "source missing"}); continue
        if src.resolve() == dest.resolve() / src.name:
            successes.append({**rec, "new_path": str(src), "skipped": True}); continue
        dst = dest / src.name
        if dst.exists():
            dst = dest / f"{src.stem}_{int(time.time())}{src.suffix}"
        try:
            if req.mode == "copy":
                shutil.copy2(str(src), str(dst))
            else:
                shutil.move(str(src), str(dst))
            successes.append({**rec, "new_path": str(dst)})
        except Exception as e:
            failures.append({**rec, "error": f"{type(e).__name__}: {e}"})

    # For 'move' mode, mark moved photos as 'deleted' in tailorbird's DB so
    # they disappear from views. (Files still exist on disk, just outside the
    # scanned source folder.) Same convention as the move-to-ToReview flow.
    if req.mode == "move" and successes:
        now = time.time()
        batch_id = uuid.uuid4().hex
        with tx() as conn:
            for rec in successes:
                if rec.get("skipped"):
                    continue
                conn.execute(
                    "INSERT INTO deletion_history(batch_id, photo_id, original_path, deleted_at) VALUES(?, ?, ?, ?)",
                    (batch_id, rec["id"], rec["path"], now),
                )
                conn.execute("UPDATE photos SET deleted_at = ? WHERE id = ?", (now, rec["id"]))

    return {
        "tag_id": req.tag_id,
        "tag_name": tag_name,
        "destination": str(dest),
        "mode": req.mode,
        "exported": [r.get("new_path") for r in successes if not r.get("skipped")],
        "skipped": [r["path"] for r in successes if r.get("skipped")],
        "failed": failures,
    }


@app.delete("/api/tags/{tag_id}")
def delete_tag(tag_id: int, children: str = "lift") -> dict:
    """children='lift' (default): re-parent direct children to this tag's parent;
       children='orphan': leave children as roots (parent_id NULL);
       children='cascade': delete all descendants too."""
    if children not in ("lift", "orphan", "cascade"):
        raise HTTPException(400, "children must be one of: lift, orphan, cascade")
    with tx() as conn:
        row = conn.execute("SELECT parent_id FROM tags WHERE id = ?", (tag_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "tag not found")
        if children == "cascade":
            desc = _descendant_tag_ids(conn, [tag_id])
            if desc:
                ph = ",".join(["?"] * len(desc))
                conn.execute(f"DELETE FROM photo_tags WHERE tag_id IN ({ph})", list(desc))
                conn.execute(f"DELETE FROM tags WHERE id IN ({ph})", list(desc))
        else:
            new_parent = row["parent_id"] if children == "lift" else None
            conn.execute("UPDATE tags SET parent_id = ? WHERE parent_id = ?", (new_parent, tag_id))
            conn.execute("DELETE FROM photo_tags WHERE tag_id = ?", (tag_id,))
            conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    return {"deleted": tag_id, "mode": children}


@app.post("/api/photo-tags/batch")
def batch_photo_tags(req: PhotoTagsBatchReq) -> dict:
    """Attach/detach tags on a set of shots (input is primary photo_ids;
    backend expands to all live siblings sharing the same stem, so ARW+HIF
    move together). add_tag_names creates tags on the fly."""
    import time
    if not req.photo_ids:
        raise HTTPException(400, "photo_ids is empty")
    created_ids: list[int] = []
    with tx() as conn:
        sibling_ids = _expand_to_siblings(conn, req.photo_ids)
        if not sibling_ids:
            return {"attached": 0, "detached": 0, "created_tag_ids": [], "affected_photo_ids": []}

        add_ids = set(req.add_tag_ids)
        for raw in req.add_tag_names:
            name = raw.strip()
            if not name:
                continue
            if "/" in name:
                # Slash-separated path: build intermediate tree nodes as needed,
                # attach the leaf to the photo. Newly-created tags are reported.
                before = set(r[0] for r in conn.execute("SELECT id FROM tags").fetchall())
                leaf_id = _resolve_tag_path(conn, name, create_missing=True)
                if leaf_id is not None:
                    add_ids.add(leaf_id)
                    after = set(r[0] for r in conn.execute("SELECT id FROM tags").fetchall())
                    created_ids.extend(sorted(after - before))
            else:
                row = conn.execute("SELECT id FROM tags WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
                if row:
                    add_ids.add(row["id"])
                else:
                    cur = conn.execute(
                        "INSERT INTO tags (name, created_at) VALUES (?, ?)",
                        (name, time.time()),
                    )
                    add_ids.add(cur.lastrowid)
                    created_ids.append(cur.lastrowid)

        attached = 0
        for pid in sibling_ids:
            for tid in add_ids:
                cur = conn.execute(
                    "INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)",
                    (pid, tid),
                )
                attached += cur.rowcount

        detached = 0
        if req.remove_tag_ids:
            placeholders_p = ",".join(["?"] * len(sibling_ids))
            placeholders_t = ",".join(["?"] * len(req.remove_tag_ids))
            cur = conn.execute(
                f"DELETE FROM photo_tags WHERE photo_id IN ({placeholders_p}) AND tag_id IN ({placeholders_t})",
                [*sibling_ids, *req.remove_tag_ids],
            )
            detached = cur.rowcount

    return {
        "attached": attached,
        "detached": detached,
        "created_tag_ids": created_ids,
        "affected_photo_ids": sibling_ids,
    }


@app.get("/api/presets")
def list_presets() -> dict:
    return {"presets": SKILL_PRESETS, "default": DEFAULT_SKILL}


class ApplyPresetReq(BaseModel):
    folder: Optional[str] = None
    preset: str = DEFAULT_SKILL


@app.post("/api/presets/apply")
def apply_preset(req: ApplyPresetReq) -> dict:
    """Re-compute ratings using a different skill preset, without re-scanning."""
    from app.core.scanner import _apply_ratings

    folder = _normalize(req.folder)
    if req.preset not in SKILL_PRESETS:
        raise HTTPException(400, f"unknown preset: {req.preset}")
    with tx() as conn:
        if folder:
            row = conn.execute("SELECT id FROM folders WHERE path=?", (folder,)).fetchone()
            if not row:
                raise HTTPException(404, "folder not found")
            fids = [row["id"]]
        else:
            fids = [r["id"] for r in conn.execute("SELECT id FROM folders").fetchall()]
    for fid in fids:
        _apply_ratings(fid, skill=req.preset)
    return {"applied": req.preset, "folders": len(fids)}


@app.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: int) -> dict:
    """Remove a folder from tailorbird (DB records + thumbnail cache).
    Does NOT touch the original photo files on disk."""
    import os
    with tx() as conn:
        row = conn.execute("SELECT id, path FROM folders WHERE id = ?", (folder_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "folder not found")
        folder_path = row["path"]
        thumb_rows = conn.execute(
            "SELECT thumb_path FROM photos WHERE folder_id = ? AND thumb_path IS NOT NULL",
            (folder_id,),
        ).fetchall()
        photo_count = conn.execute(
            "SELECT COUNT(*) FROM photos WHERE folder_id = ?", (folder_id,),
        ).fetchone()[0]
        # photo_tags + deletion_history cleanup via subquery
        conn.execute(
            "DELETE FROM photo_tags WHERE photo_id IN (SELECT id FROM photos WHERE folder_id = ?)",
            (folder_id,),
        )
        conn.execute(
            "DELETE FROM deletion_history WHERE photo_id IN (SELECT id FROM photos WHERE folder_id = ?)",
            (folder_id,),
        )
        conn.execute("DELETE FROM photos WHERE folder_id = ?", (folder_id,))
        conn.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
    # Best-effort thumbnail cleanup (don't fail the request if removal fails)
    removed_thumbs = 0
    for r in thumb_rows:
        tp = r["thumb_path"]
        if not tp:
            continue
        try:
            if os.path.exists(tp):
                os.remove(tp); removed_thumbs += 1
        except Exception:
            pass
    return {
        "deleted_folder_id": folder_id,
        "path": folder_path,
        "photos_removed": photo_count,
        "thumbs_removed": removed_thumbs,
    }


@app.get("/api/folders")
def list_folders() -> dict:
    with tx() as conn:
        rows = conn.execute(
            """
            SELECT folders.id, folders.path, folders.last_scanned_at,
                   COUNT(photos.id) AS photo_count,
                   SUM(CASE WHEN photos.deleted_at IS NULL THEN 1 ELSE 0 END) AS alive_count
            FROM folders
            LEFT JOIN photos ON photos.folder_id = folders.id
            GROUP BY folders.id
            ORDER BY folders.last_scanned_at DESC NULLS LAST
            """
        ).fetchall()
    return {"folders": [dict(r) for r in rows]}


@app.get("/api/history")
def history() -> dict:
    return {"batches": list_recent_batches(20)}


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "port": API_PORT}


class AnnotateReq(BaseModel):
    photo_id: int
    bird_bbox: list[float]                    # [x, y, w, h] normalized 0-1
    eye_xy: Optional[list[float]] = None      # [x, y] normalized 0-1, optional


@app.post("/api/annotate")
def annotate(req: AnnotateReq) -> dict:
    """Manual override: set bird_bbox (and optional eye position) for a photo
    whose AI detection was wrong or missed. Recomputes eye_sharpness, subject
    sharpness, focus_weight, and rating. Applies to all sidecar members
    (ARW+HIF same stem)."""
    import json as _json
    import numpy as np
    from app.core.ai_pipeline import _focus_weight
    from app.core.decode import load_preview
    from app.core.scanner import _apply_ratings
    from app.core.sharpness import sharpness_score

    if len(req.bird_bbox) != 4:
        raise HTTPException(400, "bird_bbox must be [x, y, w, h]")
    bx, by, bw, bh = req.bird_bbox
    if not (0 <= bx <= 1 and 0 <= by <= 1 and 0 < bw <= 1 and 0 < bh <= 1):
        raise HTTPException(400, "bird_bbox out of range")
    if bx + bw > 1.001 or by + bh > 1.001:
        raise HTTPException(400, "bird_bbox extends outside image")

    with tx() as conn:
        row = conn.execute(
            "SELECT id, path, stem, folder_id, focus_point FROM photos WHERE id=?",
            (req.photo_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "photo not found")
    p = Path(row["path"])
    if not p.exists():
        raise HTTPException(404, "file missing")

    try:
        img = load_preview(p)
    except Exception as e:
        raise HTTPException(500, f"decode failed: {type(e).__name__}: {e}")
    W, H = img.size
    bbox_px = (int(bx * W), int(by * H), int(bw * W), int(bh * H))

    arr = np.asarray(img.convert("L"))
    bird_crop = arr[bbox_px[1]:bbox_px[1] + bbox_px[3], bbox_px[0]:bbox_px[0] + bbox_px[2]]
    subj_sharp = float(sharpness_score(bird_crop)) if bird_crop.size > 64 else None

    eye_sharp = None
    eye_norm = None
    eye_xy_px = None
    if req.eye_xy and len(req.eye_xy) == 2:
        ex_n, ey_n = req.eye_xy
        if 0 <= ex_n <= 1 and 0 <= ey_n <= 1:
            eye_norm = [ex_n, ey_n]
            eye_xy_px = (ex_n * W, ey_n * H)
            side = max(48, int(min(bbox_px[2], bbox_px[3]) / 8))
            x0 = max(0, int(ex_n * W - side / 2))
            y0 = max(0, int(ey_n * H - side / 2))
            x1 = min(W, x0 + side)
            y1 = min(H, y0 + side)
            eye_crop = arr[y0:y1, x0:x1]
            if eye_crop.size > 64:
                eye_sharp = float(sharpness_score(eye_crop))

    focus = _json.loads(row["focus_point"]) if row["focus_point"] else None
    fw = _focus_weight(focus, bbox_px, eye_xy_px, (W, H)) if focus else 1.0

    with tx() as conn:
        members = conn.execute(
            "SELECT id FROM photos WHERE folder_id=? AND stem=? AND deleted_at IS NULL",
            (row["folder_id"], row["stem"]),
        ).fetchall()
        for m in members:
            conn.execute(
                """UPDATE photos SET
                     bird_confidence = 1.0,
                     bird_bbox = ?,
                     eye_xy = ?,
                     eye_sharpness = ?,
                     subject_sharpness = COALESCE(?, subject_sharpness),
                     focus_weight = ?,
                     eye_visibility = ?
                   WHERE id=?""",
                (
                    _json.dumps(req.bird_bbox),
                    _json.dumps(eye_norm) if eye_norm else None,
                    eye_sharp,
                    subj_sharp,
                    fw,
                    1.0 if eye_norm else None,
                    m["id"],
                ),
            )

    _apply_ratings(row["folder_id"])
    return {
        "photo_id": req.photo_id,
        "members_updated": len(members),
        "subject_sharpness": subj_sharp,
        "eye_sharpness": eye_sharp,
        "focus_weight": fw,
    }


class OpenFolderReq(BaseModel):
    path: str


@app.post("/api/pick-folder")
def pick_folder() -> dict:
    """Launch the native macOS folder picker. Returns the chosen absolute path,
    or {canceled: true} if the user dismissed the dialog. Local-only convenience."""
    import subprocess
    try:
        r = subprocess.run(
            ["osascript", "-e",
             'POSIX path of (choose folder with prompt "选择照片目录")'],
            capture_output=True, text=True, timeout=120,
        )
    except Exception as e:
        raise HTTPException(500, f"picker failed: {type(e).__name__}: {e}")
    if r.returncode != 0:
        # User canceled — osascript returns non-zero on cancel.
        return {"path": None, "canceled": True}
    path = r.stdout.strip().rstrip("/")
    return {"path": path or None, "canceled": False}


class RevealReq(BaseModel):
    photo_id: int


@app.post("/api/reveal")
def reveal_in_finder(req: RevealReq) -> dict:
    """Open Finder with the photo's file highlighted. macOS `open -R`."""
    import subprocess
    with tx() as conn:
        row = conn.execute(
            "SELECT path FROM photos WHERE id = ? AND deleted_at IS NULL",
            (req.photo_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "photo not found")
    path = Path(row["path"])
    if not path.exists():
        raise HTTPException(404, f"file missing on disk: {path}")
    try:
        subprocess.run(["open", "-R", str(path)], check=True, timeout=5)
        return {"revealed": str(path)}
    except Exception as e:
        raise HTTPException(500, f"open failed: {type(e).__name__}: {e}")


@app.post("/api/open-folder")
def open_folder(req: OpenFolderReq) -> dict:
    """Reveal a folder in Finder. Restricted to subpaths of folders we've scanned
    so the localhost endpoint can't be abused to open arbitrary locations."""
    import subprocess
    target = Path(req.path).expanduser().resolve()
    if not target.exists():
        raise HTTPException(404, f"path does not exist: {target}")
    with tx() as conn:
        ok = conn.execute(
            "SELECT 1 FROM folders WHERE ? LIKE path || '%'", (str(target),)
        ).fetchone()
    if not ok:
        raise HTTPException(403, "path is outside any scanned folder")
    try:
        subprocess.run(["open", str(target)], check=True, timeout=5)
        return {"opened": str(target)}
    except Exception as e:
        raise HTTPException(500, f"open failed: {type(e).__name__}: {e}")


@app.get("/api/find-move-target")
def find_move_target(folder: str = Query(...), name: str = Query("ToReview")) -> dict:
    """Find subdirectories named `name` under `folder` (recursively).

    `move_photos` creates ToReview alongside each photo, so when photos live in
    `<scan>/100MSDCF/`, ToReview ends up at `<scan>/100MSDCF/ToReview/` — not
    `<scan>/ToReview/`. The button needs to discover the real location.
    """
    root = Path(_normalize(folder) or "")
    if not root.exists() or not root.is_dir():
        raise HTTPException(404, f"folder not found: {root}")
    matches: list[dict] = []
    for p in root.rglob(name):
        if p.is_dir():
            try:
                file_count = sum(1 for _ in p.iterdir() if _.is_file())
                mtime = p.stat().st_mtime
            except OSError:
                continue
            matches.append({"path": str(p), "file_count": file_count, "mtime": mtime})
    matches.sort(key=lambda m: m["mtime"], reverse=True)
    return {"matches": matches}


class EmptyMoveTargetReq(BaseModel):
    folder: str
    name: str = "ToReview"
    remove_empty_dirs: bool = True


@app.post("/api/empty-move-target")
def empty_move_target(req: EmptyMoveTargetReq) -> dict:
    """Send every file inside <folder>/**/{name}/ to system trash.

    Use case: user has reviewed the ToReview subfolders in Finder and wants to
    permanently discard them in one click. Files go to system trash (recoverable),
    not direct rm.
    """
    from send2trash import send2trash

    root = Path(_normalize(req.folder) or "")
    if not root.exists() or not root.is_dir():
        raise HTTPException(404, f"folder not found: {root}")
    # Safety: only operate inside scanned folders
    with tx() as conn:
        ok = conn.execute(
            "SELECT 1 FROM folders WHERE ? LIKE path || '%'", (str(root),)
        ).fetchone()
    if not ok:
        raise HTTPException(403, "folder is outside any scanned folder")

    trashed: list[str] = []
    failed: list[dict] = []
    emptied_dirs: list[str] = []

    for sub in root.rglob(req.name):
        if not sub.is_dir():
            continue
        for f in sub.iterdir():
            if not f.is_file():
                continue
            try:
                send2trash(str(f))
                trashed.append(str(f))
            except Exception as e:
                failed.append({"path": str(f), "error": f"{type(e).__name__}: {e}"})
        if req.remove_empty_dirs:
            try:
                if not any(sub.iterdir()):
                    sub.rmdir()
                    emptied_dirs.append(str(sub))
            except OSError:
                pass

    return {
        "trashed_count": len(trashed),
        "trashed": trashed,
        "failed": failed,
        "emptied_dirs": emptied_dirs,
    }


class RecomputeReq(BaseModel):
    folder: Optional[str] = None
    run_ai: bool = False
    preset: str = DEFAULT_SKILL


@app.post("/api/recompute")
def recompute(req: RecomputeReq) -> dict:
    """Re-run clustering + ratings (optionally re-runs AI) without rescanning files."""
    from app.core.scanner import _cluster_photos, _apply_ratings

    folder = _normalize(req.folder)
    with tx() as conn:
        if folder:
            row = conn.execute("SELECT id FROM folders WHERE path=?", (folder,)).fetchone()
            if not row:
                raise HTTPException(404, "folder not found")
            folder_ids = [row["id"]]
        else:
            folder_ids = [r["id"] for r in conn.execute("SELECT id FROM folders").fetchall()]

    for fid in folder_ids:
        _cluster_photos(fid)
        if req.run_ai:
            with _scan_lock:
                prev = _scan_state.get("thread")
                if prev and prev.is_alive():
                    raise HTTPException(409, "another scan/AI is in progress")
                progress = ScanProgress(run_ai=True)
                progress.phase = "ai_analyzing"
                _scan_state["progress"] = progress

                def _runner(fid=fid) -> None:
                    try:
                        from app.core.ai_pipeline import run_ai_for_folder
                        def _cb(d, t):
                            progress.done = d; progress.total = t
                        run_ai_for_folder(fid, on_progress=_cb)
                        _apply_ratings(fid, skill=req.preset)
                        progress.phase = "done"
                    except Exception as e:
                        progress.phase = "error"
                        progress.current_path = f"{type(e).__name__}: {e}"

                t = threading.Thread(target=_runner, daemon=True)
                _scan_state["thread"] = t
                t.start()
            return {"recomputed": len(folder_ids), "ai_started": True}
        else:
            _apply_ratings(fid, skill=req.preset)
    return {"recomputed": len(folder_ids), "ai_started": False}
