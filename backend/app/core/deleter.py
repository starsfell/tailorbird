from __future__ import annotations

import os
import shutil
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
                "INSERT INTO deletion_history(batch_id, photo_id, original_path, new_path, action, deleted_at) "
                "VALUES(?, ?, ?, ?, ?, ?)",
                (batch_id, rec["id"], rec["path"], None, "trash", now),
            )
            conn.execute("UPDATE photos SET deleted_at=? WHERE id=?", (now, rec["id"]))

    return {
        "batch_id": batch_id,
        "deleted": [r["path"] for r in successes],
        "failed": failures,
    }


def list_recent_batches(limit: int = 5) -> list[dict]:
    """Most recent move/delete batches, newest first, for the undo history panel."""
    with tx() as conn:
        rows = conn.execute(
            """
            SELECT batch_id, MIN(deleted_at) AS at, MAX(action) AS action,
                   COUNT(*) AS n, SUM(restored) AS restored_n,
                   SUM(CASE WHEN new_path IS NOT NULL THEN 1 ELSE 0 END) AS restorable_n
            FROM deletion_history
            GROUP BY batch_id
            ORDER BY at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def latest_undoable_batch() -> str | None:
    """batch_id of the most recent batch that still has un-restored, restorable
    rows (i.e. moved somewhere we can move back from). Pure-trash batches are
    skipped here so repeated undo walks back to the next move batch instead of
    failing on the same un-restorable trash batch forever; they're still
    listed (and explained) in list_recent_batches for the history panel."""
    with tx() as conn:
        row = conn.execute(
            "SELECT batch_id FROM deletion_history WHERE restored=0 AND new_path IS NOT NULL "
            "ORDER BY deleted_at DESC LIMIT 1"
        ).fetchone()
    return row["batch_id"] if row else None


def restore_batch(batch_id: str) -> dict:
    """Move files from a move-mode batch back to their original path and clear
    deleted_at. Rows with no new_path came from trash mode — not restorable
    here (file went to the OS trash, not somewhere we can rename back from)."""
    with tx() as conn:
        rows = conn.execute(
            "SELECT id, photo_id, original_path, new_path FROM deletion_history "
            "WHERE batch_id=? AND restored=0",
            (batch_id,),
        ).fetchall()
        targets = [dict(r) for r in rows]

    if not targets:
        return {"batch_id": batch_id, "restored": [], "failed": [], "not_found": True}

    restored: list[dict] = []
    failed: list[dict] = []
    for rec in targets:
        if not rec["new_path"]:
            failed.append({**rec, "error": "送入废纸篓的文件无法在此撤销,请从系统废纸篓手动还原"})
            continue
        src = Path(rec["new_path"])
        dest = Path(rec["original_path"])
        if not src.exists():
            failed.append({**rec, "error": "文件已不在原移动位置(可能被再次移动)"})
            continue
        if dest.exists():
            failed.append({**rec, "error": "原路径已被同名文件占用,撤销已跳过"})
            continue
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            _clear_write_protection(src)
            shutil.move(str(src), str(dest))
            restored.append(rec)
        except Exception as e:
            failed.append({**rec, "error": f"{type(e).__name__}: {e}"})

    with tx() as conn:
        for rec in restored:
            conn.execute("UPDATE deletion_history SET restored=1 WHERE id=?", (rec["id"],))
            conn.execute("UPDATE photos SET deleted_at=NULL WHERE id=?", (rec["photo_id"],))

    return {
        "batch_id": batch_id,
        "restored": [r["photo_id"] for r in restored],
        "failed": failed,
    }
