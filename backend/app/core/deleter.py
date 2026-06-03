from __future__ import annotations

import os
import stat
import time
import uuid
from pathlib import Path

from send2trash import send2trash

from app.db.schema import tx


def _clear_write_protection(p: Path) -> None:
    """Remove macOS lock flag (uchg) and add the owner write bit so the file
    can be trashed. Best-effort: ignore anything we can't change."""
    try:
        # Clear user/file flags such as UF_IMMUTABLE ("Locked" in Finder).
        if hasattr(os, "chflags"):
            os.chflags(str(p), 0)
    except OSError:
        pass
    try:
        st = p.stat()
        os.chmod(str(p), st.st_mode | stat.S_IWUSR)
    except OSError:
        pass


def _trash(p: Path) -> None:
    """Send a file to trash, retrying once after clearing write protection."""
    try:
        send2trash(str(p))
    except Exception:
        _clear_write_protection(p)
        send2trash(str(p))


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
                _trash(p)
            successes.append(rec)
        except Exception as e:
            print(f"[delete] FAILED {rec['path']}: {type(e).__name__}: {e}", flush=True)
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
