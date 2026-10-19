#!/usr/bin/env python3
"""Install the DSH `host` route into a workspace's `http/` hook.

What it writes, under the workspace you name:

    <workspace>/http/route_media.py     the shim (copied verbatim)
    <workspace>/http/asf_host_route.py  the bridge client (copied verbatim)

Existing files are never replaced without `--force`; a backup is written first.
The files are plain Python with no dependencies, and live in the workspace (not
next to the skill), so the upstream checkout stays untouched.

  python tools/install_host_route.py --workspace E:/games/my-game
  python tools/install_host_route.py --workspace E:/games/my-game --dry-run
"""

from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
import shutil
import sys

HERE = Path(__file__).resolve().parents[1]
SOURCE = HERE / "lib" / "http"
FILES = ("route_media.py", "asf_host_route.py")


def install(workspace: Path, force: bool, dry_run: bool) -> int:
    target = workspace / "http"
    plan = []
    for name in FILES:
        source = SOURCE / ("route_media_shim.py" if name == "route_media.py" else name)
        dest = target / name
        state = "exists" if dest.exists() else "new"
        if state == "exists" and not force and dest.read_bytes() != source.read_bytes():
            print(f"error: {dest} exists with different content; pass --force to replace it", file=sys.stderr)
            return 1
        plan.append((source, dest, state))
    for source, dest, state in plan:
        print(("[dry-run] " if dry_run else "") + f"{state}: {dest}")
    if dry_run:
        return 0
    target.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    for source, dest, state in plan:
        if state == "exists" and dest.read_bytes() != source.read_bytes():
            shutil.copy2(dest, dest.with_name(f"{dest.name}.bak-{stamp}"))
        shutil.copy2(source, dest)
        print(f"wrote {dest}")
    print("done: the Forge route layer now reports 'host:dsh' when the DSH bridge is available")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True, help="project root that runs the Forge skills")
    parser.add_argument("--force", action="store_true", help="replace an existing http/route_media.py (backed up)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not args.workspace.is_dir():
        print(f"error: {args.workspace} is not a directory", file=sys.stderr)
        return 1
    return install(args.workspace.resolve(), args.force, args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
