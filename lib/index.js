/**
 * Agent Sprite Forge for DeepSeek Harness.
 *
 * The upstream project (https://github.com/0x0funky/agent-sprite-forge) ships
 * its capabilities as *agent skills*: five folders with a SKILL.md and a pile
 * of deterministic Python processors. DSH discovers filesystem skills under
 * fixed roots and cannot see a checkout that lives elsewhere, so this plugin
 * does three things:
 *
 *   1. REGISTERS the five skills at runtime on `ctx.skills` (the registry's
 *      `register()` API), with the absolute checkout path in the loaded content
 *      so the agent can run `<skill-dir>/scripts/*.py` exactly as upstream
 *      documents.
 *   2. RUNS those scripts through `asf_run`, with the Python interpreter this
 *      plugin resolves (config → DSH runtime Python → PATH) and a hardened set
 *      of environment variables (PYTHONUTF8, PYTHONDONTWRITEBYTECODE...).
 *   3. CONNECTS DSH to the Forge route layer. `asf_doctor` reports which media
 *      routes are usable; when the workspace has a local `http` package, the
 *      plugin serves a host-route shim (`asf/http/route_media.py`) so DSH's own
 *      image tool becomes a route instead of "no-route (codeart2d only)".
 *
 * @module dsh-plugin-asf-suite
 */

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Stable Loader identity. */
const name = "asf-suite";

/** Services used by name, so mount order does not matter. */
const inject = ["tools", "skills"];

/** Card order in the plugin inventory. */
const order = 30;

/** The five skills upstream ships, in the order its docs introduce them. */
const SKILL_ORDER = [
  "generate2dmedia",
  "generate2dsprite",
  "video2dsprite",
  "generate2dmap",
  "codeart2d",
];

/** Validated configuration. */
const Config = z.object({
  /** The agent-sprite-forge checkout. Empty: auto-resolve from the candidates. */
  forgeRoot: z.string().default(""),
  /**
   * Candidate folders tried under the workspace root (relative) and above it
   * (also relative). The first one with a `skills/` folder wins.
   */
  workspaceCandidates: z.array(z.string()).default([
    "agent-sprite-forge",
    "vendor/agent-sprite-forge",
    "../agent-sprite-forge",
  ]),
  /**
   * Which Python runs the Forge scripts. Empty: DSH's own runtime Python when
   * it exists, else `python` on PATH. The Forge docs require numpy and Pillow.
   */
  python: z
    .object({
      path: z.string().default(""),
      /** Extra environment for every script run (never printed in results). */
      env: z.dict(z.string()).default({}),
    })
    .default({}),
  /** Extra PATH entries prepended for every script run. */
  extraPaths: z.array(z.string()).default([]),
  /** Prefix for the registered skill names, e.g. "asf-" to avoid a clash. */
  skillPrefix: z.string().default(""),
  /** Register the five skills on ctx.skills (the core feature). */
  registerSkills: z.boolean().default(true),
  /**
   * Tools the route bridge may dispatch to, in order. `image_generate` comes
   * from the image-gen plugin; `image_gen` from hosts that ship their own image
   * tool. The first one mounted serves the Forge route layer.
   */
  mediaTools: z.array(z.string()).default(["image_generate", "image_gen"]),
  /** Serve the loopback bridge that connects the Forge route layer to DSH. */
  httpBridge: z.boolean().default(true),
  /** Bridge port; 0 picks a free one (the chosen port is exported to scripts). */
  httpBridgePort: z.number().default(0),
  /** Fall back to the agent's session workspace when it differs from cwd. */
  workspaceFallback: z.boolean().default(true),
  /** Default wall-clock ceiling for one script run. */
  defaultTimeoutMs: z.number().default(600_000),
  /** Hard ceiling a single call may ask for. */
  maxTimeoutMs: z.number().default(3_600_000),
  /** stdout/stderr kept in one tool result; the rest is spilled to a file. */
  maxOutputBytes: z.number().default(262_144),
  /** Test seam: publish the loopback bridge on globalThis for smoke tests. */
  __testHooks: z.boolean().default(false),
});

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** An error whose message is already user-facing. */
class AsfError extends Error {}

function asText(value) {
  return typeof value === "string" ? value : value === undefined ? "" : String(value);
}

/** The workspace a call runs in: the session's cwd, else the process cwd. */
function workspaceOf(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd();
}

