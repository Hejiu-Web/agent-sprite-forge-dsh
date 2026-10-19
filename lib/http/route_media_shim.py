#!/usr/bin/env python3
"""Mount `asf_host_route.py` as the Forge route layer's `http/route_media.py`.

The Forge route layer has a documented `http/` hook: when `<workspace>/http/`
exists, the skill docs let a host register itself as a route source. This file
is the ONE line a DSH workspace needs:

    <workspace>/http/route_media.py  ->  this file

It loads `asf_host_route.py` (copied next to it by `tools/install_host_route.py`,
or found through `ASF_HOST_ROUTE_DIR`) and re-exports its surface, so every
Forge tool that asks "which route would run?" sees `host:dsh` before it falls
back to code-drawn art.

Copy this file as-is; do not edit it in place.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
CANDIDATES = [
    os.environ.get("ASF_HOST_ROUTE_DIR", ""),
    str(HERE),                # asf_host_route.py sits beside this shim
    str(HERE.parent),         # legacy: http/route_media.py next to http/asf_host_route.py
    str(HERE / "asf_host_route"),
]


def _load():
    for base in CANDIDATES:
        if not base:
            continue
        module_file = Path(base) / "asf_host_route.py"
        if module_file.is_file():
            spec = importlib.util.spec_from_file_location("asf_host_route", module_file)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
    raise SystemExit(
        "asf_host_route.py not found; run `asf-suite`'s tools/install_host_route.py "
        "(or set ASF_HOST_ROUTE_DIR)"
    )


_host = _load()

def bridge_ready(timeout: float = 2.5) -> bool:
    return _host.bridge_ready(timeout)


def diagnose() -> str:
    """One-line explanation of the readiness state, for the Forge route layer."""
    return _host.diagnose()


# Re-export the route surface a Forge caller looks for.
ROUTE_NAME = getattr(_host, "ROUTE_NAME", "host:dsh")
bridge_available = _host.bridge_available
describe = _host.describe
resolve = _host.resolve
run = _host.run
generate_image = _host.generate_image
HostRouteError = _host.HostRouteError


def main(argv: list | None = None) -> int:
    return _host.main(argv)


if __name__ == "__main__":
    sys.exit(main())
