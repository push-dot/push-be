"""Reject a Worker upload that still contains a virtualenv or is too large.

``pywrangler deploy --dry-run --outdir <dir>`` writes the bundle that would
be uploaded. The free-plan script limit is 64 MiB; a repo-root entry point
also pulls in ``.venv`` (tens of megabytes, many files) and the upload fails
with ``multipart: message too large``.
"""

from __future__ import annotations

import sys
from pathlib import Path

_BANNED = {".venv", ".venv-workers", "node_modules"}
_LIMIT = 40 * 1024 * 1024


def main(root: Path) -> None:
    if not root.is_dir():
        raise SystemExit(f"bundle directory missing: {root}")
    bad: list[str] = []
    total = 0
    files = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        files += 1
        total += path.stat().st_size
        if _BANNED.intersection(path.parts):
            bad.append(str(path.relative_to(root)))
    print(f"bundle bytes={total} files={files}")
    if bad:
        print(f"virtualenv paths in bundle: {len(bad)}")
        for line in bad[:20]:
            print(line)
        raise SystemExit(1)
    if total > _LIMIT:
        raise SystemExit(f"bundle {total} bytes exceeds {_LIMIT}")
    mds = [p for p in root.rglob("*.md") if "orchestrator.md" in p.name]
    if not mds:
        raise SystemExit("resume markdown was not included in the bundle")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
