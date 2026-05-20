"""Tailorbird packaged-app entry point.

Started by the .app launcher script. Expects these env vars to be set
beforehand so the bundled paths resolve correctly:
  TAILORBIRD_RESOURCES_DIR  → .app/Contents/Resources
  TAILORBIRD_DATA_DIR       → ~/Library/Application Support/tailorbird
  TAILORBIRD_FRONTEND_DIST  → .app/Contents/Resources/frontend_dist
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _ensure_data_dirs() -> None:
    data = os.environ.get("TAILORBIRD_DATA_DIR")
    if data:
        Path(data).expanduser().mkdir(parents=True, exist_ok=True)


def main() -> None:
    _ensure_data_dirs()

    # Backend module path inside the PyInstaller bundle. In a frozen build
    # sys._MEIPASS points at the unpacked Resources tree.
    if getattr(sys, "frozen", False):
        bundle_root = Path(sys._MEIPASS)
        sys.path.insert(0, str(bundle_root))

    import uvicorn
    from app.config import API_PORT

    # Import the ASGI app object directly rather than passing the
    # "app.main:app" import string. In a PyInstaller-frozen build uvicorn's
    # string import can't locate the module and swallows the real traceback;
    # importing here surfaces any error and avoids the lookup entirely.
    try:
        from app.main import app as asgi_app
    except Exception:
        import traceback
        traceback.print_exc()
        raise

    uvicorn.run(
        asgi_app,
        host="127.0.0.1",
        port=API_PORT,
        log_level="info",
        access_log=False,
    )


if __name__ == "__main__":
    main()
