from __future__ import annotations

import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT_DIR / "data"
THUMBS_DIR = DATA_DIR / "thumbs"
MEDIUM_DIR = DATA_DIR / "medium"
MODELS_DIR = DATA_DIR / "models"
DB_PATH = DATA_DIR / "tailorbird.db"

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
MODELS_DIR.mkdir(parents=True, exist_ok=True)
