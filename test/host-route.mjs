/**
 * End-to-end test for the Forge route layer 鈫?DSH bridge, using the REAL
 * agent-sprite-forge scripts (no network, no paid generation).
 *
 *   A. `route_media.py` without the host route reports no-route (baseline);
 *   B. with the host route installed in a throwaway workspace and the checkout
 *      patched (a temp copy, never the real one), `route_media.py resolve
 *      --kind image` reports `host:dsh` first;
 *   C. `route_media.py image ...` goes through the bridge to a stubbed
 *      `image_generate`, and the generated file lands in the Forge out-dir;
 *   D. the loop guard stops a host tool that calls the route layer back.
 *
 * Run: node test/host-route.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** `git show` in the checkout: pristine sources for the temp copy. */
function spawnSyncGit(argv) {
  const result = spawnSync("git", argv, { cwd: realForge, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "" };
}

const plugin = await import(new URL("../lib/index.js", import.meta.url).href);
const pluginDir = resolve(process.cwd());

function findForge() {
  const candidates = [
    process.env.ASF_TEST_ROOT,
    resolve(process.cwd(), "agent-sprite-forge"),
    resolve(process.cwd(), "..", "agent-sprite-forge"),
    resolve(process.cwd(), "..", "..", "agent-sprite-forge"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(join(candidate, "skills", "generate2dmedia", "SKILL.md")));
}

const realForge = findForge();
if (realForge === undefined) {
  console.log("agent-sprite-forge checkout not found; set ASF_TEST_ROOT.");
  process.exit(0);
}

const python = (() => {
  const runtime = process.env.USERPROFILE
    ? join(process.env.USERPROFILE, ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python", "python.exe")
    : "";
  return runtime && existsSync(runtime) ? runtime : "python";
})();

const work = mkdtempSync(join(tmpdir(), "asf-host-route-"));
const forge = join(work, "forge");
const project = join(work, "project");
mkdirSync(project, { recursive: true });
// Only the generate2dmedia skill is needed to exercise the route layer. Copy
// the shared scripts only: the tree this test may borrow from can already
// carry the patch and its backups (this machine's checkout does).
cpSync(join(realForge, "skills", "generate2dmedia"), join(forge, "skills", "generate2dmedia"), {
  recursive: true,
  filter: (source) => !/[\\/]\.asf-host-route-backups([\\/]|$)/.test(source) && !/\.bak-host-route-/.test(source),
});
for (const name of ["route_media.py", "forge_doctor.py"]) {
  const pristine = join(realForge, "skills", "generate2dmedia", "scripts", name);
  const target = join(forge, "skills", "generate2dmedia", "scripts", name);
  rmSync(target, { force: true });
  cpSync(pristine, target);
}

const failures = [];
function check(label, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : ` 鈥?${detail}`}`);
  if (!ok) failures.push(label);
}
function parseLastJson(text) {
  const lines = String(text ?? "").split(/\r\n|\r|\n/).filter((line) => line.trim().startsWith("{"));
  const line = lines[lines.length - 1];
  return line === undefined ? undefined : JSON.parse(line);
}
/**
 * Run a child asynchronously: this process ALSO runs the loopback bridge, so a
 * blocking spawnSync would deadlock the child's connection to it.
 */
function run(argv, env, timeout = 120_000) {
  return new Promise((done) => {
    const child = spawn(python, argv, {
      cwd: project,
      // asf_run's contract: every key the plugin resolved for this workspace,
      // including the bridge coordinates (kept out of inherited os.environ).
      env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1", ASF_DSH_WORKSPACE: project, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      done({ status, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ status: -1, signal: undefined, stdout, stderr: `${stderr}\n${error.message}` });
    });
  });
}

const routeScript = join(forge, "skills", "generate2dmedia", "scripts", "route_media.py");
const envOf = (bridge) => ({ ASF_DSH_BRIDGE: bridge.url, ASF_DSH_TOKEN: bridge.token, ASF_DSH_WORKSPACE: project });
const bridgeEnv = (bridge) => envOf(bridge);
const noBridge = { ASF_DSH_BRIDGE: "", ASF_DSH_TOKEN: "" };

console.log("A. baseline: no host route, no bridge");
{
  const result = await run([routeScript, "resolve", "--kind", "image"], noBridge);
  const parsed = parseLastJson(result.stdout);
  check("resolve exits 3", result.status === 3, `status ${result.status}`);
  check("status is no-route", parsed?.status === "no-route");
}

// The plugin (and its bridge) comes up BEFORE any patched run: the route layer
// asks the bridge during `resolve`, and a host route is only offered when the
// bridge is already listening.
const skills = [];
const tools = new Map();
const extra = new Map();
const ctx = {
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  effect(fn) {
    fn();
  },
  skills: { register(skill) { skills.push(skill); return () => {}; } },
  tools: {
    register(tool) { tools.set(tool.name, tool); },
    get(name) { return tools.get(name) ?? extra.get(name); },
    list() { return [...tools.values(), ...extra.values()]; },
  },
};
plugin.apply(ctx, plugin.Config({ forgeRoot: forge, httpBridgePort: 0, __testHooks: true }));
await new Promise((done) => setTimeout(done, 1500));
const bridge = await globalThis.__asfSuiteBridge.ensure();

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const stubArtifact = join(work, "stub-generated.png");
let stubCalls = 0;
extra.set("image_generate", {
  name: "image_generate",
  async execute(args) {
    stubCalls += 1;
    writeFileSync(stubArtifact, PNG);
    void args;
    return { model: "stub-model", mode: "text", images: [{ path: stubArtifact, bytes: PNG.length, source: "b64_json" }] };
  },
});

console.log("B. patch the temp checkout");
{
  // The pre-DeepSeek-Harness scripts: what a user has before running
  // tools/patch_route_media.py. Taken from the newest pre-patch backup, else
  // from the tagged base commit (0.4.0), which upstream ships without the patch.
  cpSync(join(realForge, "skills", "generate2dmedia"), join(forge, "skills", "generate2dmedia"), {
    recursive: true,
    filter: (source) => !/[\\/]\.asf-host-route-backups([\\/]|$)/.test(source) && !/\.bak-host-route-/.test(source),
  });
  const fromBackup = (name) => {
    const backups = join(realForge, ".asf-host-route-backups");
    if (!existsSync(backups)) return "";
    const found = readdirSync(backups).filter((file) => file.startsWith(name) && file.includes(".bak-host-route-")).sort();
    const text = found.length === 0 ? "" : readFileSync(join(backups, found.at(-1)), "utf8");
    return text.includes("def _host_route_media()") ? "" : text;
  };
  const fromTag = (name) => spawnSyncGit(["show", `0.4.0:skills/generate2dmedia/scripts/${name}`]);
  const pristine = (name) => {
    for (const text of [fromBackup(name), fromTag(name)]) {
      if (text.length > 0 && !text.includes("def _host_route_media()")) return text;
    }
    return "";
  };
  for (const name of ["route_media.py", "forge_doctor.py"]) {
    const text = pristine(name);
    check(`  pristine ${name} available`, text.length > 0, "no pre-patch copy found (tag 0.4.0 or a backup)");
    const target = join(forge, "skills", "generate2dmedia", "scripts", name);
    if (text.length > 0) writeFileSync(target, text, "utf8");
  }
  const dry = await run([join(pluginDir, "tools", "patch_route_media.py"), "--forge-root", forge, "--dry-run"]);
  check("dry run reports the plan", dry.status === 0 && /would patch/.test(dry.stdout), dry.stdout || dry.stderr);
  const applied = await run([join(pluginDir, "tools", "patch_route_media.py"), "--forge-root", forge]);
  check("patch applied", applied.status === 0 && /patched/.test(applied.stdout), applied.stdout || applied.stderr);
  const again = await run([join(pluginDir, "tools", "patch_route_media.py"), "--forge-root", forge]);
  check("patch is idempotent", again.status === 0 && /already patched/.test(again.stdout), again.stdout || again.stderr);
  const source = readFileSync(routeScript, "utf8");
  check("host branch inserted", source.includes("if family == \"host\":"));
  check("host runner inserted", source.includes("def run_host("));
  check("doctor label patched", readFileSync(join(forge, "skills", "generate2dmedia", "scripts", "forge_doctor.py"), "utf8").includes("_HOST_LABEL_READY"));
  const unpatchedResolve = await run([routeScript, "resolve", "--kind", "image"], noBridge);
  check("still no-route without a bridge", unpatchedResolve.status === 3);
}

// Install the shim into the project's http/ hook.
const install = await run([join(pluginDir, "tools", "install_host_route.py"), "--workspace", project]);
check("shim installed", install.status === 0 && existsSync(join(project, "http", "route_media.py")), install.stderr || install.stdout);

// The bridge must be ready (a media tool mounted) before a host route is offered.
const ready = await fetch(`${bridge.url}/health`, { headers: { "x-asf-bridge-token": bridge.token } })
  .then((response) => response.json())
  .catch(() => ({}));
check("bridge health reports a mounted tool", ready.ok === true && ready.ready === true, JSON.stringify(ready));

console.log("C. resolve with the bridge");
{
  // What the route layer itself computes: bridge_ready must be true through the
  // workspace shim (a go/crash guard for the assertions below).
  const probe = await run(
    [
      "-c",
      "import sys, os;"
        + `sys.path.insert(0, r'${join(project, "http").replace(/\\/g, "/")}');`
        + "import route_media as shim;"
        + "print('READY', shim.bridge_ready());"
        + "print('WHY', shim.diagnose())",
    ],
    bridgeEnv(bridge),
    60_000,
  );
  check(
    "shim bridge_ready is true",
    /READY True/.test(probe.stdout ?? ""),
    `${(probe.stdout ?? "").trim()} | ${(probe.stderr ?? "").trim().slice(0, 300)}`,
  );

  const result = await run([routeScript, "resolve", "--kind", "image"], bridgeEnv(bridge));
  const parsed = parseLastJson(result.stdout);
  check(
    "resolve exits 0",
    result.status === 0,
    `status=${result.status} skipped=${JSON.stringify((parsed?.skipped ?? []).slice(-2))}`
      + ` stderr=${JSON.stringify((result.stderr ?? "").slice(-300))}`,
  );
  check("route is host:dsh", parsed?.route === "host:dsh", parsed?.route);
  check("host is first in the order", parsed?.order?.[0] === "host:dsh", JSON.stringify(parsed?.order));
}

console.log("D. generate through the bridge");
{
  const promptFile = join(work, "prompt.txt");
  writeFileSync(promptFile, "A slime enemy, front view, pixel-art finish", "utf8");
  // A fresh Forge out-dir per run: Forge refuses an existing folder.
  const outDir = join(project, "out", `slime-${Date.now().toString(36)}`);
  const result = await run(
    [routeScript, "image", "--prompt-file", promptFile, "--size", "1024x1024", "--out-dir", outDir],
    bridgeEnv(bridge),
  );
  const diagnostic = `exit=${result.status} signal=${result.signal ?? "-"} `
    + `stdout=${JSON.stringify((result.stdout ?? "").slice(-300))} stderr=${JSON.stringify((result.stderr ?? "").slice(-500))}`;
  const parsed = parseLastJson(result.stdout);
  check("generate exits 0", result.status === 0, diagnostic);
  check("status ok", parsed?.status === "ok", JSON.stringify(parsed ?? {}).slice(0, 200));
  check("route host:dsh", parsed?.route === "host:dsh", parsed?.route);
  check("artifact inside out-dir", typeof parsed?.artifact === "string" && parsed.artifact.startsWith(outDir), parsed?.artifact);
  check("artifact exists", typeof parsed?.artifact === "string" && existsSync(parsed.artifact));
  check("sha256 present", /^[0-9a-f]{64}$/.test(parsed?.sha256 ?? ""));
  check("the media tool actually ran", stubCalls === 1, String(stubCalls));
}

console.log("E. loop guard: the shim refuses a deep re-entry");
{
  // The guard is env-based: a third nested call in one chain raises instead of
  // spawning another process tree.
  const result = await run(
    [
      "-c",
      "import sys; sys.path.insert(0, r'" + join(project, "http").replace(/\\/g, "/") + "');"
        + "import asf_host_route as h;"
        + "import os; os.environ['ASF_HOST_ROUTE_DEPTH']='3';"
        + "\ntry:\n  h.generate_image('x', 'out/z')\n  print('NO-RAISE')\nexcept h.HostRouteError as exc:\n  print('GUARDED:', exc)",
    ],
    bridgeEnv(bridge),
    60_000,
  );
  check("guard raises a readable error", /GUARDED: host route recursion detected/.test(result.stdout ?? ""), result.stdout || result.stderr);
}

console.log("F. revert");
{
  const reverted = await run([join(pluginDir, "tools", "patch_route_media.py"), "--forge-root", forge, "--revert"]);
  check("revert exits 0", reverted.status === 0, reverted.stderr);
  check("marker gone", !readFileSync(routeScript, "utf8").includes("ASF host route"));
}

/* ------------------------------- cleanup -------------------------------- */

try {
  await globalThis.__asfSuiteBridge.state.server?.close?.();
} catch {
  // already closed
}
rmSync(work, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed.");
}
process.exit(process.exitCode ?? 0);

