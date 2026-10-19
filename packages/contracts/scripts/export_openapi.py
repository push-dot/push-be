"""Regenerate ``packages/contracts/openapi.json`` from the FastAPI app.

Run from the repo root:

    python packages/contracts/scripts/export_openapi.py

Then refresh the TypeScript types:

    npm run contracts
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "ai" / "src"))

from app.main import app  # noqa: E402


def main() -> None:
    spec = app.openapi()
    out = Path(__file__).resolve().parents[1] / "openapi.json"
    out.write_text(json.dumps(spec, indent=2, sort_keys=True) + "\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
