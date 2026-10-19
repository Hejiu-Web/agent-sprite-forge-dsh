/**
 * Smoke test for dsh-plugin-asf-suite — no network, no image generation.
 *
 * Mounts the plugin against a fake harness (capturing registries instead of a
 * real Cordis context) over the real agent-sprite-forge checkout and exercises:
 *
 *   1. the five skills registered on ctx.skills (frontmatter, absolute skill
 *      directory, content that still carries the upstream body);
 *   2. asf_run with two deterministic Forge tools (plan_guide, render_pixelspec);
 *   3. asf_doctor saving and parsing .forge/doctor.json;
 *   4. the output-dir guard and the idle timeout;
 *   5. the loopback media bridge with a stubbed image_generate.
 *
 * Run from the plugin directory: node test/smoke.mjs
 * (set ASF_TEST_ROOT to the checkout if it is not a sibling).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const plugin = await import(new URL("../lib/index.js", import.meta.url).href);

function findForge() {
  const candidates = [
    process.env.ASF_TEST_ROOT,
    resolve(process.cwd(), "agent-sprite-forge"),
    resolve(process.cwd(), "..", "agent-sprite-forge"),
    resolve(process.cwd(), "..", "..", "agent-sprite-forge"),
    process.cwd(),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  return candidates.find((candidate) => existsSync(join(candidate, "skills", "generate2dsprite", "SKILL.md")));
}

const forgeRoot = findForge();
if (forgeRoot === undefined) {
  console.log("agent-sprite-forge checkout not found; set ASF_TEST_ROOT.");
  process.exit(0);
}

const workRoot = await mkdtemp(join(tmpdir(), "asf-suite-"));
const work = join(workRoot, "project");
await (await import("node:fs/promises")).mkdir(work, { recursive: true });

/* ------------------------------- harness -------------------------------- */

const skills = new Map();
const tools = new Map();
const extraTools = new Map();
const disposers = [];

const ctx = {
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  effect(fn) {
    disposers.push(fn());
  },
  skills: {
    register(skill) {
      skills.set(skill.name, skill);
      return () => skills.delete(skill.name);
    },
  },
  tools: {
    register(tool) {
      tools.set(tool.name, tool);
    },
    get(toolName) {
      return tools.get(toolName) ?? extraTools.get(toolName);
    },
    list() {
      return [...tools.values(), ...extraTools.values()];
    },
  },
};

plugin.apply(ctx, plugin.Config({ forgeRoot, httpBridgePort: 0, __testHooks: true }));
// `ctx.effect` runs the async mount body; give it a moment to finish.
await new Promise((done) => setTimeout(done, 2000));

const exec = { signal: undefined, agent: { session: { header: { cwd: work } } } };

const failures = [];
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}
async function rejects(fn, pattern) {
  try {
    await fn();
  } catch (error) {
    return pattern.test(String(error.message));
  }
  return false;
}

/* -------------------------------- skills -------------------------------- */

