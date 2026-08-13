import { defineTool } from "@barry/tools";
import { z } from "zod";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import {
  runBlender,
  runBlenderScript,
  encodeFrames,
  isBlenderInstalled,
  isFfmpegInstalled,
  listFrames,
  BlenderError,
} from "./exec.js";
import { buildRenderScript, buildInspectScript, extractJson } from "./scene.js";

const NS = "blender";
const RENDER_ROOT = join(homedir(), ".barry", "blender");

const ENGINES = ["BLENDER_EEVEE", "CYCLES", "BLENDER_WORKBENCH"] as const;

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "animation";
}

function expandPath(p: string): string {
  const expanded = p.replace(/^~/, homedir());
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export const blenderStatus = defineTool({
  namespace: NS,
  access: "read",
  name: "blender_status",
  description:
    "Check that Blender and ffmpeg are installed and report Blender's version and available render engines.",
  schema: {},
  handler: async () => {
    const [blender, ffmpeg] = await Promise.all([isBlenderInstalled(), isFfmpegInstalled()]);

    if (!blender) {
      return {
        blenderInstalled: false,
        ffmpegInstalled: ffmpeg,
        installCommand: "brew install --cask blender",
      };
    }

    const versionOut = await runBlender(["--version"], 30_000).catch(() => "");
    const version = versionOut.split("\n")[0]?.trim() || "unknown";

    const engineOut = await runBlender(["-E", "help"], 30_000).catch(() => "");
    const engines = engineOut
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[A-Z_]+$/.test(l));

    return {
      blenderInstalled: true,
      version,
      engines,
      ffmpegInstalled: ffmpeg,
      ffmpegHint: ffmpeg ? undefined : "brew install ffmpeg — required to encode video",
      renderRoot: RENDER_ROOT,
    };
  },
});

export const blenderRender = defineTool({
  namespace: NS,
  access: "write",
  name: "blender_render",
  description:
    "Render an animation headlessly from bpy Python and encode it to mp4. Write only scene-building code (geometry, materials, keyframes) — the camera, lighting, frame range, output settings and video encoding are handled for you. Returns the mp4 path; pass it to the media bag's view_video to watch it.",
  schema: {
    name: z.string().describe("Short name for this animation; used as the output directory name"),
    sceneCode: z
      .string()
      .describe(
        "Python (bpy) that builds the scene and inserts keyframes. `bpy`, `math`, `mathutils` and a `look_at(obj, target)` helper are in scope. The scene starts empty. Do not set render output paths or call bpy.ops.render.",
      ),
    frameStart: z.number().int().optional().describe("First frame (default: 1)"),
    frameEnd: z.number().int().optional().describe("Last frame (default: 48)"),
    fps: z.number().int().optional().describe("Frames per second (default: 24)"),
    resolutionX: z.number().int().optional().describe("Width in pixels (default: 960)"),
    resolutionY: z.number().int().optional().describe("Height in pixels (default: 540)"),
    engine: z
      .enum(ENGINES)
      .optional()
      .describe(
        "Render engine. BLENDER_EEVEE (default) is fast and rasterized; CYCLES is path-traced and slower but handles reflections/refraction properly; BLENDER_WORKBENCH is preview-quality.",
      ),
    samples: z.number().int().optional().describe("Samples per frame (default: 32)"),
    transparent: z
      .boolean()
      .optional()
      .describe(
        "Render with a transparent background for compositing (default: false). The returned mp4 cannot carry alpha, so the RGBA PNG sequence is kept and its path returned as framesDir — composite from those.",
      ),
    cyclesDevice: z
      .enum(["CPU", "METAL"])
      .optional()
      .describe("Cycles compute device; METAL uses the Apple GPU (default: METAL when engine is CYCLES)"),
    keepFrames: z
      .boolean()
      .optional()
      .describe("Keep the intermediate PNG sequence alongside the mp4 (default: false)"),
    timeoutMinutes: z
      .number()
      .int()
      .optional()
      .describe(
        "Abort the render after this many minutes (default: 20). Raise it for long Cycles renders — the first Cycles run on a machine spends minutes compiling GPU kernels before any frame appears.",
      ),
  },
  handler: async ({
    name,
    sceneCode,
    frameStart,
    frameEnd,
    fps,
    resolutionX,
    resolutionY,
    engine,
    samples,
    transparent,
    cyclesDevice,
    keepFrames,
    timeoutMinutes,
  }) => {
    const slug = slugify(name);
    const baseDir = join(RENDER_ROOT, slug);
    const framesDir = join(baseDir, "frames");
    // Alpha does not survive h264/yuv420p (it flattens to black), so a
    // transparent render keeps its RGBA PNG sequence — that is the artifact
    // that actually carries the matte. The mp4 is still produced as a preview.
    const wantsAlpha = transparent ?? false;
    const videoPath = join(baseDir, `${slug}.mp4`);

    // Clear both the frames and the previous video up front. Stale frames would
    // be spliced into the new render; a stale mp4 is worse — if this run fails,
    // the old file still sits at the advertised path and plays like a fresh
    // result.
    if (existsSync(framesDir)) rmSync(framesDir, { recursive: true, force: true });
    if (existsSync(videoPath)) rmSync(videoPath, { force: true });
    mkdirSync(framesDir, { recursive: true });

    const settings = {
      outputDir: framesDir,
      frameStart: frameStart ?? 1,
      frameEnd: frameEnd ?? 48,
      fps: fps ?? 24,
      resolutionX: resolutionX ?? 960,
      resolutionY: resolutionY ?? 540,
      engine: engine ?? ("BLENDER_EEVEE" as const),
      samples: samples ?? 32,
      transparent: transparent ?? false,
    };

    if (settings.frameEnd < settings.frameStart) {
      throw new Error(
        `frameEnd (${settings.frameEnd}) must be >= frameStart (${settings.frameStart})`,
      );
    }

    const script = buildRenderScript(sceneCode, settings);

    // `-a` must be a real argv entry and must follow -E; anything after `--`
    // belongs to the script, which is why the cycles device goes last.
    const extraArgs = ["-E", settings.engine, "-a"];
    if (settings.engine === "CYCLES") {
      extraArgs.push("--", "--cycles-device", cyclesDevice ?? "METAL");
    }

    const started = Date.now();
    const stdout = await runBlenderScript(script, {
      extraArgs,
      timeoutMs: timeoutMinutes ? timeoutMinutes * 60_000 : undefined,
    });
    const renderMs = Date.now() - started;

    const frames = listFrames(framesDir);
    if (frames.length === 0) {
      throw new Error(
        `Blender completed but produced no frames. Check that the scene code creates visible geometry. Blender output: ${stdout.split("\n").slice(-5).join(" | ")}`,
      );
    }

    await encodeFrames(frames, videoPath, { fps: settings.fps, crf: 18 });

    // A transparent render's frames are the deliverable, so never discard them.
    const retainFrames = (keepFrames ?? false) || wantsAlpha;
    if (!retainFrames) rmSync(framesDir, { recursive: true, force: true });

    return {
      videoPath,
      frames: frames.length,
      durationSeconds: Number((frames.length / settings.fps).toFixed(2)),
      engine: settings.engine,
      resolution: `${settings.resolutionX}x${settings.resolutionY}`,
      renderSeconds: Number((renderMs / 1000).toFixed(1)),
      framesDir: retainFrames ? framesDir : undefined,
      alphaNote: wantsAlpha
        ? `The mp4 has no alpha (h264 flattens it to black). Composite from the RGBA PNGs in ${framesDir}.`
        : undefined,
      nextStep: `Show it with the media bag: view_video ${videoPath}`,
    };
  },
});

