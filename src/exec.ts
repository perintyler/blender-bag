import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No TS parameter properties here — the MCP server imports pack tools under
// Node's strip-only type stripping, which can't transform that syntax.
export class BlenderError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = "BlenderError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

const BLENDER_BIN = process.env.BLENDER_PATH || "blender";

/**
 * Renders can take many minutes; well above Blender's own tooling defaults.
 *
 * Cycles is the reason this is generous: its first run on a machine spends
 * minutes compiling Metal GPU kernels before the first frame appears, so a
 * short cap would kill the render during warm-up and discard the work.
 */
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

function run(
  bin: string,
  args: string[],
  timeoutMs: number,
  installHint: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new BlenderError(installHint, null, ""));
            return;
          }
          // execFile kills the child with SIGTERM when `timeout` elapses.
          if ((error as { signal?: string | null }).signal === "SIGTERM") {
            reject(
              new BlenderError(
                `${bin} timed out after ${Math.round(timeoutMs / 60_000)} minutes and the partial render was discarded. ` +
                `Either raise timeoutMinutes, or lower the sample count, resolution, or frame count.`,
                null,
                stderr,
              ),
            );
            return;
          }
          reject(
            new BlenderError(
              `${bin} failed: ${lastMeaningfulLine(stderr) || lastMeaningfulLine(stdout) || error.message}`,
              typeof error.code === "number" ? error.code : null,
              stderr,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Blender reports Python tracebacks on stdout and prints a lot of progress
 * noise, so the useful error is usually the final non-empty line rather than
 * the first.
 */
function lastMeaningfulLine(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines.slice(-3).join(" | ") : "";
}

export function runBlender(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return run(
    BLENDER_BIN,
    args,
    timeoutMs,
    "Blender is not installed. Install it: brew install --cask blender",
  );
}

export function runFfmpeg(args: string[], timeoutMs = 10 * 60_000): Promise<string> {
  return run(
    "ffmpeg",
    args,
    timeoutMs,
    "ffmpeg is not installed. Install it: brew install ffmpeg",
  );
}

/**
 * Run a bpy script headlessly.
 *
 * `--factory-startup` keeps renders reproducible: without it Blender loads the
 * user's saved startup file and add-ons, so the same script can render
 * differently on two machines. `--python-exit-code 1` is what makes a Python
 * traceback fail the process — by default Blender prints the traceback and
 * still exits 0, which would silently report a broken render as a success.
 *
 * `extraArgs` (e.g. `-a`, `-E CYCLES`) must be passed as real argv entries
 * rather than appended after `--`: everything following `--` is handed to the
 * script, so a render flag placed there is swallowed and nothing renders.
 */
export async function runBlenderScript(
  script: string,
  options?: { extraArgs?: string[]; timeoutMs?: number; blendFile?: string },
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "barry-blender-"));
  const scriptPath = join(dir, "script.py");
  writeFileSync(scriptPath, script, "utf-8");

  const args = ["-b"];
  if (options?.blendFile) args.push(options.blendFile);
  args.push("--factory-startup", "--python-exit-code", "1", "-P", scriptPath);
  if (options?.extraArgs?.length) args.push(...options.extraArgs);

  return runBlender(args, options?.timeoutMs);
}

export async function isBlenderInstalled(): Promise<boolean> {
  try {
    await runBlender(["--version"], 30_000);
    return true;
  } catch {
    return false;
  }
}

export async function isFfmpegInstalled(): Promise<boolean> {
  try {
    await runFfmpeg(["-version"], 15_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encode a PNG sequence to h264 mp4.
 *
 * Frames are passed via a concat list rather than `-pattern_type glob`: ffmpeg
 * parses the glob itself, so a path containing `[`, `?` or `*` (entirely legal
 * in a home directory or animation name) is read as a character class and the
 * input matches nothing. The list also pins frame order explicitly instead of
 * relying on shell-style sorting.
 */
export async function encodeFrames(
  frameFiles: string[],
  outputPath: string,
  options: { fps: number; crf: number },
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "barry-blender-concat-"));
  const listPath = join(dir, "frames.txt");

  // `file '...'` — single quotes are escaped per ffmpeg concat demuxer rules.
  // No per-entry `duration`: the demuxer ignores the last one, which forces a
  // duplicated final frame to compensate. Letting `-r` set a constant rate
  // instead yields exactly one output frame per input frame.
  const lines = frameFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`);
  writeFileSync(listPath, `${lines.join("\n")}\n`, "utf-8");

  const codec = [
    "-c:v",
    "libx264",
    // yuv420p is required for QuickTime/Safari playback.
    "-pix_fmt",
    "yuv420p",
    "-crf",
    String(options.crf),
    "-movflags",
    "+faststart",
  ];

  await runFfmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-r",
    String(options.fps),
    "-i",
    listPath,
    "-r",
    String(options.fps),
    // Keeps dimensions even, which libx264 rejects otherwise.
    "-vf",
    "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    ...codec,
    outputPath,
  ]);
}

/**
 * Absolute paths of the PNG frames in `dir`, in frame order.
 *
 * Sorted numerically on the trailing frame number rather than
 * lexicographically, so an unpadded sequence (f_9, f_10) doesn't order 10
 * before 9 and shuffle the animation.
 */
export function listFrames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const frameNumber = (f: string): number => {
    const match = f.match(/(\d+)(?=\.png$)/i);
    return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
  };
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".png"))
    .sort((a, b) => frameNumber(a) - frameNumber(b) || a.localeCompare(b))
    .map((f) => join(dir, f));
}
