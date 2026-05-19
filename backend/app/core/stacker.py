"""Image stacking for noise reduction.

ORB feature alignment + sigma-clipped mean (astro standard) over selected shots.
Supports two source modes:
  - 'jpeg': decode ARW embedded full-res JPEG (or HIF/JPEG directly). Fast.
  - 'raw' : full rawpy demosaic at half-size, 16-bit linear. Slower, cleaner.

Outputs an 8-bit JPEG into data/stacks/ for now. 16-bit TIFF is a later step.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

from app.config import DATA_DIR
from app.core.decode import load_preview
from app.db.schema import tx


def _read_raw_color_meta(path: Path) -> dict:
    """Pull color matrix + WB out of a source ARW so the stacked DNG carries
    the original camera profile (lets Lightroom render proper raw colors).
    Returns None if the file isn't a RAW we can read."""
    import rawpy
    try:
        with rawpy.imread(str(path)) as raw:
            return {
                "rgb_xyz_matrix": raw.rgb_xyz_matrix.copy(),  # (4, 3)
                "camera_wb": [float(x) for x in raw.camera_whitebalance],
                "black_level": list(raw.black_level_per_channel),
                "white_level": int(raw.white_level),
            }
    except Exception:
        return None


def _wb_multipliers(camera_wb: list) -> tuple[float, float, float]:
    """[R, G1, B, G2] camera WB → (Rm, 1.0, Bm) to neutralize camera-native RGB.
    libraw's `camera_whitebalance` already encodes the WB amplification ratios
    (e.g. [2865, 1024, 1742, 1024] for A7R5 means R is amplified ~2.8x). We
    normalize so green = 1, since green is the bayer reference channel."""
    r, g1, b, g2 = (camera_wb + [0, 0, 0, 0])[:4]
    g = ((g1 + g2) / 2.0) if g2 > 0 else g1
    if g <= 0:
        return (1.0, 1.0, 1.0)
    return (r / g if r > 0 else 1.0, 1.0, b / g if b > 0 else 1.0)


def _write_linear_dng(rgb16: np.ndarray, out_path: Path, meta: dict) -> None:
    """Write a Linear DNG (PhotometricInterpretation=LinearRaw) from camera-native
    16-bit RGB data. Lightroom will treat it like a raw file — WB / exposure /
    highlight recovery all work."""
    from pidng.core import DNGBASE, DNGTags, Tag
    from pidng.defs import CalibrationIlluminant

    H, W = rgb16.shape[:2]
    # rawpy/libraw's `rgb_xyz_matrix` is XYZ → camera in row-vector form
    # (cam_row = xyz_row @ M). DNG ColorMatrix1 expects the same mapping
    # in column-vector form (cam_col = ColorMatrix1 @ xyz_col), which is
    # just the transpose of the row form.
    xyz_to_cam_row = meta["rgb_xyz_matrix"][:3, :].astype(np.float64)
    color_matrix_1 = xyz_to_cam_row.T

    rm, gm, bm = _wb_multipliers(meta["camera_wb"])
    # AsShotNeutral = camera-native RGB that should be rendered as neutral
    # (inverse of WB multipliers, G=1).
    as_shot = [1.0 / rm, 1.0 / gm, 1.0 / bm]

    def _ratio(v: float) -> list[int]:
        return [int(round(v * 1_000_000)), 1_000_000]

    cm_pairs = [_ratio(v) for v in color_matrix_1.flatten()]
    asn_pairs = [_ratio(v) for v in as_shot]

    tags = DNGTags()
    tags.set(Tag.ImageWidth, W)
    tags.set(Tag.ImageLength, H)
    tags.set(Tag.BitsPerSample, [16, 16, 16])
    tags.set(Tag.SamplesPerPixel, 3)
    tags.set(Tag.PhotometricInterpretation, 34892)  # LinearRaw
    tags.set(Tag.PlanarConfiguration, 1)
    tags.set(Tag.TileWidth, W)
    tags.set(Tag.TileLength, H)
    tags.set(Tag.ColorMatrix1, cm_pairs)
    tags.set(Tag.AsShotNeutral, asn_pairs)
    tags.set(Tag.CalibrationIlluminant1, CalibrationIlluminant.D65)
    tags.set(Tag.Make, "Sony")
    tags.set(Tag.Model, "ILCE-7RM5 (Birdye stack)")
    tags.set(Tag.UniqueCameraModel, "Sony ILCE-7RM5")
    tags.set(Tag.Orientation, 1)

    class _Writer(DNGBASE):
        pass

    w = _Writer()
    w.options(tags=tags, path=str(out_path.parent), compress=False)
    w.convert(rgb16, filename=out_path.stem)


