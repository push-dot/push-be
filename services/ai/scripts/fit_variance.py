"""Call the posting-fit judge N times on one input and print how much each score moves.

Calls the configured model (OpenRouter) N times and spends real credits; no usage gate.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "posting",
        help='JSON: {"requirements": [], "preferred": [], "keywords": [], "description": ""}')
    parser.add_argument("document", help="plain-text resume or cover letter")
    parser.add_argument("--plan", default="PRO", choices=("FREE", "PRO", "ULTRA"))
    parser.add_argument("-n", type=int, default=5, help="number of runs")
    return parser.parse_args()


async def _main(args: argparse.Namespace, posting: dict, document: str) -> None:
    from app.config import load_config
    from app.framework.fit_judge import judge_fit

    config = load_config()
    views = []
    for run in range(args.n):
        view = await judge_fit(
            posting.get("requirements") or [], posting.get("keywords") or [],
            posting.get("description") or "", document, args.plan,
            config=config, preferred=posting.get("preferred") or [])
        views.append(view)
        print(f"run {run + 1}: {view['fitScore']} {json.dumps(view['parts'])}")
    rows = {key: [view["parts"][key] for view in views] for key in views[0]["parts"]}
    rows["fitScore"] = [view["fitScore"] for view in views]
    print(f"{'dimension':<16}{'min':>6}{'max':>6}{'stdev':>8}")
    for key, values in rows.items():
        spread = statistics.pstdev(values)
        print(f"{key:<16}{min(values):>6}{max(values):>6}{spread:>8.2f}")


if __name__ == "__main__":
    parsed = _args()
    asyncio.run(_main(
        parsed,
        json.loads(Path(parsed.posting).read_text(encoding="utf-8")),
        Path(parsed.document).read_text(encoding="utf-8")))
