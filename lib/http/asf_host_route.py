#!/usr/bin/env python3
"""A `host` route for the Agent Sprite Forge route layer (DeepSeek Harness edition).

The Forge route layer (`route_media.py`) answers `no-route` (exit 3) when no API
key is configured and no local Codex/Grok CLI is installed, which sends every
caller to the code-drawn fallback. A host that HAS an image tool — DeepSeek
Harness has `image_generate` (image-gen plugin) or `image_gen` — should be a
real route instead. The Forge docs already describe the ladder as
"the calling agent's own media tool, then the user's signed-in CLIs"; this
shim adds the missing branch.

Install (any one of these):

  * copy it to `<workspace>/http/route_media.py` — the plugin's `asf_run`
    exports ASF_DSH_BRIDGE / ASF_DSH_TOKEN, and this file posts there;
  * or point the workspace's `http/route_media.py` at it with a one-line import.

It is a drop-in `route_media` module: `resolve()` reports the host route first
when a bridge is available, `generate()` (or `run_image`) posts the request to
the bridge, downloads the artifact into `--out-dir` and returns the same result
shape the Forge CLI prints (status, route, artifact, sha256, ...).

The shim never sees an API key: the bridge authenticates with a random token the
plugin injects into the script environment. Standalone use on a non-DSH host is
possible by setting ASF_DSH_BRIDGE (e.g. http://127.0.0.1:PORT) and
ASF_DSH_TOKEN, or by running `serve()` as a tiny CLI of its own.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request

BRIDGE_ENV = "ASF_DSH_BRIDGE"
TOKEN_ENV = "ASF_DSH_TOKEN"
ROUTE_NAME = "host:dsh"
TIMEOUT = 600


class HostRouteError(Exception):
    """The host bridge refused or failed the request."""


def bridge_available() -> bool:
    """True when this process was started by a host that exports a bridge."""
    return bool(os.environ.get(BRIDGE_ENV, "").strip() and os.environ.get(TOKEN_ENV, "").strip())


def diagnose() -> str:
    """Why the bridge is or is not ready, as one ASCII line."""
    if not os.environ.get(BRIDGE_ENV, "").strip():
        return "no ASF_DSH_BRIDGE in the environment"
    if not os.environ.get(TOKEN_ENV, "").strip():
        return "no ASF_DSH_TOKEN in the environment"
    base = os.environ[BRIDGE_ENV].strip().rstrip("/")
    request = urllib.request.Request(base + "/health", method="GET", headers={
        "x-asf-bridge-token": os.environ[TOKEN_ENV].strip(),
    })
    try:
        with urllib.request.urlopen(request, timeout=2.5) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return f"HTTP {exc.code} from {base}/health (token rejected?)"
    except Exception as exc:  # noqa: BLE001
        return f"{base}/health unreachable ({type(exc).__name__}: {exc})"
    tool = body.get("tool")
    return f"bridge at {base}: ok={body.get('ok')!r} ready={body.get('ready')!r} tool={tool!r} pid={body.get('pid')!r}"


def bridge_ready(timeout: float = 2.5) -> bool:
    """True when the bridge answers /health with a mounted media tool.

    `bridge_available` only proves the variables exist; the route layer asks for
    a *usable* host route, so a booting or tool-less host must answer False
    instead of taking the request and failing it.
    """
    if not bridge_available():
        return False
    base = os.environ[BRIDGE_ENV].strip().rstrip("/")
    request = urllib.request.Request(base + "/health", method="GET", headers={
        "x-asf-bridge-token": os.environ[TOKEN_ENV].strip(),
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except Exception:  # noqa: BLE001  an unreachable bridge is simply not ready
        return False
    return bool(body.get("ok")) and body.get("ready") is True


def describe() -> dict:
    return {"route": ROUTE_NAME, "kind": ["image"], "label": "DeepSeek Harness image tool",
            "available": bridge_available()}


def post_json(url: str, payload: dict, token: str, timeout: float = TIMEOUT) -> dict:
    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "x-asf-bridge-token": token,
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise HostRouteError(f"host bridge answered HTTP {exc.code}: {detail}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HostRouteError(f"host bridge unreachable ({type(exc).__name__}: {exc})") from None


# --------------------------------------------------------------------------- loop guard
#
# The bridge dispatches to the host's media tool, and this workspace's `http/`
# hook is visible to every Forge script — including the one the host may call
# back into. If a host tool ever reaches this module again inside the same
# call chain, the recursion is cut here with a readable error instead of
# spawning processes until the machine gives up.
_GUARD_ENV = "ASF_HOST_ROUTE_DEPTH"
_MAX_DEPTH = 3


def _enter() -> None:
    depth = int(os.environ.get(_GUARD_ENV, "0") or "0")
    if depth >= _MAX_DEPTH:
        raise HostRouteError(
            f"host route recursion detected (depth {depth}); the host media tool must not call the Forge route layer"
        )
    os.environ[_GUARD_ENV] = str(depth + 1)


def _leave(previous: str | None) -> None:
    if previous is None:
        os.environ.pop(_GUARD_ENV, None)
    else:
        os.environ[_GUARD_ENV] = previous


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _unique(target: Path) -> Path:
    if not target.exists():
        return target
    stem, suffix = target.stem, target.suffix
    for index in range(1, 1000):
        candidate = target.with_name(f"{stem}-{index}{suffix}")
        if not candidate.exists():
            return candidate
    raise HostRouteError(f"too many files already named {target.name}")


def generate_image(prompt: str, out_dir: str | Path, references: list | None = None,
                   size: str | None = None) -> dict:
    """One host-generated image, copied into ``out_dir`` as ``generated<ext>``.

    Returns {"artifact", "sha256", "route", "bridgeArtifact", "model"} — the
    artifact is a local path, like every other Forge route's output.
    """
    base = os.environ.get(BRIDGE_ENV, "").strip()
    token = os.environ.get(TOKEN_ENV, "").strip()
    if not base or not token:
        raise HostRouteError(f"no host bridge: set {BRIDGE_ENV} and {TOKEN_ENV} (the DSH asf-suite plugin does this)")
    previous = os.environ.get(_GUARD_ENV)
    _enter()
    try:
        payload = {"prompt": prompt}
        if references:
            payload["references"] = [str(item) for item in references]
        if size:
            payload["size"] = size
        result = post_json(base.rstrip("/") + "/image", payload, token)
    finally:
        _leave(previous)
    if result.get("status") != "ok" or not result.get("artifact"):
        raise HostRouteError(result.get("error") or "host bridge returned no artifact")
    source = Path(result["artifact"])
    if not source.is_file():
        raise HostRouteError(f"host bridge reported {source}, which does not exist")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    target = _unique(out / ("generated" + (source.suffix or ".png")))
    target.write_bytes(source.read_bytes())
    return {"artifact": str(target), "sha256": _sha256(target), "route": ROUTE_NAME,
            "bridgeArtifact": str(source), "model": result.get("model")}


# --------------------------------------------------------------------------- Forge drop-in surface

def resolve(kind: str, route: str = "auto", **_kwargs) -> dict:
    """The Forge `resolve` shape for the host route: candidates only when a bridge exists."""
    if kind != "image" or not bridge_available() or route not in ("auto", "local", "host", "dsh"):
        return {"status": "no-route", "fallback": "codeart2d", "kind": kind, "requested": route,
                "skipped": [f"{ROUTE_NAME}: no host bridge in this environment"]}
    return {"status": "ok", "kind": kind, "route": ROUTE_NAME, "label": describe()["label"],
            "order": [ROUTE_NAME], "available": [ROUTE_NAME], "skipped": []}


def run(route: str, args) -> dict:  # pragma: no cover - exercised through the CLI below
    """The Forge `generate()` branch for ``route == ROUTE_NAME``."""
    prompt_file = getattr(args, "prompt_file", None)
    if prompt_file is None:
        raise HostRouteError("the host route needs --prompt-file")
    prompt = Path(prompt_file).read_text(encoding="utf-8-sig")
    references = [str(item) for item in getattr(args, "reference", []) or []]
    return generate_image(prompt, getattr(args, "out_dir", "."), references, getattr(args, "size", None))


def main(argv: list | None = None) -> int:
    """Standalone CLI: `python route_media.py image --prompt-file P [--reference R] --out-dir D`."""
    raw = list(sys.argv[1:] if argv is None else argv)
    if not raw or raw[0] not in ("image", "resolve"):
        print("usage: route_media.py {image|resolve} [--prompt-file P] [--reference R] --out-dir D [--kind image]",
              file=sys.stderr)
        return 2
    import argparse

    parser = argparse.ArgumentParser(prog="route_media.py")
    sub = parser.add_subparsers(dest="command", required=True)
    image = sub.add_parser("image")
    image.add_argument("--prompt-file", required=True)
    image.add_argument("--reference", action="append", default=[])
    image.add_argument("--size")
    image.add_argument("--out-dir", required=True)
    resolve_cmd = sub.add_parser("resolve")
    resolve_cmd.add_argument("--kind", default="image")
    resolve_cmd.add_argument("--route", default="auto")
    args = parser.parse_args(raw)
    try:
        if args.command == "resolve":
            result = resolve(args.kind, args.route)
            print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
            return 0 if result["status"] == "ok" else 3
        result = run(ROUTE_NAME, args)
        print(json.dumps({"status": "ok", "route": ROUTE_NAME, "estimateUsd": 0.0, **result},
                         ensure_ascii=True, separators=(",", ":")))
        return 0
    except HostRouteError as exc:
        print("error: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