/** Read `${forgeRoot}/skills/<name>/SKILL.md` frontmatter + body. */
async function readSkillFile(dir) {
  const file = join(dir, "SKILL.md");
  const raw = await readFile(file, "utf8");
  if (!raw.startsWith("---")) throw new AsfError(`${file} has no YAML frontmatter`);
  const end = raw.indexOf("\n---", 3);
  if (end === -1) throw new AsfError(`${file} has an unterminated frontmatter block`);
  const front = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const fields = {};
  // Flat `key: value` frontmatter (name, description, whenToUse — the Forge
  // skills use nothing else). Lines end with CR, LF or CRLF depending on how
  // the checkout was written; JS `.` stops at a line break, so a folded scalar
  // ends at its first line and a catalog line stays one line long.
  for (const line of front.split(/\r\n|\r|\n/)) {
    const match = /^([A-Za-z][\w-]*):[ \t]+(.+?)[ \t]*$/.exec(line);
    if (match === null) continue;
    fields[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return { fields, body };
}

/** True when `dir` looks like an agent-sprite-forge checkout. */
async function isForgeRoot(dir) {
  try {
    const info = await stat(join(dir, "skills"));
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the checkout once at mount: explicit config, then candidates under
 * the workspace root (and its parent), then the plugin's own parent folder
 * (a checkout beside the plugin), then the session cwd.
 *
 * The cwd at mount time is the harness process cwd, which is the best guess
 * before any agent session exists; a session opened elsewhere resolves lazily
 * in `resolveRoot()`.
 */
async function resolveMountRoot(config) {
  if (typeof config.forgeRoot === "string" && config.forgeRoot.length > 0) {
    const explicit = resolve(config.forgeRoot);
    if (!(await isForgeRoot(explicit))) {
      throw new AsfError(
        `forgeRoot "${config.forgeRoot}" does not contain a skills/ folder; point it at an agent-sprite-forge checkout`,
      );
    }
    return { root: explicit, source: "config" };
  }
  const bases = [process.cwd(), dirname(process.cwd()), process.env.DSH_WORKSPACE ?? ""].filter(
    (base) => typeof base === "string" && base.length > 0,
  );
  for (const base of bases) {
    for (const candidate of config.workspaceCandidates) {
      const dir = resolve(base, candidate);
      if (await isForgeRoot(dir)) return { root: dir, source: `candidate:${candidate}` };
    }
  }
  return undefined;
}

/** Lazy resolution for a workspace that differs from the mount cwd. */
async function resolveWorkspaceRoot(config, workspace) {
  if (typeof config.forgeRoot === "string" && config.forgeRoot.length > 0) {
    return resolve(config.forgeRoot);
  }
  for (const candidate of config.workspaceCandidates) {
    const dir = resolve(workspace, candidate);
    if (await isForgeRoot(dir)) return dir;
    const up = resolve(workspace, "..", candidate);
    if (await isForgeRoot(up)) return up;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Python                                                                     */
/* -------------------------------------------------------------------------- */

/** True when `file` is an executable-looking path that exists. */
async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * The interpreter used for every script run:
 *   1. `python.path` when set (a file or a command name),
 *   2. the DSH runtime Python (`DSH_RUNTIME_ROOT` or the standard location),
 *   3. `python3` / `python` / `py` from PATH.
 * The choice is resolved once and reported by `asf_forge_info`.
 */
async function resolvePython(config) {
  const configured = asText(config.python.path).trim();
  if (configured.length > 0) {
    if (isAbsolute(configured) || configured.includes("\\") || configured.includes("/")) {
      if (!(await isFile(configured))) throw new AsfError(`python.path "${configured}" does not exist`);
      return { command: configured, args: [], source: "config" };
    }
    return { command: configured, args: [], source: "config" };
  }
  const roots = [
    process.env.DSH_RUNTIME_ROOT,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies") : "",
  ].filter((root) => typeof root === "string" && root.length > 0);
  for (const root of roots) {
    const exe = process.platform === "win32" ? join(root, "python", "python.exe") : join(root, "python", "bin", "python3");
    if (await isFile(exe)) return { command: exe, args: [], source: "dsh-runtime" };
  }
  // PATH is resolved by the OS; the first run reveals a missing interpreter.
  return { command: process.platform === "win32" ? "python" : "python3", args: [], source: "path" };
}

/* -------------------------------------------------------------------------- */
/* subprocess runner                                                          */
/* -------------------------------------------------------------------------- */

/** Bound stdout/stderr so one runaway script cannot exhaust memory. */
function collector(limit) {
  const chunks = [];
  let size = 0;
  let dropped = 0;
  return {
    push(chunk) {
      size += chunk.length;
      if (size > limit) {
        dropped += chunk.length;
        return;
      }
      chunks.push(chunk);
    },
    finish() {
      return { text: Buffer.concat(chunks).toString("utf8"), droppedBytes: dropped };
    },
  };
}

/**
 * Spawn one process and resolve with its exit status, captured output and
 * timing. The caller's abort signal kills the tree (Windows: taskkill /T).
 */
function runProcess({ command, args, cwd, env, timeoutMs, signal, outputLimit }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      rejectPromise(new AsfError(`could not start ${command}: ${error?.message ?? error}`));
      return;
    }
    const out = collector(outputLimit);
    const err = collector(Math.min(65_536, outputLimit));
    let timedOut = false;
    let aborted = false;

    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));

    const killTree = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killTree();
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    const settle = (status, spawnError) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      const durationMs = Date.now() - startedAt;
      const stdout = out.finish();
      const stderr = err.finish();
      if (spawnError !== undefined) {
        rejectPromise(
          new AsfError(
            `could not run ${command}: ${spawnError.code === "ENOENT" ? "interpreter not found (set python.path in the plugin config)" : spawnError.message}`,
          ),
        );
        return;
      }
      resolvePromise({
        status,
        durationMs,
        timedOut,
        aborted,
        stdout: stdout.text,
        stderr: stderr.text,
        droppedBytes: stdout.droppedBytes + stderr.droppedBytes,
      });
    };

    child.on("error", (error) => settle(-1, error));
    child.on("close", (code, sig) => settle(code ?? (sig === "SIGKILL" ? 124 : -1)));
  });
}

