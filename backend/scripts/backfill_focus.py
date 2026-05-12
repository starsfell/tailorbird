"""One-shot backfill: re-read EXIF AF point for all rows whose focus_point is NULL.
Run with PYTHONPATH=. python scripts/backfill_focus.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.exif import parse_focus_point, read_exif
from app.db.schema import tx


def main():
    with tx() as conn:
        rows = conn.execute(
            "SELECT id, path FROM photos WHERE deleted_at IS NULL AND focus_point IS NULL"
        ).fetchall()
    print(f"backfilling focus_point for {len(rows)} rows")
    updated = 0
    for r in rows:
        p = Path(r["path"])
        if not p.exists():
            continue
        exif = read_exif(p)
        fp = parse_focus_point(exif)
        if fp:
            with tx() as conn:
                conn.execute("UPDATE photos SET focus_point=? WHERE id=?", (json.dumps(fp), r["id"]))
            updated += 1
        if (rows.index(r) + 1) % 50 == 0:
            print(f"  ... {rows.index(r) + 1}/{len(rows)}, updated {updated}")
    print(f"DONE: {updated}/{len(rows)} got focus_point")


if __name__ == "__main__":
    main()
