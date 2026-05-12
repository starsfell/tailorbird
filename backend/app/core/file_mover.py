"""Alternative to trash: move files into a subfolder of their parent.

Safer than send2trash because:
- Files stay in the same volume — fast (rename only).
- They're visible right next to the originals; easy to inspect or restore.
- Undo is `mv ../ToReview/X ../X`, no rummaging through OS trash.
"""
from __future__ import annotations

import shutil
import time
import uuid
from pathlib import Path

from app.db.schema import tx


def move_photos(photo_ids: list[int], subfolder_name: str = "ToReview", pair_with_sidecar: bool = True) -> dict:
    batch_id = uuid.uuid4().hex
    now = time.time()

    with tx() as conn:
        rows = conn.execute(
            f"SELECT id, path, stem, ext, folder_id FROM photos "
            f"WHERE id IN ({','.join(['?'] * len(photo_ids))}) AND deleted_at IS NULL",
            photo_ids,
        ).fetchall()
        targets = [dict(r) for r in rows]

        if pair_with_sidecar and targets:
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

    successes: list[dict] = []
    failures: list[dict] = []
    for rec in targets:
        src = Path(rec["path"])
        if not src.exists():
            successes.append(rec); continue
        dest_dir = src.parent / subfolder_name
        dest_dir.mkdir(exist_ok=True)
        dest = dest_dir / src.name
        if dest.exists():
            dest = dest_dir / f"{src.stem}_{int(now)}{src.suffix}"
        try:
            shutil.move(str(src), str(dest))
            rec["new_path"] = str(dest)
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
        "moved": [r["path"] for r in successes],
        "failed": failures,
        "subfolder": subfolder_name,
    }