# Legacy location, kept so old results in data/stacks/ still resolve via the
# saved-stacks gallery endpoint. New stacks are written next to their source
# photos (see run_stack: <anchor_folder>/Stacks/).
STACKS_DIR = DATA_DIR / "stacks"
STACKS_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class StackProgress:
    task_id: str = ""
    total: int = 0
    done: int = 0
    phase: str = "idle"  # idle | loading | aligning | merging | saving | done | error
    current: str = ""
    error: str = ""
    result_path: str = ""        # main full-quality output (TIFF for RAW, JPEG for jpeg)
    result_preview: str = ""     # JPEG version, browser-displayable
    result_thumb: str = ""
    started_at: float = 0.0
    finished_at: float = 0.0
    params: dict = field(default_factory=dict)


def _resolve_source_path(photo_id: int) -> tuple[Path, str]:
    """Given any photo_id in a shot, return the best source file path.
    Prefers ARW > HIF > others. Returns (path, stem)."""
    with tx() as conn:
        row = conn.execute(
            "SELECT folder_id, stem, path, ext FROM photos WHERE id=?", (photo_id,)
        ).fetchone()
        if not row:
            raise ValueError(f"photo {photo_id} not found")
        siblings = conn.execute(
            """SELECT path, ext FROM photos
               WHERE folder_id=? AND stem=? AND deleted_at IS NULL""",
            (row["folder_id"], row["stem"]),
        ).fetchall()
    arw = next((s for s in siblings if s["ext"] == ".arw"), None)
    if arw:
        return Path(arw["path"]), row["stem"]
    hif = next((s for s in siblings if s["ext"] in (".hif", ".heif", ".heic")), None)
    if hif:
        return Path(hif["path"]), row["stem"]
    return Path(row["path"]), row["stem"]


def _load_jpeg_source(path: Path, max_side: int | None = None) -> np.ndarray:
    """Load embedded preview / HIF / JPEG as uint8 RGB. Full resolution by default
    — ARW embedded preview is already the camera's full sensor resolution."""
    img = load_preview(path)
    if max_side is not None and max(img.size) > max_side:
        scale = max_side / max(img.size)
        img = img.resize(
            (int(img.size[0] * scale), int(img.size[1] * scale)),
            Image.Resampling.LANCZOS,
        )
    return np.asarray(img, dtype=np.uint8)


def _load_raw_source(path: Path, full_size: bool = False) -> np.ndarray:
    """rawpy demosaic in *camera-native* linear space (no WB, raw colors),
    16-bit, returned as float32 0..1 RGB.

    Camera-native (not sRGB) so the final DNG carries true raw-like editing
    latitude in Lightroom. Preview JPEG renders WB+matrix+gamma separately.

    half_size by default for memory safety (~4x less RAM than full-size).
    A7R5 full_size = 9504x6336 → ~720MB float32 per frame."""
    import rawpy

    ext = path.suffix.lower()
    if ext not in {".arw", ".nef", ".cr2", ".cr3", ".dng", ".raf", ".orf", ".rw2", ".nrw"}:
        # Fall back to JPEG path for HIF/JPEG
        arr = _load_jpeg_source(path)
        return arr.astype(np.float32) / 255.0

    with rawpy.imread(str(path)) as raw:
        arr = raw.postprocess(
            use_camera_wb=False,
            user_wb=[1.0, 1.0, 1.0, 1.0],  # force unity WB; libraw otherwise picks daylight
            no_auto_bright=True,
            output_bps=16,
            half_size=not full_size,
            gamma=(1, 1),
            user_flip=0,
            output_color=rawpy.ColorSpace.raw,
        )
    return arr.astype(np.float32) / 65535.0


