"""Bird eye keypoint detector.

Architecture matches the public weights `cub200_keypoint_resnet50_slim.pth`
released by SuperPicky's author on HuggingFace. The model produces:
  - 3 normalized keypoints: left_eye, right_eye, beak
  - 3 visibility probabilities

Code is written from scratch (no GPL contagion). Same architecture so that the
pretrained checkpoint's state_dict loads cleanly.
"""
from __future__ import annotations

import threading
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torchvision.transforms as T
import torchvision.models as models
from PIL import Image


from app.config import MODELS_DIR
_MODEL_PATH = MODELS_DIR / "cub200_keypoint_resnet50_slim.pth"
_IMG_SIZE = 416
_PARTS = ("left_eye", "right_eye", "beak")

_model = None
_lock = threading.Lock()


class PartLocalizer(nn.Module):
    """ResNet50 backbone + small head. Architecture mirrors SuperPicky's `PartLocalizer`."""
    def __init__(self, num_parts: int = 3, hidden_dim: int = 512, dropout: float = 0.2):
        super().__init__()
        self.num_parts = num_parts
        self.backbone = models.resnet50(weights=None)
        in_features = self.backbone.fc.in_features
        self.backbone.fc = nn.Identity()
        self.head = nn.Sequential(
            nn.Linear(in_features, hidden_dim),
            nn.BatchNorm1d(hidden_dim),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.BatchNorm1d(hidden_dim // 2),
            nn.ReLU(),
            nn.Dropout(dropout),
        )
        self.coord_head = nn.Linear(hidden_dim // 2, num_parts * 2)
        self.vis_head = nn.Linear(hidden_dim // 2, num_parts)

    def forward(self, x):
        f = self.head(self.backbone(x))
        coords = torch.sigmoid(self.coord_head(f)).view(-1, self.num_parts, 2)
        vis = torch.sigmoid(self.vis_head(f))
        return coords, vis


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
        m = PartLocalizer()
        state = torch.load(_MODEL_PATH, map_location="cpu", weights_only=False)
        if isinstance(state, dict) and "state_dict" in state:
            state = state["state_dict"]
        m.load_state_dict(state)
        m.eval()
        m.to(_device())
        _model = m
    return _model


_PREPROCESS = T.Compose([
    T.Resize((_IMG_SIZE, _IMG_SIZE)),
    T.ToTensor(),
    T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])


def detect_keypoints(crop: Image.Image) -> dict:
    """Run keypoint detection on a bird crop (PIL image).

    Returns:
        {
          "left_eye": (x, y),  # normalized 0-1 within the crop
          "right_eye": (x, y),
          "beak": (x, y),
          "left_eye_vis": 0..1,
          "right_eye_vis": 0..1,
          "beak_vis": 0..1,
          "best_eye_visibility": max of the two eyes,
          "all_hidden": True if all three < 0.3,
        }
    """
    m = _load()
    dev = _device()
    x = _PREPROCESS(crop.convert("RGB")).unsqueeze(0).to(dev)
    with torch.no_grad():
        coords, vis = m(x)
    coords = coords.squeeze(0).cpu().numpy()  # [3, 2]
    vis = vis.squeeze(0).cpu().numpy()        # [3]
    le_vis, re_vis, beak_vis = float(vis[0]), float(vis[1]), float(vis[2])
    return {
        "left_eye": (float(coords[0, 0]), float(coords[0, 1])),
        "right_eye": (float(coords[1, 0]), float(coords[1, 1])),
        "beak": (float(coords[2, 0]), float(coords[2, 1])),
        "left_eye_vis": le_vis,
        "right_eye_vis": re_vis,
        "beak_vis": beak_vis,
        "best_eye_visibility": max(le_vis, re_vis),
        "all_hidden": le_vis < 0.3 and re_vis < 0.3 and beak_vis < 0.3,
    }


def eye_box_in_image(kp: dict, bird_bbox_px: tuple[int, int, int, int], img_size: tuple[int, int]) -> tuple[int, int, int, int] | None:
    """Compute a small box (in original image pixel coords) around the most
    visible eye, sized as 1/8 of the bird's bbox width. Returns (x, y, w, h)
    or None if no eye visible.
    """
    bx, by, bw, bh = bird_bbox_px
    le, re = kp["left_eye"], kp["right_eye"]
    le_v, re_v = kp["left_eye_vis"], kp["right_eye_vis"]
    if max(le_v, re_v) < 0.3:
        return None
    eye = le if le_v >= re_v else re
    ex = bx + eye[0] * bw
    ey = by + eye[1] * bh
    side = max(48, bw // 8)
    x0 = max(0, int(ex - side / 2))
    y0 = max(0, int(ey - side / 2))
    w = min(side, img_size[0] - x0)
    h = min(side, img_size[1] - y0)
    return x0, y0, w, h