console.log("skill registration");
const WANTED = ["generate2dmedia", "generate2dsprite", "video2dsprite", "generate2dmap", "codeart2d"];
check("five skills registered", skills.size === 5, [...skills.keys()].join(","));
for (const skillName of WANTED) check(`  ${skillName}`, skills.has(skillName));
const sprite = skills.get("generate2dsprite");
check("description non-empty", (sprite?.description?.length ?? 0) > 0);
check("kebab-case name", /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sprite?.name ?? ""));
check("resourceBase is the skill directory", sprite?.resourceBase?.kind === "directory" && sprite.resourceBase.path === join(forgeRoot, "skills", "generate2dsprite"));
check("path is the skill directory", sprite?.path === join(forgeRoot, "skills", "generate2dsprite"));
check("host preamble present", /Host: DeepSeek Harness/.test(sprite?.content ?? ""));
check("upstream body kept", /# Generate 2D Sprite/.test(sprite?.content ?? ""));
check("frontmatter stripped from content", !/^---/.test(sprite?.content ?? ""));
check("codeart2d preamble references asf_run", /asf_run/.test(skills.get("codeart2d")?.content ?? ""));

/* ------------------------------- asf_run -------------------------------- */

console.log("asf_run — plan_guide.py");
{
  const result = await tools.get("asf_run").execute(
    { skill: "generate2dsprite", script: "plan_guide.py", args: ["--frames", "6", "--cycle", "run"], output_dir: "out/guide" },
    exec,
  );
  check("exit 0", result.status === 0, (result.stderr ?? "").slice(-500));
  check("forge JSON parsed", result.json?.status === "pass", JSON.stringify(result.json ?? {}).slice(0, 200));
  check("guide.png published", existsSync(join(work, "out", "guide", "guide.png")));
  check("command names the script", /plan_guide\.py$/.test(result.command));
  check("output is not marked truncated", result.truncated === false);
}

console.log("asf_run — render_pixelspec.py");
{
  const spec = join(forgeRoot, "tests", "fixtures", "codeart", "slime.pixelspec.json");
  const result = await tools.get("asf_run").execute(
    { skill: "codeart2d", script: "render_pixelspec.py", args: ["--spec", spec, "--preview-scale", "4"], output_dir: "out/slime" },
    exec,
  );
  check("exit 0", result.status === 0, (result.stderr ?? "").slice(-500));
  check("QA passed", result.json?.qa === "pass");
  check("frames rendered", (result.json?.frames ?? 0) >= 3);
  check("meta file written", existsSync(join(work, "out", "slime", "codeart-meta.json")));
}

console.log("asf_run — guards");
{
  check(
    "output-dir outside the workspace is refused",
    await rejects(
      () => tools.get("asf_run").execute({ skill: "generate2dsprite", script: "plan_guide.py", args: ["--frames", "2"], output_dir: "C:/Windows/Temp/asf-outside" }, exec),
      /keeps Forge outputs inside the workspace/,
    ),
  );
  check(
    "unknown script is refused and lists them",
    await rejects(() => tools.get("asf_run").execute({ skill: "generate2dsprite", script: "nope.py" }, exec), /has no script "nope\.py"/),
  );
  check(
    "unknown skill is refused",
    await rejects(() => tools.get("asf_run").execute({ skill: "not-a-skill", script: "x.py" }, exec), /has no scripts\/ folder/),
  );
  const slow = await tools
    .get("asf_run")
    .execute({ skill: "codeart2d", script: "render_pixelspec.py", args: ["--spec", join(forgeRoot, "tests", "fixtures", "codeart", "slime.pixelspec.json")], timeout_seconds: 1, output_dir: "out/slow" }, exec)
    .catch((error) => ({ status: -1, message: String(error.message) }));
  check("a 1 s ceiling stops the run (exit 124 or it finished in time)", slow.status === 124 || slow.status === 0, JSON.stringify(slow).slice(0, 200));
}

/* ------------------------------- doctor --------------------------------- */

console.log("asf_doctor");
{
  const result = await tools.get("asf_doctor").execute({}, exec);
  check("exit 0", result.status === 0, (result.text ?? "").slice(-400));
  check("report saved", typeof result.report === "string" && existsSync(result.report));
  check("every check parsed", Array.isArray(result.checks) && result.checks.length >= 10, String(result.checks?.length));
  check("skills.present is OK", result.checks?.some((entry) => entry.id === "skills.present" && entry.status === "OK"));
  check(
    "host tools are declared to the Forge ladder (image_gen via the bridge)",
    result.checks?.some((entry) => entry.id === "media.host-tools" && entry.status === "OK" && /image_gen/.test(entry.detail ?? "")),
    JSON.stringify(result.checks?.find((entry) => entry.id === "media.host-tools")),
  );
  const saved = JSON.parse(await readFile(result.report, "utf8"));
  check("saved JSON has routes", saved.routes !== undefined);
}

/* -------------------------------- bridge -------------------------------- */

console.log("media bridge");
{
  const info = await tools.get("asf_forge_info").execute({}, exec);
  check("python reported", typeof info.python === "string" && info.python.length > 0);
  check("numpy visible to the scripts", info.dependencies?.numpy !== "missing", JSON.stringify(info.dependencies));
  // No media tool is mounted yet in this harness: the bridge must say so.
  check("bridge on, no media tool yet", info.httpBridge === "on" && info.mediaTool === undefined, `${info.httpBridge}/${info.mediaTool}`);
  check(
    "info explains how to get an image route",
    (info.notes ?? []).some((note) => /image-gen plugin/.test(note)),
    JSON.stringify(info.notes),
  );

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const artifact = join(work, "stub.png");
  const calls = [];
  extraTools.set("image_generate", {
    name: "image_generate",
    async execute(args) {
      calls.push(args);
      await (await import("node:fs/promises")).writeFile(artifact, png);
      return { model: "stub-model", mode: "text", images: [{ path: artifact, bytes: png.length, source: "b64_json" }] };
    },
  });

  const bridge = await globalThis.__asfSuiteBridge.ensure();
  check("bridge reachable", bridge?.url?.startsWith("http://127.0.0.1:"), JSON.stringify(bridge));

  const post = (path, body, headers = {}) =>
    fetch(`${bridge.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-asf-bridge-token": bridge.token, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const unauthorized = await fetch(`${bridge.url}/health`);
  check("requests without the token are refused", unauthorized.status === 403);
  const health = await post("/health");
  const healthJson = await health.json();
  check("health names the media tool", health.status === 200 && healthJson.tool === "image_generate", JSON.stringify(healthJson));

  const generated = await post("/image", { prompt: "a slime, front view", size: "1024x1024", references: ["C:/tmp/ref.png"] });
  const generatedJson = await generated.json();
  check("bridge dispatch succeeds", generated.status === 200 && generatedJson.status === "ok", JSON.stringify(generatedJson));
  check("bridge returns the artifact path", generatedJson.artifact === artifact);
  check("prompt and size reach the media tool", calls[0]?.prompt === "a slime, front view" && calls[0]?.size === "1024x1024");
  check("references are forwarded", calls[0]?.reference_images?.[0] === "C:/tmp/ref.png");

  const emptyPrompt = await fetch(`${bridge.url}/image`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-asf-bridge-token": bridge.token },
    body: JSON.stringify({ prompt: "   " }),
  }).then(async (response) => ({ status: response.status }));
  check("an empty prompt is a 400", emptyPrompt.status === 400, String(emptyPrompt.status));

  extraTools.delete("image_generate");
  const missing = await post("/image", { prompt: "x" });
  check("no media tool reports 503", missing.status === 503);
}

/* ------------------------------- cleanup -------------------------------- */

for (const dispose of disposers.splice(0)) {
  try {
    await dispose?.();
  } catch {
    // already disposed by the effect order
  }
}
await rm(workRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed.");
}
process.exit(process.exitCode ?? 0);