def _align_to_anchor(
    anchor_gray: np.ndarray,
    frame: np.ndarray,
    anchor_size: tuple[int, int],  # (w, h)
    detector,
) -> np.ndarray:
    """Align frame (RGB) to anchor using ORB feature matching at 1/4 scale.
    Returns warped frame at anchor's dimensions, same dtype as input frame."""
    import cv2

    # Resize to anchor first (covers half-size RAW vs full-size cases)
    if (frame.shape[1], frame.shape[0]) != anchor_size:
        frame = cv2.resize(frame, anchor_size, interpolation=cv2.INTER_LANCZOS4)

    if frame.dtype == np.uint8:
        frame_for_gray = frame
    else:
        frame_for_gray = np.clip(frame * 255, 0, 255).astype(np.uint8)
    frame_gray = cv2.cvtColor(frame_for_gray, cv2.COLOR_RGB2GRAY)

    scale = 0.25
    a_small = cv2.resize(anchor_gray, (0, 0), fx=scale, fy=scale)
    f_small = cv2.resize(frame_gray, (0, 0), fx=scale, fy=scale)

    kp1, des1 = detector.detectAndCompute(a_small, None)
    kp2, des2 = detector.detectAndCompute(f_small, None)
    if des1 is None or des2 is None or len(kp1) < 10 or len(kp2) < 10:
        return frame

    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = list(bf.match(des1, des2))
    if len(matches) < 8:
        return frame
    matches.sort(key=lambda m: m.distance)
    matches = matches[: min(len(matches), 300)]

    src = np.float32([kp2[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2) / scale
    dst = np.float32([kp1[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2) / scale

    M, _ = cv2.estimateAffinePartial2D(
        src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0
    )
    if M is None:
        return frame
    return cv2.warpAffine(
        frame, M, anchor_size,
        flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE,
    )


def _sigma_clipped_mean(stack: np.ndarray, sigma: float = 2.0, iters: int = 2) -> np.ndarray:
    """stack: (N, H, W, 3). Iteratively reject outliers >sigma*std from mean per pixel."""
    s = stack if stack.dtype == np.float32 else stack.astype(np.float32)
    mean = s.mean(axis=0)
    for _ in range(iters):
        std = s.std(axis=0)
        diff = np.abs(s - mean[None, ...])
        mask = diff <= (sigma * std[None, ...] + 1e-6)
        count = mask.sum(axis=0)
        masked_sum = (s * mask).sum(axis=0)
        mean = np.where(count > 0, masked_sum / np.maximum(count, 1), mean)
    return mean


def run_stack(
    photo_ids: list[int],
    anchor_id: int,
    *,
    source: str = "jpeg",       # 'jpeg' | 'raw'
    mode: str = "sigma_clip",   # 'mean' | 'median' | 'sigma_clip'
    align: bool = True,
    full_size: bool = False,    # RAW only: full-sensor demosaic vs half-size
    progress: StackProgress,
) -> StackProgress:
    """Synchronous stacking entry. Run in a worker thread by the API layer."""
    import cv2

    progress.started_at = time.time()
    progress.params = {"source": source, "mode": mode, "align": align,
                       "full_size": full_size,
                       "n": len(photo_ids), "anchor_id": anchor_id}
    try:
        if anchor_id not in photo_ids:
            raise ValueError("anchor_id must be in photo_ids")
        if len(photo_ids) < 2:
            raise ValueError("at least 2 photos required")

        progress.phase = "loading"
        progress.total = len(photo_ids)
        progress.done = 0

        resolved = [(pid, *_resolve_source_path(pid)) for pid in photo_ids]
        anchor_entry = next(r for r in resolved if r[0] == anchor_id)
        anchor_path = anchor_entry[1]
        anchor_stem = anchor_entry[2]

        if source == "raw":
            loader = lambda p: _load_raw_source(p, full_size=full_size)
        else:
            loader = _load_jpeg_source

        anchor = loader(anchor_path)
        anchor_size = (anchor.shape[1], anchor.shape[0])
        anchor_for_gray = (
            anchor if anchor.dtype == np.uint8
            else np.clip(anchor * 255, 0, 255).astype(np.uint8)
        )
        anchor_gray = cv2.cvtColor(anchor_for_gray, cv2.COLOR_RGB2GRAY)

        detector = cv2.ORB_create(nfeatures=2000) if align else None

        frames: list[np.ndarray] = [anchor]
        progress.done = 1
        progress.current = anchor_path.name
        progress.phase = "aligning" if align else "loading"

        for pid, path, _stem in resolved:
            if pid == anchor_id:
                continue
            progress.current = path.name
            frame = loader(path)
            if align and detector is not None:
                frame = _align_to_anchor(anchor_gray, frame, anchor_size, detector)
            elif (frame.shape[1], frame.shape[0]) != anchor_size:
                frame = cv2.resize(frame, anchor_size, interpolation=cv2.INTER_LANCZOS4)
            frames.append(frame)
            progress.done += 1

        progress.phase = "merging"
        stack = np.stack(frames, axis=0)
        del frames  # let GC reclaim — stack can be ~1-3GB
        if mode == "mean":
            out = stack.mean(axis=0)
        elif mode == "median":
            out = np.median(stack, axis=0)
        else:
            out = _sigma_clipped_mean(stack)
        del stack

        progress.phase = "saving"
        ts = int(time.time())
        n = progress.total
        base = f"stack_{ts}_{anchor_stem}_{n}f_{source}_{mode}"
        # Save next to the source photos, in a Stacks/ subfolder (same pattern
        # as ToReview for the move flow). Falls back to data/stacks/ only if
        # the anchor's parent isn't writable.
        out_dir = anchor_path.parent / "Stacks"
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            out_dir = STACKS_DIR

        preview_path = out_dir / f"{base}_preview.jpg"
        thumb_path = out_dir / f"{base}_thumb.jpg"

        if source == "raw":
            # Pull color metadata from the anchor ARW so the DNG carries the
            # camera profile (Lightroom uses this for raw WB / exposure).
            meta = _read_raw_color_meta(anchor_path)
            if meta is None:
                raise RuntimeError(
                    f"could not read color metadata from {anchor_path.name}; "
                    "DNG output requires a readable RAW anchor"
                )
            out16 = (np.clip(out, 0, 1) * 65535).astype(np.uint16)
            del out

            out_path = out_dir / f"{base}.dng"
            _write_linear_dng(out16, out_path, meta)
            del out16

            # Render preview by decoding the DNG we just wrote — guarantees
            # the in-app preview matches what Lightroom will show. Avoids
            # hand-rolled color math.
            import rawpy
            with rawpy.imread(str(out_path)) as raw:
                out8 = raw.postprocess(
                    use_camera_wb=True, no_auto_bright=True, output_bps=8,
                )
            Image.fromarray(out8).save(preview_path, "JPEG", quality=92)
            thumb = Image.fromarray(out8).copy()
            thumb.thumbnail((640, 640), Image.Resampling.LANCZOS)
            thumb.save(thumb_path, "JPEG", quality=85)
        else:
            # JPEG-source input is already 8-bit/compressed; a DNG wouldn't
            # add anything meaningful. High-quality JPEG keeps file size sane.
            out8 = np.clip(out, 0, 255).astype(np.uint8)
            del out
            Image.fromarray(out8).save(preview_path, "JPEG", quality=92)
            thumb = Image.fromarray(out8).copy()
            thumb.thumbnail((640, 640), Image.Resampling.LANCZOS)
            thumb.save(thumb_path, "JPEG", quality=85)

            out_path = out_dir / f"{base}.jpg"
            Image.fromarray(out8).save(out_path, "JPEG", quality=95)

        progress.result_path = str(out_path)
        progress.result_preview = str(preview_path)
        progress.result_thumb = str(thumb_path)
        progress.phase = "done"
        progress.finished_at = time.time()
    except Exception as e:
        import traceback
        traceback.print_exc()
        progress.phase = "error"
        progress.error = f"{type(e).__name__}: {e}"
        progress.finished_at = time.time()
    return progress


def list_stacks() -> list[dict]:
    """List all saved stack outputs. Reads directory directly — no DB."""
    out: list[dict] = []
    if not STACKS_DIR.exists():
        return out
    for p in sorted(STACKS_DIR.glob("stack_*.jpg"), reverse=True):
        if p.name.endswith("_thumb.jpg"):
            continue
        thumb = p.with_name(p.stem + "_thumb.jpg")
        st = p.stat()
        out.append({
            "name": p.name,
            "path": str(p),
            "thumb": str(thumb) if thumb.exists() else "",
            "size": st.st_size,
            "mtime": st.st_mtime,
        })
    return out
