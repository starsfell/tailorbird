"""Orchestrates AI analysis as a single shot-level pass.

Runs after clustering (so we know shot membership), iterating over shots and
applying YOLO + keypoint + TOPIQ to the primary file of each shot. Scores are
propagated to all members (ARW + HIF) of the same shot.
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Callable

import numpy as np

from app.config import MEDIUM_DIR
from app.core.decode import load_preview
from app.core.exposure import detect_exposure
from app.core.sharpness import sharpness_score
from app.db.schema import tx


def _focus_weight(focus: dict | None, bird_bbox_px: tuple[int, int, int, int],
                   eye_xy_px: tuple[float, float] | None,
                   img_size: tuple[int, int]) -> float:
    """Compute focus weight: 1.1 head / 1.0 inside bbox / 0.7 just outside / 0.5 far."""
    if not focus:
        return 1.0
    iw = focus.get("image_w") or img_size[0]
    ih = focus.get("image_h") or img_size[1]
    # focus may be in a different coord space than img_size; scale to img_size
    fx = focus["x"] * img_size[0] / iw if iw else focus["x"]
    fy = focus["y"] * img_size[1] / ih if ih else focus["y"]

    bx, by, bw, bh = bird_bbox_px
    diag = math.hypot(bw, bh)

    if eye_xy_px:
        ex, ey = eye_xy_px
        d_eye = math.hypot(fx - ex, fy - ey)
        if d_eye < diag * 0.08:
            return 1.1

    if bx <= fx <= bx + bw and by <= fy <= by + bh:
        return 1.0
    # outside bbox: check how far
    cx, cy = bx + bw / 2, by + bh / 2
    d_center = math.hypot(fx - cx, fy - cy)
    if d_center < diag:
        return 0.7
    return 0.5


def _eye_sharpness(img_arr_gray: np.ndarray, eye_box: tuple[int, int, int, int]) -> float:
    x, y, w, h = eye_box
    H, W = img_arr_gray.shape
    x = max(0, min(W - 1, x)); y = max(0, min(H - 1, y))
    w = max(1, min(W - x, w)); h = max(1, min(H - y, h))
    crop = img_arr_gray[y:y + h, x:x + w]
    if crop.size < 64:
        return 0.0
    return sharpness_score(crop)


def _save_medium(img, primary_path: Path) -> str | None:
    """Medium preview caching is disabled to save disk space. The /api/full
    endpoint falls back to live ARW preview extraction (~50ms per request)
    which is fast enough for interactive use."""
    return None


def run_ai_on_shot(primary_path: Path) -> dict:
    """Run full AI pipeline on a single image. Returns dict suitable for DB update."""
    from app.core import ai_flying, ai_keypoint, ai_topiq, ai_yolo

    img = load_preview(primary_path)
    W, H = img.size
    medium_path = _save_medium(img, primary_path)

    birds = ai_yolo.detect_birds(img, conf=0.30)
    if not birds:
        try:
            aes = ai_topiq.aesthetic_score(img)
        except Exception:
            aes = None
        return {
            "bird_confidence": 0.0, "bird_bbox": None,
            "eye_sharpness": None, "eye_xy": None, "eye_visibility": None,
            "aesthetic_score": aes, "focus_weight": 1.0,
            "is_flying": 0, "flying_confidence": None,
            "is_over": 0, "is_under": 0, "over_ratio": 0.0, "under_ratio": 0.0,
            "medium_path": medium_path,
        }

    top = birds[0]
    bx, by, bw, bh = top["bbox_px"]
    crop = img.crop((bx, by, bx + bw, by + bh))

    try:
        kp = ai_keypoint.detect_keypoints(crop)
    except Exception:
        kp = None

    eye_xy_px = None
    eye_visibility = None
    eye_sharp = None
    if kp:
        eye_visibility = kp["best_eye_visibility"]
        le, re_ = kp["left_eye"], kp["right_eye"]
        ex_n, ey_n = le if kp["left_eye_vis"] >= kp["right_eye_vis"] else re_
        eye_xy_px = (bx + ex_n * bw, by + ey_n * bh)
        if max(kp["left_eye_vis"], kp["right_eye_vis"]) >= 0.3:
            eye_box = ai_keypoint.eye_box_in_image(kp, top["bbox_px"], (W, H))
            if eye_box:
                arr = np.asarray(img.convert("L"))
                eye_sharp = _eye_sharpness(arr, eye_box)

    try:
        aes = ai_topiq.aesthetic_score(img)
    except Exception:
        aes = None

    try:
        flying, flying_conf = ai_flying.is_flying(crop)
    except Exception:
        flying, flying_conf = None, None

    exp = detect_exposure(img, bird_bbox_px=top["bbox_px"])

    return {
        "bird_confidence": top["confidence"],
        "bird_bbox": [bx / W, by / H, bw / W, bh / H],
        "eye_xy": (eye_xy_px[0] / W, eye_xy_px[1] / H) if eye_xy_px else None,
        "eye_visibility": eye_visibility,
        "eye_sharpness": eye_sharp,
        "aesthetic_score": aes,
        "is_flying": 1 if flying else 0,
        "flying_confidence": flying_conf,
        "is_over": 1 if exp["is_over"] else 0,
        "is_under": 1 if exp["is_under"] else 0,
        "over_ratio": exp["over_ratio"],
        "under_ratio": exp["under_ratio"],
        "medium_path": medium_path,
    }


def recompute_focus_weights(folder_id: int) -> int:
    """Recompute focus_weight from existing bird_bbox + eye_xy + focus_point
    columns, without running any AI inference. Fast (just math)."""
    n = 0
    with tx() as conn:
        rows = conn.execute(
            """SELECT id, path, width, height, bird_bbox, eye_xy, focus_point
               FROM photos
               WHERE folder_id=? AND deleted_at IS NULL
                 AND focus_point IS NOT NULL AND bird_bbox IS NOT NULL""",
            (folder_id,),
        ).fetchall()
    for r in rows:
        try:
            focus = json.loads(r["focus_point"])
            bbox = json.loads(r["bird_bbox"])
            eye = json.loads(r["eye_xy"]) if r["eye_xy"] else None
            W = r["width"]; H = r["height"]
            if not (W and H): continue
            bbox_px = (int(bbox[0]*W), int(bbox[1]*H), int(bbox[2]*W), int(bbox[3]*H))
            eye_px = (eye[0]*W, eye[1]*H) if eye else None
            fw = _focus_weight(focus, bbox_px, eye_px, (W, H))
            with tx() as conn:
                conn.execute("UPDATE photos SET focus_weight=? WHERE id=?", (fw, r["id"]))
            n += 1
        except Exception:
            continue
    return n


def run_ai_for_folder(folder_id: int, on_progress: Callable[[int, int], None] | None = None) -> dict:
    """Run AI on all shots in a folder. Propagates results to all member photos."""
    with tx() as conn:
        rows = conn.execute(
            """
            SELECT stem, GROUP_CONCAT(id) AS ids, GROUP_CONCAT(path) AS paths,
                   GROUP_CONCAT(ext) AS exts, MAX(focus_point) AS focus_point
            FROM photos
            WHERE folder_id=? AND deleted_at IS NULL
            GROUP BY stem
            ORDER BY MIN(shot_at) IS NULL, MIN(shot_at)
            """,
            (folder_id,),
        ).fetchall()
    shots = [dict(r) for r in rows]

    total = len(shots)
    done = 0
    errors = 0

    for s in shots:
        ids = [int(x) for x in s["ids"].split(",")]
        paths = s["paths"].split(",")
        exts = s["exts"].split(",")
        # primary = ARW if present, else HIF, else any
        order = {".arw": 0, ".nef": 0, ".cr3": 0, ".cr2": 0, ".raf": 0, ".orf": 0, ".rw2": 0,
                 ".hif": 1, ".heif": 1, ".heic": 1, ".jpg": 2, ".jpeg": 2}
        triples = sorted(zip(exts, paths, ids), key=lambda t: order.get(t[0], 9))
        primary_path = Path(triples[0][1])
        try:
            ai_out = run_ai_on_shot(primary_path)
            # Compute focus_weight if we have AF data
            focus = json.loads(s["focus_point"]) if s.get("focus_point") else None
            from PIL import Image
            img_size = None
            if focus and ai_out["bird_bbox"]:
                # we know image size from primary preview - re-derive
                img = load_preview(primary_path)
                W, H = img.size
                bbox_norm = ai_out["bird_bbox"]
                bbox_px = (
                    int(bbox_norm[0] * W), int(bbox_norm[1] * H),
                    int(bbox_norm[2] * W), int(bbox_norm[3] * H),
                )
                eye_xy_px = None
                if ai_out["eye_xy"]:
                    eye_xy_px = (ai_out["eye_xy"][0] * W, ai_out["eye_xy"][1] * H)
                ai_out["focus_weight"] = _focus_weight(focus, bbox_px, eye_xy_px, (W, H))
            else:
                ai_out["focus_weight"] = 1.0
        except Exception as e:
            errors += 1
            done += 1
            if on_progress:
                on_progress(done, total)
            continue

        with tx() as conn:
            for pid in ids:
                conn.execute(
                    """UPDATE photos SET
                        bird_confidence=?, bird_bbox=?, eye_xy=?,
                        eye_visibility=?, eye_sharpness=?, aesthetic_score=?,
                        focus_weight=?, is_flying=?, flying_confidence=?,
                        is_over=?, is_under=?, over_ratio=?, under_ratio=?,
                        medium_path=?
                       WHERE id=?""",
                    (
                        ai_out["bird_confidence"],
                        json.dumps(ai_out["bird_bbox"]) if ai_out["bird_bbox"] else None,
                        json.dumps(ai_out["eye_xy"]) if ai_out["eye_xy"] else None,
                        ai_out["eye_visibility"],
                        ai_out["eye_sharpness"],
                        ai_out["aesthetic_score"],
                        ai_out["focus_weight"],
                        int(ai_out["is_flying"]),
                        ai_out.get("flying_confidence"),
                        int(ai_out.get("is_over", 0)),
                        int(ai_out.get("is_under", 0)),
                        ai_out.get("over_ratio", 0.0),
                        ai_out.get("under_ratio", 0.0),
                        ai_out.get("medium_path"),
                        pid,
                    ),
                )
        done += 1
        if on_progress:
            on_progress(done, total)

    return {"total": total, "done": done, "errors": errors}
