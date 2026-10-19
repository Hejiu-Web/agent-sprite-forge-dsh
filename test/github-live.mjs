/**
 * REAL GitHub install verification (network): download the repository tarball
 * from GitHub the way a DSH "Add plugin → GitHub" install does, then resolve
 * and mount the plugin exactly like the loader would.
 *
 * Unlike test/github-install.mjs (offline, git archive), every byte here comes
 * from github.com/codeload.github.com over the proxy.
 *
 * Run: node test/github-live.mjs [<ref>]   (default ref: main)
 * Needs a local Forge checkout (ASF_FORGE_ROOT, or ../agent-sprite-forge) to
 * mount the skills against, and a reachable proxy for codeload.github.com.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(process.cwd());
const FORGE = [process.env.ASF_FORGE_ROOT, resolve(repo, "..", "agent-sprite-forge")]
  .find((candidate) => candidate && existsSync(join(candidate, "skills", "generate2dsprite", "SKILL.md")));
if (FORGE === undefined) {
  console.log("Agent Sprite Forge checkout not found; set ASF_FORGE_ROOT.");
  process.exit(0);
}

const OWNER_REPO = process.env.ASF_DSH_REPO ?? "Hejiu-Web/agent-sprite-forge-dsh";
const ref = process.argv[2] ?? "main";
const proxy = process.env.HTTPS_PROXY ?? "http://127.0.0.1:10810";
const url = `https://codeload.github.com/${OWNER_REPO}/tar.gz/refs/heads/${ref}`;
const work = join(tmpdir(), `dsh-live-${ref}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "profile", "node_modules"), { recursive: true });

const failures = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

console.log(`1. download ${url}`);
const tarball = join(work, "repo.tgz");
execFileSync("curl.exe", ["-sSL", "-m", "180", "-x", proxy, "-o", tarball, url], { stdio: "inherit" });
const body = readFileSync(tarball);
check("tarball downloaded", body.length > 1000, `${body.length} bytes`);
check("tarball is gzip", body[0] === 0x1f && body[1] === 0x8b);
const integrity = "sha512-" + createHash("sha512").update(body).digest("base64");

console.log("2. install it the way npm does");
const npmDir = join(work, "profile", "node_modules", "dsh-agent-sprite-forge");
mkdirSync(npmDir, { recursive: true });
execFileSync("tar", ["-xzf", tarball, "-C", npmDir, "--strip-components=1"]);
const manifest = JSON.parse(readFileSync(join(npmDir, "package.json"), "utf8"));
check("package.json from GitHub", manifest.name === "dsh-agent-sprite-forge", manifest.name);
check("version", manifest.version === "1.0.0", manifest.version);

console.log("3. loader resolution");
const patchPath = join(npmDir, manifest.dsh.bundle.patch);
check("dsh.bundle.patch present", existsSync(patchPath), manifest.dsh.bundle.patch);
const rowName = /^\s*name:\s*([A-Za-z0-9@/_-]+)\s*$/m.exec(readFileSync(patchPath, "utf8"))?.[1];
check("patch row = package name", rowName === manifest.name, rowName);
check("entry file present", existsSync(join(npmDir, manifest.main)));
check("tools/setup.py shipped", existsSync(join(npmDir, "tools", "setup.py")));
check("upstream patch shipped", existsSync(join(npmDir, "upstream", "host-route.patch")));

console.log("4. runtime dependencies (as npm installs them)");
const depsRoot = join(npmDir, "node_modules", "@deepseek-ai");
mkdirSync(depsRoot, { recursive: true });
const profiles = join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "node_modules", "@deepseek-ai");
for (const dep of ["schemastery", "dsh-tools", "dsh-credentials", "dsh-llm", "dsh-util-values"]) {
  if (existsSync(join(profiles, dep))) {
    execFileSync("cmd", ["/c", "mklink", "/J", join(depsRoot, dep), join(profiles, dep)], { stdio: "ignore" });
  }
}

console.log("5. load + mount against the real Forge checkout");
const plugin = await import(new URL(`file:///${join(npmDir, "lib", "index.js").replace(/\\/g, "/")}`).href);
const skills = [];
plugin.apply({
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  effect(fn) { fn(); },
  skills: { register(skill) { skills.push(skill); return () => {}; } },
  tools: { register() {}, get() {}, list() { return []; } },
}, plugin.Config({ forgeRoot: FORGE, httpBridge: false, httpBridgePort: 0 }));
await new Promise((done) => setTimeout(done, 800));
check("five skills registered", skills.length === 5, skills.map((skill) => skill.name).join(","));

writeFileSync(join(work, "integrity.txt"), `${url}\n${integrity}\ncommitted tarball bytes: ${body.length}\n`);
console.log(`\nintegrity for a github: dependency: ${integrity}`);
console.log(`work dir kept for inspection: ${work}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed (live, from GitHub).");
}
process.exit(process.exitCode ?? 0);
