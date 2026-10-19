#!/usr/bin/env python3
"""Enable the `host` route inside this checkout's own route_media.py.

The route layer only knows `api:*` and `local:*`. A host — DeepSeek Harness in
particular — can supply an image tool instead, through the documented workspace
hook `<project>/http/route_media.py` (installed by `tools/install_host_route.py`).
This script adds the branches that make route_media.py consult that hook, in the
checkout itself, because that is where the route list is built.

It is deliberately conservative:

  * only 2 files change (route_media.py and forge_doctor.py);
  * backups are written to `<forge-root>/.asf-host-route-backups/` (outside
    skills/, so install_skills.py never ships them);
  * the edit is idempotent: a second run reports "already patched";
  * the patched text must compile, or nothing is written;
  * `--revert` restores the newest backup;
  * if any anchor line is missing (upstream changed), nothing is written.

  python tools/patch_route_media.py --forge-root . --dry-run
  python tools/patch_route_media.py --forge-root .
  python tools/patch_route_media.py --forge-root . --revert
"""

from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
import shutil
import sys

MARKER = "# ASF host route (dsh-plugin-asf-suite)"

HELPERS = f'''
{MARKER} -----------------------------------------------------------------
def _host_route_media():
    """The workspace's http/route_media.py (the DSH bridge shim), or None."""
    import importlib.util
    import os
    if not (os.environ.get("ASF_DSH_BRIDGE") and os.environ.get("ASF_DSH_TOKEN")):
        return None  # no host bridge in this process: nothing to route to
    project = os.environ.get("ASF_DSH_WORKSPACE") or os.environ.get("FORGE_PROJECT_DIR") or os.getcwd()
    candidates = [Path(project) / "http" / "route_media.py", Path.cwd() / "http" / "route_media.py"]
    seen = set()
    for path in candidates:
        if str(path) in seen or not path.is_file():
            continue
        seen.add(str(path))
        try:
            spec = importlib.util.spec_from_file_location(f"asf_workspace_route_media_{{len(seen)}}", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        except Exception:  # noqa: BLE001  a broken shim must never break route_media
            continue
        ready = getattr(module, "bridge_ready", None)
        if callable(ready) and ready():
            return module
    return None


def _host_candidate(module):
    return Candidate(module.ROUTE_NAME)
{MARKER} ------------------------------------------------------------- end
'''


def patch(text: str) -> tuple[str, str | None]:
    # Idempotence is checked on the route_media edits themselves, never on the
    # shared marker: forge_doctor's label patch also carries a marker comment.
    if "def _host_route_media()" in text:
        return text, "already patched"
    anchors = [
        "def _known_model(kind: str, args: argparse.Namespace) -> None:",
        "def resolve(kind: str, route: str = \"auto\", *, references: int | None = None, resolution: str = \"720p\",",
        "    order = requested_routes(kind, route, preferred)",
        "        family, target = name.split(\":\", 1)",
        "    if args.route not in ROUTE_CHOICES[kind] and not (FAL_ROUTE.fullmatch(args.route) and \"api:fal\" in ORDER[kind]):",
        "def generate(args: argparse.Namespace, resolution: Resolution, transport=None) -> dict:",
        "            outcome = run_api(candidate, args, transport) if candidate.family == \"api\" else run_local(candidate, args)",
    ]
    missing = [line for line in anchors if line not in text]
    if missing:
        return text, f"anchor lines missing (upstream changed?): {missing[0][:70]}"
    # 1. the helper module, right before resolve()
    text = text.replace(anchors[1], HELPERS + "\n\n" + anchors[1], 1)
    # 2. the host route leads when a bridge exists (right AFTER the order is built)
    text = text.replace(
        anchors[2],
        anchors[2] + "\n"
        "    _host = _host_route_media() if kind == \"image\" else None\n"
        "    if _host is not None and route in (\"auto\", \"local\", \"host\", \"dsh\"):\n"
        "        order = [_host.ROUTE_NAME, *[name for name in order if name != _host.ROUTE_NAME]]",
        1,
    )
    # 3. a candidate for it, before the family branch reads its first field.
    #    label() is resolved later (after resolve() returns), so the label text
    #    is computed now and carried on the candidate; it must be a plain str.
    text = text.replace(
        anchors[3],
        anchors[3] + "\n"
        "        if family == \"host\":\n"
        "            if _host is not None and not wanted.model:\n"
        "                _h = Candidate(_host.ROUTE_NAME)\n"
        "                _h.notes.append(str(_host.describe().get(\"label\", \"host media tool\")))\n"
        "                candidates.append(_h)\n"
        "            continue",
        1,
    )
    # 3b. Candidate.label: a host candidate carries its label note; use it
    #     instead of indexing ROUTE_LABEL (forge_doctor has no line for 'dsh').
    text = text.replace(
        "        return forge_doctor.ROUTE_LABEL[self.target]",
        "        if self.family == \"host\":\n"
        "            return self.notes[0] if self.notes else \"host media tool\"\n"
        "        return forge_doctor.ROUTE_LABEL[self.target]",
        1,
    )
    # 3c. model_of(): the host route names its own model, not a local CLI's.
    text = text.replace(
        "    if candidate.family == \"api\":\n        return candidate.model",
        "    if candidate.family == \"host\":\n"
        "        return \"host media tool\"\n"
        "    if candidate.family == \"api\":\n        return candidate.model",
        1,
    )
    # 4. accept --route host / dsh on the CLI (the route list is a fixed tuple)
    text = text.replace(
        anchors[4],
        "    if args.route in (\"host\", \"dsh\"):  # the host route is not in ROUTE_CHOICES\n"
        "        args.route = \"auto\"\n"
        + anchors[4],
        1,
    )
    # 5. a runner for the host candidate (right before generate())
    text = text.replace(
        anchors[5],
        "def run_host(candidate: Candidate, args: argparse.Namespace) -> dict:\n"
        "    \"\"\"The host route: the workspace shim turns the request into the host's own call.\"\"\"\n"
        "    module = _host_route_media()\n"
        "    if module is None:\n"
        "        raise cli_media.CliMediaError(\"TOOL_UNAVAILABLE\", \"no host bridge in this environment\")\n"
        "    if not hasattr(module, \"run\"):\n"
        "        raise cli_media.CliMediaError(\"TOOL_UNAVAILABLE\", \"the workspace http/route_media.py has no run()\")\n"
        "    try:\n"
        "        result = module.run(candidate.target, args)\n"
        "    except Exception as exc:  # noqa: BLE001  the host's failure is not the request's\n"
        "        raise cli_media.CliMediaError(\"GENERATION_FAILED\", f\"host: {type(exc).__name__}: {exc}\") from None\n"
        "    return {\"artifact\": result[\"artifact\"], \"sha256\": result[\"sha256\"], \"estimateUsd\": 0.0,\n"
        "            \"job\": result.get(\"bridgeArtifact\"), \"notes\": []}\n"
        "\n\n" + anchors[5],
        1,
    )
    # 6. dispatch a host candidate to run_host, not to the local-CLI runner
    text = text.replace(
        anchors[6],
        "            if candidate.family == \"host\":\n"
        "                outcome = run_host(candidate, args)\n"
        "            elif candidate.family == \"api\":\n"
        "                outcome = run_api(candidate, args, transport)\n"
        "            else:\n"
        "                outcome = run_local(candidate, args)",
        1,
    )
    return text, None


