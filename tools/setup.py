#!/usr/bin/env python3
"""Set up the Agent Sprite Forge skills for DeepSeek Harness, in one step.

    python tools/setup.py --forge-root <agent-sprite-forge checkout> --workspace <project>

It does three things and checks each one:

  1. patches the checkout's route layer so `route_media.py` can report and run a
     host route (`host:dsh`) through `tools/patch_route_media.py`;
  2. installs the workspace hook `<project>/http/route_media.py` (+ its client)
     through `tools/install_host_route.py`;
  3. runs `forge_doctor.py` from the checkout to show what the machine can do.

Both patch tools are idempotent and keep their own backups. `--dry-run` prints
the plan without writing anything.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent


def run(command: list[str], cwd: Path | None = None) -> int:
    print("$ " + " ".join(str(part) for part in command))
    result = subprocess.run(command, cwd=cwd)
    return result.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--forge-root", type=Path, required=True, help="the agent-sprite-forge checkout (holds skills/)")
    parser.add_argument("--workspace", type=Path, required=True, help="the project that uses the skills")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-doctor", action="store_true", help="do not run forge_doctor.py at the end")
    args = parser.parse_args()

    forge = args.forge_root.resolve()
    workspace = args.workspace.resolve()
    if not (forge / "skills" / "generate2dmedia" / "SKILL.md").is_file():
        print(f"error: {forge} does not look like an agent-sprite-forge checkout", file=sys.stderr)
        return 1
    if not workspace.is_dir():
        print(f"error: {workspace} is not a directory", file=sys.stderr)
        return 1

    steps = [
        [sys.executable, str(HERE / "patch_route_media.py"), "--forge-root", str(forge)],
        [sys.executable, str(HERE / "install_host_route.py"), "--workspace", str(workspace)],
    ]
    if args.dry_run:
        steps = [step + ["--dry-run"] for step in steps]
    for step in steps:
        code = run(step)
        if code != 0:
            print(f"error: step failed ({code}): {step[1]}", file=sys.stderr)
            return code

    if not args.skip_doctor:
        doctor = forge / "skills" / "generate2dmedia" / "scripts" / "forge_doctor.py"
        if doctor.is_file():
            # The bridge only exists while DSH runs the plugin; ask the doctor for
            # the static view (keys, CLIs, deps) rather than a live route probe.
            run([sys.executable, str(doctor), "--project-dir", str(workspace), "--host-tools", "image_gen", "--no-exec"], cwd=workspace)
    print(json.dumps({
        "status": "ok",
        "forgeRoot": str(forge),
        "workspace": str(workspace),
        "next": "restart DSH (or reload the plugin), then start a session in the workspace",
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