/* -------------------------------------------------------------------------- */
/* JSON extraction from Forge stdout                                          */
/* -------------------------------------------------------------------------- */

/**
 * Forge tools print "one JSON line" on success and "error: ..." lines on
 * failure. Some print a labeled human report first (forge_doctor). Find the
 * last line that parses as a JSON object; returns undefined when none does.
 * Lines may end with CR, LF or CRLF depending on the checkout.
 */
function lastJsonLine(text) {
  const lines = String(text ?? "").split(/\r\n|\r|\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* workspace-write guard                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Forge tools write new `--output-dir` folders. DSH's file policy does not
 * sandbox subprocesses, so the plugin keeps Forge inside the workspace it was
 * asked to work in: every `--output-dir` / `--out-dir` argument must resolve
 * under the workspace (or its Forge root) unless the config relaxes it.
 */
function outputDirViolations(argv, workspace, root) {
  const violations = [];
  const bases = [resolve(workspace), resolve(root)];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    let value;
    if (arg === "--output-dir" || arg === "--out-dir") value = argv[index + 1];
    else if (arg.startsWith("--output-dir=") || arg.startsWith("--out-dir=")) value = arg.split("=").slice(1).join("=");
    if (value === undefined || value.length === 0) continue;
    const target = isAbsolute(value) ? resolve(value) : resolve(workspace, value);
    const inside = bases.some((base) => target === base || target.startsWith(base + (process.platform === "win32" ? "\\" : "/")));
    if (!inside) violations.push({ flag: arg, value, resolved: target });
  }
  return violations;
}

/* -------------------------------------------------------------------------- */
/* plugin                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param ctx - host context with `tools` and `skills`.
 * @param config - validated plugin configuration.
 */
function apply(ctx, config) {
  if (!Number.isFinite(config.defaultTimeoutMs) || config.defaultTimeoutMs <= 0) {
    throw new AsfError("asf-suite requires a positive defaultTimeoutMs");
  }

  let rootInfo;
  let python;
  let httpModule;
  const registered = [];

  /** The checkout for this call (mount-time root, else resolved lazily). */
  const rootFor = async (workspace) => {
    if (rootInfo !== undefined) return rootInfo.root;
    const lazy = await resolveWorkspaceRoot(config, workspace);
    if (lazy === undefined) {
      throw new AsfError(
        "agent-sprite-forge checkout not found: set forgeRoot in the asf-suite plugin config, or place the checkout in the workspace (candidates: " +
          config.workspaceCandidates.join(", ") +
          ")",
      );
    }
    return lazy;
  };

  /* ----------------------------- skills ----------------------------- */

  const skillDirs = async (root) => {
    const skillsRoot = join(root, "skills");
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
      .map((entry) => entry.name)
      .sort((a, b) => {
        const ai = SKILL_ORDER.indexOf(a);
        const bi = SKILL_ORDER.indexOf(b);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.localeCompare(b);
      });
  };

  const registerSkills = async (root) => {
    if (config.registerSkills !== true || ctx.skills === undefined) return;
    for (const dirName of await skillDirs(root)) {
      const dir = join(root, "skills", dirName);
      const { fields, body } = await readSkillFile(dir);
      const publicName = `${config.skillPrefix}${fields.name ?? dirName}`;
      // The upstream skills address their scripts as "<skill-dir>/scripts/...";
      // publish the real path up front so no file read is wasted on guessing.
      const preamble = [
        `> **Host: DeepSeek Harness.** This skill is served from the agent-sprite-forge checkout at \`${root}\`.`,
        `> Its skill directory (\`<skill-dir>\` in every command below) is \`${dir}\`.`,
        "> Run the scripts with the `asf_run` tool: `asf_run` takes `skill`, `script`, `args`, and optional",
        "> `output_dir`, `stdin`, and `timeout_seconds`; it starts in the workspace like a project-root shell,",
        "> and it exports the bridge coordinates below, so `route_media.py` also sees the host route.",
        "> **Image generation works here without an API key**: when the project has `http/route_media.py`",
        "> (installed by this plugin) and the agent calls `route_media.py` through `asf_run`, the route layer",
        "> reports `host:dsh` and hands the request to DSH's own image tool (the `image_generate` tool).",
        "> That happens because `asf_run` exports `ASF_DSH_BRIDGE`, `ASF_DSH_TOKEN` and `ASF_DSH_WORKSPACE`",
        "> (the plugin's asf-suite tools; see `asf_doctor` for the resolved routes).",
        "> Use `asf_doctor` once per session for the capability check, and `asf_forge_info` for paths and versions.",
        "> Follow the Host notes for Claude-type hosts unless `asf_forge_info` says otherwise.",
        "",
      ]
        .filter((line, index) => line.length > 0 || index === 0)
        .join("\n");
      registered.push(
        ctx.skills.register({
          name: publicName,
          description: fields.description ?? "",
          ...(fields.whenToUse === undefined ? {} : { whenToUse: fields.whenToUse }),
          path: dir,
          // Upstream skills address their scripts as "<skill-dir>/scripts/...";
          // resourceBase is what the `skill` tool prints to the model ("Base
          // directory for this skill: ..."), so it must be the real folder.
          resourceBase: { kind: "directory", path: dir },
          source: `agent-sprite-forge@${root}`,
          content: `${preamble}${body}`.trim(),
        }),
      );
    }
  };

  /* ----------------------------- doctor ----------------------------- */

  /** What forge_doctor calls a host tool; DSH names are mapped onto these. */
  const DOCTOR_TOOL_NAMES = new Set(["image_gen", "image_edit", "image_to_video"]);

  /** The host tools forge_doctor should be told about (canonical names only). */
  const mediaToolsOf = () => {
    const listed = new Set();
    // The bridge can serve image generation on its own, so image_gen is always
    // declared once the bridge is up.
    if (config.httpBridge === true) listed.add("image_gen");
    const available = [];
    try {
      const all = ctx.tools?.list?.() ?? [];
      for (const tool of all) available.push(asText(tool?.name ?? tool));
    } catch {
      // listing is optional
    }
    for (const availableName of available) {
      const normalized = availableName.replace(/[\s-]+/g, "_").toLowerCase();
      if (DOCTOR_TOOL_NAMES.has(normalized)) listed.add(normalized);
      // The image-gen plugin's image_generate is the same capability as a host
      // image tool: present it to the Forge ladder as image_gen.
      if (availableName === "image_generate") listed.add("image_gen");
      if (availableName === "image_edit") listed.add("image_edit");
      if (availableName === "video_generate" || availableName === "image_to_video") listed.add("image_to_video");
    }
    return [...listed].sort();
  };

  const runDoctor = async ({ workspace, projectDir, noExec = true }) => {
    const root = await rootFor(workspace);
    const script = join(root, "skills", "generate2dmedia", "scripts", "forge_doctor.py");
    const outDir = projectDir ?? workspace;
    const saveFile = join(outDir, ".forge", "doctor.json");
    await mkdir(dirname(saveFile), { recursive: true });
    const args = [script, "--project-dir", outDir, "--host-tools", [...new Set(mediaToolsOf())].join(","), "--save", saveFile];
    if (noExec) args.push("--no-exec");
    const run = await execPython(root, args, { workspace, timeoutMs: 180_000, signal: undefined });
    // The report file is authoritative: stdout carries a human table, not JSON.
    let json;
    try {
      json = JSON.parse(await readFile(saveFile, "utf8"));
    } catch {
      json = lastJsonLine(run.stdout);
    }
    return { root, run, saveFile: existsSync(saveFile) ? saveFile : undefined, json };
  };

  /* ------------------------------ http ------------------------------ */

  /**
   * A loopback HTTP endpoint for the ASF route layer. The shim that ASF-side
   * code calls (a `host` route) lives in the workspace and POSTs here; this
   * server turns the request into one of the media tools DSH already has
   * (`image_generate`, `image_gen` from the image-gen plugin, `video_generate`)
   * and answers with a JSON status line. It is the only way the Forge route
   * layer can use a host tool without knowing how DSH stores tools.
   *
   * No media tool is re-implemented here: the handler dispatches through
   * `ctx.tools`, so whatever produces images in DSH stays the producer.
   */
  const token = randomBytes(24).toString("hex");
  const httpState = { server: undefined, port: 0, error: undefined };

  const pickMediaTool = () => {
    for (const candidate of config.mediaTools) {
      try {
        const found = ctx.tools.get?.(candidate);
        if (found !== undefined) return candidate;
      } catch {
        // not registered
      }
    }
    return undefined;
  };

  /**
   * Dispatch one media tool. The bridge authenticates with a random token and
   * the request is formed by the shim, so a direct execute with a minimal
   * context is enough here; handlers that read `exec.agent` fall back to the
   * process cwd, which is what they do for any call without a session.
   */
  const invokeTool = async (toolName, args) => {
    const tool = ctx.tools.get?.(toolName);
    if (tool === undefined) throw new Error(`media tool "${toolName}" is not mounted`);
    return tool.execute(args, { agent: undefined });
  };

  /** One bridge request; every branch answers and returns (no dangling async). */
  const routeBridgeRequest = async (req, res) => {
    const answer = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(payload));
    };
    if (req.headers["x-asf-bridge-token"] !== token) return answer(403, { error: "forbidden" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/bridge") {
      return answer(200, { url: `http://127.0.0.1:${httpState.port}`, token });
    }
    if (req.method === "GET" && url.pathname === "/health") {
      const tool = pickMediaTool();
      return answer(200, { ok: true, tool: tool ?? null, pid: process.pid, ready: tool !== undefined });
    }
    if (req.method !== "POST" || url.pathname !== "/image") return answer(404, { error: "not found" });
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 32_000_000) return answer(413, { error: "payload too large" });
    }
    let request;
    try {
      request = JSON.parse(body);
    } catch {
      return answer(400, { error: "body must be JSON" });
    }
    const toolName = asText(request.tool) || pickMediaTool();
    if (toolName === undefined || toolName.length === 0) {
      return answer(503, { status: "error", error: "no media tool is mounted (install the image-gen plugin for image_generate/image_gen)" });
    }
    try {
      const prompt = asText(request.prompt);
      if (prompt.trim().length === 0) return answer(400, { status: "error", error: "prompt is required" });
      const references = Array.isArray(request.references) ? request.references : [];
      const size = asText(request.size);
      // reference_images is the field the image-gen tool exposes; a pixel size
      // (WIDTHxHEIGHT) also fits its schema.
      const args = {
        prompt,
        ...(size.length > 0 ? { size } : {}),
        ...(references.length > 0 ? { reference_images: references } : {}),
      };
      const result = await invokeTool(toolName, args);
      const images = Array.isArray(result?.images) ? result.images : [];
      if (images.length === 0) return answer(502, { status: "error", tool: toolName, error: "media tool returned no artifact" });
      return answer(200, {
        status: "ok",
        tool: toolName,
        artifacts: images.map((image) => image.path),
        artifact: images[0].path,
        ...(result?.model === undefined ? {} : { model: result.model }),
        ...(result?.revised_prompt === undefined ? {} : { revised_prompt: result.revised_prompt }),
      });
    } catch (error) {
      return answer(500, { status: "error", tool: toolName, error: asText(error?.message ?? error) });
    }
  };

  const startHttp = async () => {
    if (config.httpBridge !== true || httpState.server !== undefined) return httpState;
    const server = createServer(async (req, res) => {
      try {
        await routeBridgeRequest(req, res);
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", error: asText(error?.message ?? error) }));
        }
      }
    });
    try {
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(config.httpBridgePort, "127.0.0.1", resolveListen);
      });
      httpState.server = server;
      httpState.port = server.address().port;
    } catch (error) {
      httpState.error = asText(error?.message ?? error);
      ctx.logger?.warn?.(`asf-suite: http bridge unavailable (${httpState.error})`);
    }
    return httpState;
  };

  /**
   * Hand-forge scripts their bridge coordinates. The bridge is started at mount
   * (and again on first use) so a route-layer `resolve` — which runs before any
   * media call — can already see a host route.
   */
  const bridgeEnv = (workspace) => {
    const server = httpState.server;
    if (server === undefined) return {};
    return {
      ASF_DSH_BRIDGE: `http://127.0.0.1:${httpState.port}`,
      ASF_DSH_TOKEN: token,
      ...(typeof workspace === "string" ? { ASF_DSH_WORKSPACE: workspace } : {}),
    };
  };

  /** Serve the loopback bridge; one server per harness process. */
  const ensureBridge = async () => {
    if (config.httpBridge !== true) return undefined;
    if (httpState.server !== undefined) return httpState;
    const started = await startHttp();
    if (started.server === undefined && started.error !== undefined) {
      ctx.logger?.warn?.(`asf-suite: http bridge unavailable (${started.error})`);
    }
    return started.server === undefined ? undefined : started;
  };

  /** Test seam: lets the smoke test point the bridge at a stubbed media tool. */
  const __bridge = {
    state: httpState,
    ensure: async () => {
      const started = await ensureBridge();
      return started === undefined ? undefined : { url: `http://127.0.0.1:${started.port}`, token };
    },
  };
  if (config.__testHooks === true) globalThis.__asfSuiteBridge = __bridge;

  /* --------------------------- run a script --------------------------- */

  const envFor = (root, workspace) => {
    const env = { ...process.env, ...config.python.env, ...bridgeEnv(workspace) };
    env.PYTHONUTF8 = "1";
    env.PYTHONDONTWRITEBYTECODE = "1";
    env.ASF_ROOT = root;
    env.ASF_WORKSPACE = workspace;
    const paths = [...config.extraPaths, join(root, "skills")];
    if (typeof env.PYTHONPATH === "string" && env.PYTHONPATH.length > 0) paths.push(env.PYTHONPATH);
    env.PYTHONPATH = paths.join(process.platform === "win32" ? ";" : ":");
    return env;
  };

  async function execPython(root, args, { workspace, timeoutMs, signal, stdin }) {
    python ??= await resolvePython(config);
    const result = await runProcess({
      command: python.command,
      args: [...python.args, ...args],
      cwd: workspace,
      env: envFor(root, workspace),
      timeoutMs,
      signal,
      outputLimit: config.maxOutputBytes,
    });
    return result;
  }

  const validSkillDir = async (root, skill) => {
    const dir = join(root, "skills", skill);
    if (!(await isForgeRoot(join(dir, "..", "..")))) throw new AsfError(`invalid skill directory ${dir}`);
    return dir;
  };

  const scriptPathFor = async (root, skill, script) => {
    const dir = await validSkillDir(root, skill);
    const scripts = join(dir, "scripts");
    let names;
    try {
      names = await readdir(scripts);
    } catch {
      throw new AsfError(`skill "${skill}" has no scripts/ folder`);
    }
    const wanted = script.endsWith(".py") ? script : `${script}.py`;
    if (!names.includes(wanted)) {
      throw new AsfError(`skill "${skill}" has no script "${wanted}"; available: ${names.filter((n) => n.endsWith(".py")).join(", ")}`);
    }
    return join(scripts, wanted);
  };

  /* ------------------------------ tools ------------------------------ */

  ctx.tools.register(
    defineTool({
      name: "asf_forge_info",
      description:
        "Report the Agent Sprite Forge integration: checkout path, the five skill directories, the Python interpreter that runs the scripts, its version, dependency readiness (numpy / Pillow / scipy), and whether the media route layer is connected to DSH. Call it first in a session that uses the generate2d*/video2dsprite/codeart2d skills.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            root: { type: "string", required: true },
            skills: { type: "array", required: true, items: { type: "string" } },
            python: { type: "string", required: true },
            pythonSource: { type: "string", required: true },
            pythonVersion: { type: "string" },
            dependencies: { type: "object", additionalProperties: true },
            httpBridge: { type: "string", required: true },
            mediaTool: { type: "string" },
            skillPrefix: { type: "string", required: true },
            notes: { type: "array", items: { type: "string" } },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: [
              `Agent Sprite Forge at ${value.root}`,
              `skills: ${value.skills.join(", ")}`,
              `python: ${value.python} (${value.pythonSource}${value.pythonVersion === undefined ? "" : `, ${value.pythonVersion}`})`,
              `dependencies: ${Object.entries(value.dependencies ?? {}).map(([k, v]) => `${k}=${v}`).join(" ")}`,
              `media bridge: ${value.httpBridge}${value.mediaTool === undefined ? "" : ` (tool: ${value.mediaTool})`}`,
              ...(value.notes ?? []).map((note) => `note: ${note}`),
            ].join("\n"),
          },
        ],
      },
      async execute(_args, exec) {
        const workspace = workspaceOf(exec);
        const root = await rootFor(workspace);
        python ??= await resolvePython(config);
        const probe = await runProcess({
          command: python.command,
          args: [...python.args, "-c", "import sys, json; mods={};" +
            "exec('for m in (\"numpy\",\"PIL\",\"scipy\"):\\n try:\\n  mod=__import__(m); mods[m]=getattr(mod,\"__version__\",\"ok\")\\n except Exception:\\n  mods[m]=\"missing\"');" +
            "print(json.dumps({'version':sys.version.split()[0],'mods':mods}))"],
          cwd: workspace,
          env: envFor(root, workspace),
          timeoutMs: 60_000,
          signal: exec.signal,
          outputLimit: 8_192,
        });
        const probeJson = lastJsonLine(probe.stdout);
        const notes = [];
        if (probe.status !== 0) notes.push(`the Python probe failed: ${probe.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? ""}`);
        if (probeJson?.mods?.numpy === "missing" || probeJson?.mods?.PIL === "missing") {
          notes.push("numpy and Pillow are required by every Forge script; install them into the configured python (python -m pip install numpy pillow)");
        }
        const bridge = await ensureBridge();
        const mediaTool = pickMediaTool();
        if (bridge !== undefined && mediaTool === undefined) {
          notes.push(`no media tool is mounted for the route bridge (looked for ${config.mediaTools.join(", ")}); install the image-gen plugin to give Forge an image route`);
        }
        return {
          root,
          skills: await skillDirs(root),
          python: python.command,
          pythonSource: python.source,
          ...(probeJson?.version === undefined ? {} : { pythonVersion: probeJson.version }),
          dependencies: probeJson?.mods ?? {},
          httpBridge: bridge === undefined ? "off" : "on",
          ...(mediaTool === undefined ? {} : { mediaTool }),
          skillPrefix: config.skillPrefix,
          ...(notes.length === 0 ? {} : { notes }),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "asf_run",
      description:
        "Run one Agent Sprite Forge script (from the generate2dsprite, video2dsprite, generate2dmap, generate2dmedia or codeart2d skill) in the workspace, with the provisioned Python and the Forge environment. Use it for every `python \"<skill-dir>/scripts/<tool>.py\" ...` command the skill docs show: pass skill (folder name), script (file name), and args (the rest, without the script path). It returns the exit code, stdout, stderr and duration; Forge success lines are JSON and are parsed into json. Working directory is the workspace (the project root the skill expects).",
      parameters: {
        skill: {
          type: "string",
          required: true,
          description: 'Skill folder name: "generate2dsprite", "video2dsprite", "generate2dmap", "generate2dmedia" or "codeart2d".',
        },
        script: {
          type: "string",
          required: true,
          description: 'Script file name inside that skill, e.g. "plan_guide.py", "master_still.py", "route_media.py", "forge_doctor.py".',
        },
        args: {
          type: "array",
          items: { type: "string" },
          description:
            'Arguments exactly as the docs show them (one string per argument), e.g. ["--frames","6","--cycle","run","--output-dir","out/guide"].',
        },
        output_dir: {
          type: "string",
          description:
            "Convenience: shorthand for adding --output-dir (or --out-dir for generate2dmedia). Forge tools refuse an existing folder, so pick a new one.",
        },
        stdin: {
          type: "string",
          description: "Text piped to the script's stdin (rarely needed).",
        },
        timeout_seconds: {
          type: "integer",
          description: "Wall-clock ceiling; defaults to the plugin's defaultTimeoutMs. Long jobs (video, sheets) may need 900 or more.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "integer", required: true, description: "Process exit code; 0 = success, 1 = Forge error, 2 = usage error, 3 = no-route (generate2dmedia), 124 = killed by timeout." },
            command: { type: "string", required: true },
            stdout: { type: "string", required: true },
            stderr: { type: "string", required: true },
            json: { type: "json", description: "Parsed last JSON line of stdout, when the tool printed one." },
            duration_ms: { type: "integer", required: true },
            timed_out: { type: "boolean", required: true },
            truncated: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: [
              `${value.command} -> exit ${value.status}${value.timed_out ? " (timed out)" : ""} in ${value.duration_ms} ms`,
              ...(value.stdout.trim().length > 0 ? ["stdout:", value.stdout.trim()] : []),
              ...(value.stderr.trim().length > 0 ? ["stderr:", value.stderr.trim()] : []),
              ...(value.truncated ? ["(output truncated)"] : []),
            ].join("\n"),
          },
        ],
      },
      async execute(args, exec) {
        const workspace = workspaceOf(exec);
        const root = await rootFor(workspace);
        const scriptPath = await scriptPathFor(root, args.skill, args.script);
        const argv = [...(args.args ?? [])];
        if (typeof args.output_dir === "string" && args.output_dir.trim().length > 0) {
          const flag = args.skill === "generate2dmedia" ? "--out-dir" : "--output-dir";
          if (!argv.includes(flag) && !argv.some((value) => value.startsWith(`${flag}=`))) {
            argv.push(flag, args.output_dir.trim());
          }
        }
        const violations = outputDirViolations(argv, workspace, root);
        if (violations.length > 0) {
          throw new AsfError(
            `asf_run keeps Forge outputs inside the workspace: ${violations
              .map((v) => `${v.flag} ${v.value} -> ${v.resolved}`)
              .join("; ")}. Pass a workspace-relative --output-dir instead.`,
          );
        }
        const timeoutMs = Math.min(
          config.maxTimeoutMs,
          typeof args.timeout_seconds === "number" ? Math.max(1, args.timeout_seconds) * 1000 : config.defaultTimeoutMs,
        );
        const run = await runProcess({
          command: (python ??= await resolvePython(config)).command,
          args: [...(python.args ?? []), scriptPath, ...argv],
          cwd: workspace,
          env: envFor(root, workspace),
          timeoutMs,
          signal: exec.signal,
          outputLimit: config.maxOutputBytes,
        });
        // Spill the full output when the result had to be truncated.
        let stdout = run.stdout;
        let stderr = run.stderr;
        let truncated = run.droppedBytes > 0;
        if (truncated) {
          const spill = join(tmpdir(), `asf-run-${Date.now().toString(36)}.log`);
          await writeFile(spill, `${run.stdout}\n--- stderr ---\n${run.stderr}\n`, "utf8");
          stderr = `${stderr}\n[full log: ${spill}]`.trim();
        }
        const parsed = lastJsonLine(run.stdout);
        return {
          status: run.timedOut ? 124 : run.status,
          command: `python ${args.skill}/scripts/${args.script.endsWith(".py") ? args.script : `${args.script}.py`}`,
          stdout,
          stderr,
          ...(parsed === undefined ? {} : { json: parsed }),
          duration_ms: run.durationMs,
          timed_out: run.timedOut,
          truncated,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "asf_doctor",
      description:
        "Run the Agent Sprite Forge capability check (forge_doctor.py) with this host's tool list, save the report to <project>/.forge/doctor.json, and summarize it. Use once per session before generating art: it says which media routes exist on this machine (DSH image tool, API keys, local CLIs), whether video clips are processable (ffmpeg), and what is missing.",
      parameters: {
        project_dir: {
          type: "string",
          description: "Project root the report is written under (`.forge/doctor.json`). Defaults to the workspace root.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "integer", required: true },
            report: { type: "string", required: true, description: "Path of the saved doctor.json" },
            overall: { type: "string" },
            counts: { type: "object", additionalProperties: true },
            routes: { type: "object", additionalProperties: true },
            checks: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  id: { type: "string", required: true },
                  status: { type: "string", required: true },
                  detail: { type: "string" },
                  remedy: { type: "string" },
                },
              },
            },
            text: { type: "string", required: true, description: "The human-readable report" },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        const workspace = workspaceOf(exec);
        const projectDir =
          typeof args.project_dir === "string" && args.project_dir.trim().length > 0
            ? resolve(workspace, args.project_dir.trim())
            : workspace;
        const { run, saveFile, json } = await runDoctor({ workspace, projectDir });
        const checks = json?.checks ?? [];
        const counts = checks.reduce((acc, check) => {
          acc[check.status] = (acc[check.status] ?? 0) + 1;
          return acc;
        }, {});
        return {
          status: run.status,
          report: saveFile ?? join(projectDir, ".forge", "doctor.json"),
          ...(json?.overall === undefined ? {} : { overall: json.overall }),
          counts,
          ...(json?.routes === undefined ? {} : { routes: json.routes }),
          checks: checks.map((check) => ({
            id: String(check.id ?? ""),
            status: String(check.status ?? ""),
            ...(check.detail === undefined ? {} : { detail: String(check.detail) }),
            ...(check.remedy === undefined ? {} : { remedy: String(check.remedy) }),
          })),
          text: [run.stdout.trim(), run.stderr.trim()].filter((part) => part.length > 0).join("\n"),
        };
      },
    }),
  );

  /* ---------------------- mount-time registration ---------------------- */

  ctx.effect(async () => {
    // The bridge comes up first: the Forge route layer asks it, during
    // `resolve`, whether a host route exists at all.
    await ensureBridge();
    const resolved = await resolveMountRoot(config);
    if (resolved === undefined) {
      ctx.logger?.warn?.(
        "asf-suite: no agent-sprite-forge checkout found (set forgeRoot in the plugin config); the tools stay registered and resolve per workspace",
      );
      return () => {
        const server = httpState.server;
        httpState.server = undefined;
        server?.close?.();
      };
    }
    rootInfo = resolved;
    await registerSkills(resolved.root);
    ctx.logger?.info?.(`asf-suite: serving ${resolved.root} (${resolved.source}), ${registered.length} skill(s)`);
    return () => {
      for (const dispose of registered.splice(0)) {
        try {
          dispose();
        } catch {
          // a disposed scope already removed it
        }
      }
      const server = httpState.server;
      httpState.server = undefined;
      server?.close?.();
    };
  }, "asf-suite: register Forge skills");
}

export { Config, apply, inject, name, order, resolvePython, lastJsonLine, outputDirViolations };
