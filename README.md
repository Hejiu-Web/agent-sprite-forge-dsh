# dsh-agent-sprite-forge

DeepSeek Harness adapter for [Agent Sprite Forge](https://github.com/0x0funky/agent-sprite-forge).

This repository holds **only the DSH host** — not a copy of the Forge skills. It
registers the five Forge skills with DSH, runs their Python processors with the
Python DSH already ships, and connects the Forge route layer to DSH's own image
tool, so the skills work in DSH without any API key.

- Skills served from your checkout: `generate2dsprite`, `video2dsprite`,
  `generate2dmap`, `generate2dmedia`, `codeart2d`
- Tools added to DSH: `asf_run`, `asf_doctor`, `asf_forge_info`
- Route added to the Forge route layer: `host:dsh` (DSH's image tool)

## Install

1. **DSH**: Plugin page → Add plugin → GitHub →
   `https://github.com/Hejiu-Web/agent-sprite-forge-dsh`
   (or npm `dsh-agent-sprite-forge@1.0.0` once published).
2. **Your project**: run the setup once, pointing at your Forge checkout:

   ```powershell
   python <plugin>/tools/setup.py `
       --forge-root E:\path\to\agent-sprite-forge `
       --workspace E:\path\to\your-game
   ```

   It patches the checkout's route layer (2 files, +72/−2, backups in
   `.asf-host-route-backups/`), installs `<project>/http/route_media.py`, and
   prints the Forge capability check.
3. Restart DSH (or reload the plugin) and start a session in the project. The
   five skills appear in the session skill catalog.

`--dry-run` prints the plan without writing. Undo:

```powershell
python <plugin>/tools/patch_route_media.py --forge-root <checkout> --revert
```

## How it works

| Piece | What it does |
| --- | --- |
| `lib/index.js` | Registers the skills on `ctx.skills` with `resourceBase` = the skill folder; provides `asf_run` (runs a skill script with the resolved Python), `asf_doctor`, `asf_forge_info`; serves the loopback bridge |
| `lib/http/asf_host_route.py` | The bridge client: `bridge_ready()` probes `/health`, `generate_image()` posts to the bridge (token-guarded, loop-guarded) |
| `lib/http/route_media_shim.py` | The `<project>/http/route_media.py` hook installed by the tool |
| `tools/patch_route_media.py` | Adds the `host` family to the checkout's `route_media.py` (and its label to `forge_doctor.py`); idempotent, compile-checked, `--revert` |
| `tools/install_host_route.py` | Writes the workspace hook |
| `upstream/host-route.patch` | The same upstream change as a patch, for a pull request to the Forge repository — this adapter does not need it applied |

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `forgeRoot` | `""` | Checkout path; empty = search `workspaceCandidates` |
| `python.path` | `""` | Empty = DSH runtime Python, then PATH (needs numpy + Pillow) |
| `skillPrefix` | `""` | Prefix to avoid name clashes |
| `registerSkills` | `true` | Register the five skills |
| `mediaTools` | `[image_generate, image_gen]` | Tool the bridge dispatches to |
| `httpBridge` / `httpBridgePort` | `true` / `0` | Loopback bridge |

## Tests

```powershell
npm test                          # skills + asf_run + bridge, then the route-layer end-to-end
node test/github-install.mjs E:/path/to/agent-sprite-forge   # offline GitHub install simulation
```

## License

MIT. Agent Sprite Forge itself is MIT and lives in its own repository.
