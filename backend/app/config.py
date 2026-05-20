from __future__ import annotations

import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent.parent

# Resources (read-only): model weights, frontend build. In the packaged .app
# these live inside Contents/Resources; in dev they live next to the repo's
# data/ folder. Override with TAILORBIRD_RESOURCES_DIR.
_RES_ENV = os.environ.get("TAILORBIRD_RESOURCES_DIR")
RESOURCES_DIR = Path(_RES_ENV).expanduser() if _RES_ENV else ROOT_DIR / "data"

# User data (writable): sqlite db, thumbnails, decoded medium-size cache,
# stacked output. In the packaged .app we redirect to
# ~/Library/Application Support/tailorbird/. Override with TAILORBIRD_DATA_DIR.
_DATA_ENV = os.environ.get("TAILORBIRD_DATA_DIR")
DATA_DIR = Path(_DATA_ENV).expanduser() if _DATA_ENV else ROOT_DIR / "data"

THUMBS_DIR = DATA_DIR / "thumbs"
MEDIUM_DIR = DATA_DIR / "medium"
MODELS_DIR = RESOURCES_DIR / "models"
DB_PATH = DATA_DIR / "tailorbird.db"

# Frontend build directory; the packaged launcher points this at
# Contents/Resources/frontend_dist.
_FRONTEND_ENV = os.environ.get("TAILORBIRD_FRONTEND_DIST")
FRONTEND_DIST = (
    Path(_FRONTEND_ENV).expanduser() if _FRONTEND_ENV
    else ROOT_DIR / "frontend" / "dist"
)

THUMB_SIZE = 320
RAW_EXTS = {".arw", ".nef", ".nrw", ".cr2", ".cr3", ".raf", ".orf", ".rw2", ".dng"}
HEIF_EXTS = {".hif", ".heif", ".heic"}
JPEG_EXTS = {".jpg", ".jpeg"}
SUPPORTED_EXTS = RAW_EXTS | HEIF_EXTS | JPEG_EXTS

BURST_GAP_SECONDS = 2.0
PHASH_HAMMING_THRESHOLD = 8

# Skill level presets: sharpness (raw, eye/head area) + aesthetics thresholds
# Thresholds are calibrated against tailorbird's own sharpness_score scale
# (Laplacian+Tenengrad sqrt-scaled, typical real-photo range 0-80).
SKILL_PRESETS = {
    "beginner":     {"sharpness_th": 22.0, "aesthetics_th": 4.5, "min_sharpness":  8.0, "min_aesthetics": 3.5},
    "intermediate": {"sharpness_th": 30.0, "aesthetics_th": 4.8, "min_sharpness": 12.0, "min_aesthetics": 4.0},
    "master":       {"sharpness_th": 42.0, "aesthetics_th": 5.5, "min_sharpness": 18.0, "min_aesthetics": 4.5},
}
DEFAULT_SKILL = "intermediate"

API_PORT = int(os.environ.get("TAILORBIRD_PORT", "7891"))

DATA_DIR.mkdir(parents=True, exist_ok=True)
THUMBS_DIR.mkdir(parents=True, exist_ok=True)
MEDIUM_DIR.mkdir(parents=True, exist_ok=True)
# MODELS_DIR is under RESOURCES_DIR and may be read-only (inside .app bundle);
# only create it if we own it (dev mode where it coincides with DATA_DIR).
if RESOURCES_DIR == DATA_DIR:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