export const blenderRunScript = defineTool({
  namespace: NS,
  access: "write",
  name: "blender_run_script",
  description:
    "Run arbitrary bpy Python in headless Blender and return its stdout. Use for inspection, experiments, or .blend file manipulation — for anything that renders frames, use blender_render instead.",
  schema: {
    code: z.string().describe("Python source executed inside Blender. `bpy` is imported."),
    blendFile: z
      .string()
      .optional()
      .describe("Optional .blend file to open before running the code"),
    timeoutSeconds: z.number().int().optional().describe("Timeout in seconds (default: 300)"),
  },
  handler: async ({ code, blendFile, timeoutSeconds }) => {
    const file = blendFile ? expandPath(blendFile) : undefined;
    if (file && !existsSync(file)) {
      throw new Error(`Blend file not found: ${file}`);
    }

    const stdout = await runBlenderScript(`import bpy\n${code}`, {
      blendFile: file,
      timeoutMs: (timeoutSeconds ?? 300) * 1000,
    });

    // Blender's banner and shutdown lines carry no signal for the caller.
    const output = stdout
      .split("\n")
      .filter((l) => !/^(Blender quit|Blender \d|\s*$)/.test(l))
      .join("\n")
      .trim();

    return { output: output || "(no output)" };
  },
});

export const blenderSceneInfo = defineTool({
  namespace: NS,
  access: "read",
  name: "blender_scene_info",
  description:
    "Summarize a .blend file: objects, which are animated and over what keyframe range, cameras, materials, frame range and render settings.",
  schema: {
    blendFile: z.string().describe("Path to the .blend file"),
  },
  handler: async ({ blendFile }) => {
    const file = expandPath(blendFile);
    if (!existsSync(file)) {
      throw new Error(`Blend file not found: ${file}`);
    }

    const stdout = await runBlenderScript(buildInspectScript(), {
      blendFile: file,
      timeoutMs: 120_000,
    });

    return extractJson(stdout);
  },
});

export const blenderEncodeFrames = defineTool({
  namespace: NS,
  access: "write",
  name: "blender_encode_frames",
  description:
    "Encode an existing PNG frame sequence into an mp4 with ffmpeg. Use to re-encode frames kept from a previous render at different settings without re-rendering.",
  schema: {
    framesDir: z.string().describe("Directory containing the PNG sequence"),
    outputPath: z.string().optional().describe("Output mp4 path (default: <framesDir>/../out.mp4)"),
    fps: z.number().int().optional().describe("Frames per second (default: 24)"),
    crf: z
      .number()
      .int()
      .optional()
      .describe("Quality, 0-51, lower is better (default: 18)"),
  },
  handler: async ({ framesDir, outputPath, fps, crf }) => {
    const dir = expandPath(framesDir);
    const frames = listFrames(dir);
    if (frames.length === 0) {
      throw new Error(`No PNG frames found in ${dir}`);
    }

    const out = outputPath ? expandPath(outputPath) : join(dir, "..", "out.mp4");
    const rate = fps ?? 24;

    await encodeFrames(frames, out, { fps: rate, crf: crf ?? 18 });

    return {
      videoPath: out,
      frames: frames.length,
      durationSeconds: Number((frames.length / rate).toFixed(2)),
      nextStep: `Show it with the media bag: view_video ${out}`,
    };
  },
});

export { BlenderError };
