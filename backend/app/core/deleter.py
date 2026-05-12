from __future__ import annotations

import time
import uuid
from pathlib import Path

from send2trash import send2trash

from app.db.schema import tx


def delete_photos(photo_ids: list[int], pair_with_sidecar: bool = True) -> dict:
    """Send the given photo files to system trash.

    If `pair_with_sidecar` is True, also include the matching ARW or HIF file
    that shares the same stem and folder.
    Returns a dict with batch_id, successes, failures.
    """
    batch_id = uuid.uuid4().hex
    now = time.time()

    with tx() as conn:
        rows = conn.execute(
            f"SELECT id, path, stem, ext, folder_id FROM photos WHERE id IN ({','.join(['?'] * len(photo_ids))}) AND deleted_at IS NULL",
            photo_ids,
        ).fetchall()
        target_records = [dict(r) for r in rows]

        if pair_with_sidecar and target_records:
            keys = {(r["folder_id"], r["stem"]) for r in target_records}
            existing_paths = {r["path"] for r in target_records}
            placeholders = " OR ".join(["(folder_id=? AND stem=?)"] * len(keys))
            params: list = []
            for fid, stem in keys:
                params.extend([fid, stem])
            sidecars = conn.execute(
                f"SELECT id, path, stem, ext, folder_id FROM photos WHERE ({placeholders}) AND deleted_at IS NULL",
                params,
            ).fetchall()
            for s in sidecars:
                if s["path"] not in existing_paths:
                    target_records.append(dict(s))
                    existing_paths.add(s["path"])

    successes: list[dict] = []
    failures: list[dict] = []
    for rec in target_records:
        p = Path(rec["path"])
        try:
            if p.exists():
                send2trash(str(p))
            successes.append(rec)
        except Exception as e:
            failures.append({**rec, "error": f"{type(e).__name__}: {e}"})

    with tx() as conn:
        for rec in successes:
            conn.execute(
                "INSERT INTO deletion_history(batch_id, photo_id, original_path, deleted_at) VALUES(?, ?, ?, ?)",
                (batch_id, rec["id"], rec["path"], now),
            )
            conn.execute("UPDATE photos SET deleted_at=? WHERE id=?", (now, rec["id"]))

    return {
        "batch_id": batch_id,
        "deleted": [r["path"] for r in successes],
        "failed": failures,
    }


def list_recent_batches(limit: int = 10) -> list[dict]:
    with tx() as conn:
        rows = conn.execute(
            """
            SELECT batch_id, MIN(deleted_at) AS at, COUNT(*) AS n,
                   SUM(restored) AS restored
            FROM deletion_history
            GROUP BY batch_id
            ORDER BY at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]
