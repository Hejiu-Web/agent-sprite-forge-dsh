# Upstream patches (optional)

`host-route.patch` makes the Forge route layer understand a `host:dsh` route.
The adapter **does not need it applied by hand**: `tools/patch_route_media.py`
applies the same change to your checkout (idempotent, with `--revert`).

It is kept here so the change can be proposed to the Forge repository as a pull
request:

```bash
cd agent-sprite-forge
git checkout -b dsh-host-route
git apply /path/to/agent-sprite-forge-dsh/upstream/host-route.patch
git commit -am "feat(routes): a host route for the calling agent's image tool"
```

`readme-route-table.patch` only adds the route row to the Forge README and is
there for the same purpose.

Both are plain `git diff` output against Agent Sprite Forge 0.4.0 (commit
`5324342`). If upstream changes those files, use
`tools/patch_route_media.py --dry-run` first: it refuses to write when it cannot
find its anchors.
