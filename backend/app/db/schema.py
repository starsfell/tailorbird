from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from app.config import DB_PATH


SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    last_scanned_at REAL
);

CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id INTEGER NOT NULL,
    path TEXT NOT NULL UNIQUE,
    stem TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER,
    mtime REAL,
    shot_at REAL,
    width INTEGER,
    height INTEGER,
    thumb_path TEXT,
    subject_sharpness REAL,
    eye_sharpness REAL,
    aesthetic_score REAL,
    bird_confidence REAL,
    bird_bbox TEXT,            -- json [x,y,w,h] normalized 0-1
    eye_xy TEXT,               -- json [x,y] normalized 0-1
    eye_visibility REAL,
    focus_point TEXT,          -- json from parse_focus_point
    focus_weight REAL,         -- 1.1 head / 1.0 seg / 0.7 bbox / 0.5 outside
    is_flying INTEGER DEFAULT 0,
    rating INTEGER,            -- 0..3 stars; -1 = no bird
    pick INTEGER DEFAULT 0,    -- 0 = none, 1 = pick (top 25%)
    phash TEXT,
    cluster_id INTEGER,
    is_cluster_best INTEGER DEFAULT 0,
    user_mark TEXT,
    deleted_at REAL,
    error TEXT,
    analyzed_at REAL,
    -- One "shot" = all files sharing a path minus extension (ARW+HIF pair).
    -- Not stem alone: sub-folders (102MSDCF/104MSDCF…) reuse names after rollover.
    shot_key TEXT GENERATED ALWAYS AS (substr(path, 1, length(path) - length(ext))) VIRTUAL,
    FOREIGN KEY (folder_id) REFERENCES folders(id)
);

CREATE INDEX IF NOT EXISTS idx_photos_folder ON photos(folder_id);
CREATE INDEX IF NOT EXISTS idx_photos_stem ON photos(stem);
CREATE INDEX IF NOT EXISTS idx_photos_shot_at ON photos(shot_at);
CREATE INDEX IF NOT EXISTS idx_photos_cluster ON photos(cluster_id);
CREATE INDEX IF NOT EXISTS idx_photos_deleted ON photos(deleted_at);

CREATE TABLE IF NOT EXISTS deletion_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL,
    photo_id INTEGER NOT NULL,
    original_path TEXT NOT NULL,
    new_path TEXT,             -- where the file actually landed; NULL = trashed (not restorable here)
    action TEXT,                -- short label e.g. 'move:ToReview', 'trash'
    deleted_at REAL NOT NULL,
    restored INTEGER DEFAULT 0,
    FOREIGN KEY (photo_id) REFERENCES photos(id)
);

CREATE INDEX IF NOT EXISTS idx_deletion_batch ON deletion_history(batch_id);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT,
    is_favorite INTEGER DEFAULT 0,
    parent_id INTEGER,
    created_at REAL,
    FOREIGN KEY (parent_id) REFERENCES tags(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS photo_tags (
    photo_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (photo_id, tag_id),
    FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_photo_tags_tag ON photo_tags(tag_id);
"""


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript(SCHEMA)
        # Migrations: add columns if missing
        cols = {r[1] for r in conn.execute("PRAGMA table_info(photos)").fetchall()}
        migrations = [
            ("sharpness_pct", "REAL"),
            ("eye_sharpness", "REAL"),
            ("aesthetic_score", "REAL"),
            ("bird_confidence", "REAL"),
            ("bird_bbox", "TEXT"),
            ("eye_xy", "TEXT"),
            ("eye_visibility", "REAL"),
            ("focus_point", "TEXT"),
            ("focus_weight", "REAL"),
            ("is_flying", "INTEGER DEFAULT 0"),
            ("flying_confidence", "REAL"),
            ("is_over", "INTEGER DEFAULT 0"),
            ("is_under", "INTEGER DEFAULT 0"),
            ("over_ratio", "REAL"),
            ("under_ratio", "REAL"),
            ("medium_path", "TEXT"),
            ("rating", "INTEGER"),
            ("pick", "INTEGER DEFAULT 0"),
            ("xmp_tags", "TEXT"),
            ("iso", "INTEGER"),
            ("f_number", "REAL"),
            ("exposure_time", "REAL"),       # in seconds, e.g. 0.004 = 1/250s
            ("focal_length", "REAL"),         # in mm
            ("lens_model", "TEXT"),
            ("camera_model", "TEXT"),
            ("orientation", "INTEGER"),    # EXIF Orientation still to apply to the decoded preview
        ]
        for col, typ in migrations:
            if col not in cols:
                conn.execute(f"ALTER TABLE photos ADD COLUMN {col} {typ}")
        # table_xinfo (not table_info) lists generated columns
        xcols = {r[1] for r in conn.execute("PRAGMA table_xinfo(photos)").fetchall()}
        if "shot_key" not in xcols:
            conn.execute(
                "ALTER TABLE photos ADD COLUMN shot_key TEXT "
                "GENERATED ALWAYS AS (substr(path, 1, length(path) - length(ext))) VIRTUAL"
            )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_shot_key ON photos(shot_key)")
        # Migrate deletion_history for undo support
        dh_cols = {r[1] for r in conn.execute("PRAGMA table_info(deletion_history)").fetchall()}
        if "new_path" not in dh_cols:
            conn.execute("ALTER TABLE deletion_history ADD COLUMN new_path TEXT")
        if "action" not in dh_cols:
            conn.execute("ALTER TABLE deletion_history ADD COLUMN action TEXT")
        # Migrate tags table for hierarchy (Phase 3)
        tag_cols = {r[1] for r in conn.execute("PRAGMA table_info(tags)").fetchall()}
        if "parent_id" not in tag_cols:
            conn.execute("ALTER TABLE tags ADD COLUMN parent_id INTEGER REFERENCES tags(id) ON DELETE SET NULL")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id)")
        # Migrate folders table: mark-as-done state (home screen "已完成" badge)
        folder_cols = {r[1] for r in conn.execute("PRAGMA table_info(folders)").fetchall()}
        if "completed_at" not in folder_cols:
            conn.execute("ALTER TABLE folders ADD COLUMN completed_at REAL")
        conn.commit()


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def tx():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
