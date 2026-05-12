"""Flying bird classifier — EfficientNet-B3 binary head.

Architecture matches the public `superFlier_efficientnet.pth` checkpoint.
Code is original; only the architecture (dropout-then-linear-sigmoid head on
EfficientNet-B3) is recreated so the checkpoint loads.
"""
from __future__ import annotations

import threading

import torch
import torch.nn as nn
import torchvision.transforms as T
from torchvision import models
from PIL import Image

from app.config import MODELS_DIR

_MODEL_PATH = MODELS_DIR / "superFlier_efficientnet.pth"
_IMG_SIZE = 384
_THRESHOLD = 0.5

_model = None
_lock = threading.Lock()


def _device() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def _build():
    m = models.efficientnet_b3(weights=None)
    in_f = m.classifier[1].in_features
    m.classifier = nn.Sequential(
        nn.Dropout(0.2),
        nn.Linear(in_f, 1),
        nn.Sigmoid(),
    )
    return m


def _load():
    global _model
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        if not _MODEL_PATH.exists():
            return None
        m = _build()
        state = torch.load(_MODEL_PATH, map_location="cpu", weights_only=False)
        if isinstance(state, dict) and "state_dict" in state:
            state = state["state_dict"]
        try:
            m.load_state_dict(state, strict=False)
        except Exception:
            return None
        m.eval().to(_device())
        _model = m
    return _model


_PRE = T.Compose([
    T.Resize((_IMG_SIZE, _IMG_SIZE)),
    T.ToTensor(),
    T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])


def is_flying(bird_crop: Image.Image) -> tuple[bool, float] | tuple[None, None]:
    """Returns (is_flying, confidence). Returns (None, None) if model unavailable."""
    m = _load()
    if m is None:
        return (None, None)
    x = _PRE(bird_crop.convert("RGB")).unsqueeze(0).to(_device())
    with torch.no_grad():
        p = float(m(x).squeeze().cpu().item())
    return (p >= _THRESHOLD, p)
