# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for tailorbird's Python backend.

Produces a single onedir bundle at dist/tailorbird-backend/ containing
the launcher binary + every Python dep + native libs. The .app launcher
script later invokes dist/tailorbird-backend/tailorbird-backend.
"""

from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = Path(SPECPATH).parent  # SPECPATH is provided by PyInstaller
BACKEND = ROOT / "backend"

datas, binaries, hiddenimports = [], [], []

# Heavy ML deps with dynamic imports / data files. collect_all picks up
# .py modules, package data (json/yaml/etc.), and native libs together.
HEAVY = [
    "torch",
    "torchvision",
    "ultralytics",
    "timm",
    "transformers",
    "pyiqa",
    "rawpy",
    "skimage",
    "cv2",
    "PIL",
    "imagehash",
    "facexlib",
    "huggingface_hub",
    "safetensors",
    "tokenizers",
]
for pkg in HEAVY:
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as e:  # noqa: BLE001
        print(f"[spec] WARNING: collect_all({pkg!r}) failed: {e}")

# Tailorbird's own `app` package (lives under backend/).
hiddenimports += collect_submodules("app")

# uvicorn / starlette pieces that the dependency analyzer routinely misses.
hiddenimports += [
    "uvicorn.workers",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.loops.uvloop",
    "h11",
    "httptools",
    "anyio._backends._asyncio",
    "sqlite3",
]


a = Analysis(
    [str(ROOT / "packaging" / "launcher.py")],
    pathex=[str(BACKEND)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # opencv ships two wheels in this env; keep the headless one (matches
        # what pyiqa / scikit-image typically pull in) and drop the GUI one.
        "opencv-python",
        # Tk/Qt aren't needed for a headless backend.
        "tkinter",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        # we don't ship Jupyter
        "IPython",
        "ipykernel",
        "notebook",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="tailorbird-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,   # logs go to a file via launcher; keep stdout/stderr usable.
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch="arm64",
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="tailorbird-backend",
)
