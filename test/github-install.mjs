/**
 * Simulate a DSH GitHub-URL install of THIS repository, offline.
 *
 * DSH's plugin installer turns "https://github.com/<owner>/<repo>#<ref>" into a
 * dependency "dsh-agent-sprite-forge": "github:<owner>/<repo>#<ref>" in the
 * profile. Without network access we reproduce what npm/pnpm would produce for
 * the same commit:
 *
 *   WORK/
 *     repo.tgz                  a `git archive` of the commit
 *     profile/package.json      the dependency plus the resolved lock entry
 *                               (integrity = the tarball's sha512)
 *     profile/node_modules/<pkg>/            the extracted tarball
 *
 * Then it resolves the plugin the way DSH's loader does: package.json →
 * dsh.bundle.patch → the row's package name → lib/index.js, and mounts it
 * against the real Forge checkout to see the five skills register.
 *
 * Run from the repository root: node test/github-install.mjs [--sha <commit>]
 * (omit --sha to pack the working tree's HEAD; uncommitted files are not packed).
 * The Forge checkout is found as ../agent-sprite-forge, or via ASF_FORGE_ROOT.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd());
if (!existsSync(join(repo, "package.json"))) {
  console.log("run this from the adapter repository root");
  process.exit(0);
}
const forge = [process.env.ASF_FORGE_ROOT, resolve(repo, "..", "agent-sprite-forge")]
  .find((candidate) => candidate && existsSync(join(candidate, "skills", "generate2dsprite", "SKILL.md")));
if (forge === undefined) {
  console.log("Agent Sprite Forge checkout not found; set ASF_FORGE_ROOT or put it beside this repository.");
  process.exit(0);
}

const shaIndex = process.argv.indexOf("--sha");
const sha = shaIndex >= 0 ? process.argv[shaIndex + 1] : undefined;
const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const name = manifest.name;
const spec = `github:Hejiu-Web/agent-sprite-forge-dsh${sha ? `#${sha}` : ""}`;
const work = join(tmpdir(), `dsh-gh-${name}-${sha ? sha.slice(0, 8) : "wd"}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "profile"), { recursive: true });

console.log("1. pack the repository");
const tarball = join(work, "repo.tgz");
execFileSync("git", ["archive", "--format=tar.gz", "--prefix=package/", "-o", tarball, sha ?? "HEAD"], { cwd: repo });
const body = readFileSync(tarball);
check("tarball written", body.length > 0, `${body.length} bytes`);

console.log("2. profile manifest as the installer writes it");
const profile = join(work, "profile");
writeFileSync(join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-verify", private: true, dependencies: { [name]: spec } }, null, 2));
writeFileSync(join(profile, "package-lock.json"), JSON.stringify({
  name: "dsh-profile-verify",
  lockfileVersion: 3,
  packages: {
    "": { dependencies: { [name]: spec } },
    [`node_modules/${name}`]: {
      name,
      version: spec,
      resolved: "file:repo.tgz",
      integrity: "sha512-" + createHash("sha512").update(body).digest("base64"),
    },
  },
}, null, 2));
check("root manifest declares dsh.bundle.patch", typeof manifest.dsh?.bundle?.patch === "string", JSON.stringify(manifest.dsh));

console.log("3. extract where node_modules would put it");
const installed = join(profile, "node_modules", name);
mkdirSync(installed, { recursive: true });
execFileSync("tar", ["-xzf", tarball, "-C", installed, "--strip-components=1"]);
const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
check("installed manifest matches", installedManifest.name === name && installedManifest.version === manifest.version);

console.log("4. resolve the plugin the way the loader does");
const patchPath = join(installed, installedManifest.dsh.bundle.patch);
check("bundle patch exists", existsSync(patchPath), patchPath);
const patchText = readFileSync(patchPath, "utf8");
const rowName = /^\s*name:\s*([A-Za-z0-9@/_-]+)\s*$/m.exec(patchText)?.[1];
check("patch row names this package", rowName === name, `${rowName} vs ${name}`);
check("entry file present", existsSync(join(installed, installedManifest.main)));
check("host-route tools shipped", existsSync(join(installed, "tools", "setup.py"))
  && existsSync(join(installed, "tools", "patch_route_media.py"))
  && existsSync(join(installed, "tools", "install_host_route.py")));
check("http shim shipped", existsSync(join(installed, "lib", "http", "route_media_shim.py")));

console.log("5. runtime dependencies next to the plugin (what npm installs)");
const depsRoot = join(installed, "node_modules", "@deepseek-ai");
mkdirSync(depsRoot, { recursive: true });
const profiles = join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "node_modules", "@deepseek-ai");
for (const dep of ["schemastery", "dsh-tools", "dsh-credentials", "dsh-llm", "dsh-util-values"]) {
  if (existsSync(join(profiles, dep))) {
    execFileSync("cmd", ["/c", "mklink", "/J", join(depsRoot, dep), join(profiles, dep)], { stdio: "ignore" });
  }
}

console.log("6. load the plugin entry and mount it");
const plugin = await import(new URL(`file:///${join(installed, "lib", "index.js").replace(/\\/g, "/")}`).href);
check("exports apply/inject/name", typeof plugin.apply === "function" && Array.isArray(plugin.inject) && typeof plugin.name === "string");
const skills = [];
const ctx = {
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  effect(fn) { fn(); },
  skills: { register(skill) { skills.push(skill); return () => {}; } },
  tools: { register() {}, get() {}, list() { return []; } },
};
plugin.apply(ctx, plugin.Config({ forgeRoot: forge, httpBridge: false, httpBridgePort: 0 }));
await new Promise((done) => setTimeout(done, 800));
check("five skills registered from the installed tree", skills.length === 5, skills.map((skill) => skill.name).join(","));
check("skill resourceBase is a directory", skills.every((skill) => skill.resourceBase?.kind === "directory"));

rmSync(work, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed.");
}
process.exit(process.exitCode ?? 0);
