"""YOLO11 bird detection wrapper. Single-process singleton."""
from __future__ import annotations

import os
import threading
from pathlib import Path

import numpy as np
from PIL import Image

os.environ.setdefault("YOLO_VERBOSE", "False")

from app.config import MODELS_DIR

_BIRD_CLASS_ID = 14  # COCO 'bird'
_MODEL_PATH = MODELS_DIR / "yolo11l-seg.pt"

_model = None
_lock = threading.Lock()


def _device():
    import torch
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _load():
    global _model
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        from ultralytics import YOLO
        m = YOLO(str(_MODEL_PATH))
        # warm up
        try: m.to(_device())
        except Exception: pass
        _model = m
    return _model


def detect_birds(img: Image.Image, conf: float = 0.35, imgsz: int = 1280) -> list[dict]:
    """Return list of detected birds as dicts:
        { confidence, bbox: [x,y,w,h] normalized 0-1, area_norm }
    Largest-first sorted. `imgsz` is the YOLO inference size (longer side).
    """
    model = _load()
    arr = np.asarray(img.convert("RGB"))
    H, W = arr.shape[:2]
    results = model.predict(arr, conf=conf, classes=[_BIRD_CLASS_ID], imgsz=imgsz, verbose=False)
    if not results:
        return []
    boxes = results[0].boxes
    if boxes is None or len(boxes) == 0:
        return []
    out = []
    xyxy = boxes.xyxy.cpu().numpy()
    confs = boxes.conf.cpu().numpy()
    for (x1, y1, x2, y2), c in zip(xyxy, confs):
        bw = x2 - x1; bh = y2 - y1
        out.append({
            "confidence": float(c),
            "bbox": [float(x1 / W), float(y1 / H), float(bw / W), float(bh / H)],
            "area_norm": float(bw * bh / (W * H)),
            "bbox_px": [int(x1), int(y1), int(bw), int(bh)],
        })
    out.sort(key=lambda d: -d["area_norm"])
    return out