def patch_label(text: str) -> tuple[str, str | None]:
    """forge_doctor owns ROUTE_LABEL; teach it the host label so labels never KeyError."""
    if "_HOST_LABEL_READY" in text:
        return text, "already patched"
    anchor = "ROUTE_LABEL = {"
    if anchor not in text:
        return text, "anchor lines missing (upstream changed?): ROUTE_LABEL"
    text = text.replace(
        anchor,
        "ROUTE_LABEL = {\"dsh\": \"DeepSeek Harness image tool (host)\",  # _HOST_LABEL_READY\n",
        1,
    )
    return text, None


def patch_known_model(text: str) -> tuple[str, str | None]:
    """_known_model must not reject --route host (it is not an API provider)."""
    if "_HOST_KNOWN_MODEL_READY" in text:
        return text, "already patched"
    anchor = "def _known_model(kind: str, args: argparse.Namespace) -> None:"
    if anchor not in text:
        return text, "anchor lines missing (upstream changed?): _known_model"
    text = text.replace(
        anchor,
        anchor + "\n"
        "    if getattr(args, \"route\", None) in (\"host\", \"dsh\"):  # _HOST_KNOWN_MODEL_READY\n"
        "        return",
        1,
    )
    return text, None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--forge-root", type=Path, default=Path(__file__).resolve().parents[1],
                        help="agent-sprite-forge checkout (default: the checkout this tool lives in)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--revert", action="store_true", help="restore the newest backup")
    args = parser.parse_args()
    scripts = args.forge_root.resolve() / "skills" / "generate2dmedia" / "scripts"
    # Backups live OUTSIDE the skills folder: install_skills.py copies every
    # non-dot file under a skill, so a .bak beside the script would ship with it.
    backup_dir = args.forge_root.resolve() / ".asf-host-route-backups"
    targets = {
        "route_media.py": (patch, patch_known_model),
        "forge_doctor.py": (patch_label,),
    }
    for filename in targets:
        if not (scripts / filename).is_file():
            print(f"error: {scripts / filename} not found", file=sys.stderr)
            return 1
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    if not args.dry_run:
        # The pristine copies must exist BEFORE anything is patched, or --revert
        # could only undo back to an already-patched file.
        for filename, patchers in targets.items():
            target = scripts / filename
            text = target.read_text(encoding="utf-8")
            pristine = text
            for patcher in patchers:
                pristine, _problem = patcher(pristine)
            if pristine != text and not (backup_dir / f"{filename}.bak-host-route-{stamp}").exists():
                backup_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, backup_dir / f"{filename}.bak-host-route-{stamp}")

    if args.revert:
        restored = 0
        for filename in targets:
            target = scripts / filename
            backups = sorted(backup_dir.glob(f"{filename}.bak-host-route-*")) if backup_dir.is_dir() else []
            if backups:
                shutil.copy2(backups[-1], target)
                print(f"restored {filename} from {backups[-1].name}")
                restored += 1
        if restored == 0:
            print("error: no backup to restore", file=sys.stderr)
            return 1
        return 0

    changed = 0
    for filename, patchers in targets.items():
        target = scripts / filename
        text = target.read_text(encoding="utf-8")
        original = text
        for patcher in patchers:
            text, problem = patcher(text)
            if problem not in (None, "already patched"):
                print(f"error: {filename}: {problem}", file=sys.stderr)
                return 1
        if text == original:
            print(f"already patched: {filename}")
            continue
        try:
            compile(text, str(target), "exec")
        except SyntaxError as exc:
            print(f"error: {filename}: the patch would not compile ({exc.msg} at line {exc.lineno}); nothing was written", file=sys.stderr)
            return 1
        changed += 1
        if args.dry_run:
            print(f"would patch {target}")
            continue
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup = backup_dir / f"{target.name}.bak-host-route-{stamp}"
        if not backup.exists():
            shutil.copy2(target, backup)
        target.write_text(text, encoding="utf-8", newline="")
        print(f"patched {target.name} (backup: {backup_dir.name}/{backup.name})")
    if args.dry_run and changed == 0:
        print("nothing to patch")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
