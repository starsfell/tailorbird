"""TOPIQ aesthetic scoring using the public pyiqa library + the AVA-trained
CFANet ResNet50 weights downloaded from `chaofengc/IQA-PyTorch-Weights`.

Output is a 0-10 MOS-style score. Higher = more aesthetically pleasing.
"""
from __future__ import annotations

import threading
from pathlib import Path

import torch
from PIL import Image

from app.config import MODELS_DIR

_MODEL_NAME = "topiq_iaa_res50"  # AVA dataset, ResNet50 backbone
_WEIGHT_PATH = MODELS_DIR / "cfanet_iaa_ava_res50-3cd62bb3.pth"

_model = None
_lock = threading.Lock()


def _device() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def _load():
    global _model
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        import pyiqa
        # `as_loss=False` returns the metric in eval mode.
        # pyiqa downloads weights automatically; we let it. The weight we
        # downloaded manually is just to keep things in our project dir.
        m = pyiqa.create_metric(_MODEL_NAME, as_loss=False, pretrained_model_path=str(_WEIGHT_PATH))
        m.eval().to(_device())
        _model = m
    return _model


def aesthetic_score(img: Image.Image) -> float:
    """Return a 0-10 aesthetic score for the given PIL image.
    pyiqa's TOPIQ-IAA outputs in MOS range (1-10 ish)."""
    import torchvision.transforms.functional as TF
    m = _load()
    dev = _device()
    # pyiqa metrics accept PIL via internal preprocessing if given a tensor in
    # [0,1] CHW. Convert directly.
    t = TF.to_tensor(img.convert("RGB")).unsqueeze(0).to(dev)
    with torch.no_grad():
        score = m(t)
    return float(score.detach().cpu().item())
