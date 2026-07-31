<!-- tools: Bash,Read -->
# QA: blender pack

Blender Barry pack — headless animation authoring and rendering to mp4 as
in-process tools, plus the official Blender Foundation MCP server (opt-in,
GUI-only) and two skills.

## Requirements

- `node` (v18+), `pnpm`
- `blender` on PATH (`brew install --cask blender`) — verified against 5.2.0 LTS
- `ffmpeg` on PATH (`brew install ffmpeg`)
- Optional: `barry` CLI — the registration steps are SKIPPED when absent

## Setup

```bash
pnpm install 2>&1 | grep -v ERR_PNPM || true
```

## Test Steps

### 1. TypeScript compiles

```bash
npx tsc --noEmit
```

**Expected:** Exit code 0, no output.

### 2. Tools module exports all 5 tools

```bash
cat > qa-tmp.mts <<'EOF'
import * as tools from "./src/tools.js";
const t = Object.values(tools).filter((x: any) => x?.name && x?.handler);
console.log(JSON.stringify(t.map((x: any) => `${x.namespace}/${x.name}:${x.access}`).sort()));
EOF
npx tsx qa-tmp.mts 2>&1 | grep -v DEP0205; rm -f qa-tmp.mts
```

**Expected:** exactly
`blender/blender_encode_frames:write`, `blender/blender_render:write`,
`blender/blender_run_script:write`, `blender/blender_scene_info:read`,
`blender/blender_status:read`

Tool `access` must be `read`/`write` only — `readwrite` is a *trait* level and
fails `defineTool`'s type.

### 3. Environment probe (real handler invoke)

```bash
cat > qa-tmp.mts <<'EOF'
import { blenderStatus } from "./src/tools.js";
console.log(JSON.stringify(await (blenderStatus as any).handler({}, {})));
EOF
npx tsx qa-tmp.mts 2>&1 | grep -v DEP0205; rm -f qa-tmp.mts
```

**Expected:** `blenderInstalled: true`, a version string, `ffmpegInstalled: true`,
and `engines` containing `BLENDER_EEVEE`, `BLENDER_WORKBENCH`, `CYCLES`.

> `CYCLES` is only registered via the `-E` flag. Inspecting the RNA enum on a
> factory startup shows EEVEE alone — that is expected, not a failure.

### 4. End-to-end render (EEVEE)

```bash
cat > qa-tmp.mts <<'EOF'
import { blenderRender } from "./src/tools.js";
const r = await (blenderRender as any).handler({
  name: "qa-render", frameStart: 1, frameEnd: 10,
  resolutionX: 160, resolutionY: 120, samples: 4,
  sceneCode: `bpy.ops.mesh.primitive_cube_add()
c = bpy.context.active_object
c.rotation_euler=(0,0,0); c.keyframe_insert("rotation_euler", frame=1)
c.rotation_euler=(0,0,math.radians(360)); c.keyframe_insert("rotation_euler", frame=11)`,
}, {});
console.log(JSON.stringify(r));
EOF
npx tsx qa-tmp.mts 2>&1 | grep -v DEP0205; rm -f qa-tmp.mts
ffprobe -v error -count_frames -show_entries stream=nb_read_frames,codec_name,pix_fmt \
  -of default=nw=1 ~/.barry/blender/qa-render/qa-render.mp4
```

**Expected:** `frames: 10`; probe reports `nb_read_frames=10` (exactly — a
duplicated tail frame is a regression), `codec_name=h264`, `pix_fmt=yuv420p`.
`framesDir` is absent because frames are cleaned up by default.

### 5. Typed-error paths

```bash
cat > qa-tmp.mts <<'EOF'
import { blenderRender, blenderSceneInfo } from "./src/tools.js";
const ctx = {} as any;
for (const [label, fn] of [
  ["broken-python", () => (blenderRender as any).handler({ name:"qa-e1", sceneCode:"not python(((", frameEnd:2 }, ctx)],
  ["bad-range",     () => (blenderRender as any).handler({ name:"qa-e2", sceneCode:"pass", frameStart:10, frameEnd:2 }, ctx)],
  ["missing-blend", () => (blenderSceneInfo as any).handler({ blendFile:"/tmp/nope.blend" }, ctx)],
] as any[]) {
  try { await fn(); console.log("FAIL", label); }
  catch (e: any) { console.log("OK", label + ":", e.message.slice(0, 70)); }
}
EOF
npx tsx qa-tmp.mts 2>&1 | grep -v DEP0205; rm -f qa-tmp.mts
```

**Expected:** all three throw.

`broken-python` is the important one: Blender exits 0 on a Python traceback, so
without `--python-exit-code 1` a broken scene silently yields an empty video.

### 6. Stale output is not returned after a failure

```bash
cat > qa-tmp.mts <<'EOF'
import { blenderRender } from "./src/tools.js";
import { existsSync } from "node:fs";
const ok = await (blenderRender as any).handler({ name:"qa-stale", sceneCode:"bpy.ops.mesh.primitive_cube_add()", frameEnd:3, resolutionX:64, resolutionY:48, samples:4 }, {});
try { await (blenderRender as any).handler({ name:"qa-stale", sceneCode:"raise RuntimeError('boom')", frameEnd:3 }, {}); } catch {}
console.log("stale video still present?", existsSync(ok.videoPath));
EOF
npx tsx qa-tmp.mts 2>&1 | grep -v DEP0205; rm -f qa-tmp.mts
```

**Expected:** `false`. A failed re-render must not leave the previous run's mp4
at the advertised path, where it would play like a fresh result.

### 7. Paths with glob metacharacters, and frame ordering

```bash
mkdir -p "/tmp/qa br[1] dir/frames"
cat > qa-tmp.mts <<'EOF'
import { listFrames, encodeFrames } from "./src/exec.js";
import { mkdirSync, writeFileSync } from "node:fs";
// numeric ordering: f_9 must precede f_10
mkdirSync("/tmp/qa-order", { recursive: true });
for (const n of [1,2,9,10,11]) writeFileSync(`/tmp/qa-order/f_${n}.png`, "");
console.log("order:", listFrames("/tmp/qa-order").map(f => f.split("/").pop()).join(" "));
EOF
npx tsx qa-tmp.mts 2>&1 | grep -v DEP0205; rm -f qa-tmp.mts
```

**Expected:** `f_1.png f_2.png f_9.png f_10.png f_11.png`.

Lexicographic sorting would put `f_10` before `f_9` and shuffle the animation.
Encoding uses an ffmpeg concat list rather than `-pattern_type glob`, because a
`[` anywhere in the path (legal in a home directory) makes glob match nothing —
the render completes, then encoding fails with an opaque error.

### 8. Transparency returns a usable matte

```bash
cat > qa-tmp.mts <<'EOF'
import { blenderRender } from "./src/tools.js";
const r = await (blenderRender as any).handler({ name:"qa-alpha", sceneCode:"bpy.ops.mesh.primitive_cube_add()", frameEnd:3, resolutionX:64, resolutionY:48, samples:4, transparent:true }, {});
console.log(JSON.stringify({ framesDir: r.framesDir, alphaNote: !!r.alphaNote }));
EOF
npx tsx qa-tmp.mts 2>&1 | grep -v DEP0205; rm -f qa-tmp.mts
ffprobe -v error -show_entries stream=pix_fmt -of csv=p=0 ~/.barry/blender/qa-alpha/frames/f_0001.png
```

**Expected:** `framesDir` set, `alphaNote` present, PNG `pix_fmt=rgba`.

h264 cannot carry alpha (it flattens to black), and VP9/WebM did not preserve it
on round-trip in this ffmpeg build either — so the RGBA PNG sequence is the
deliverable and is deliberately retained.

### 9. Manifest parses and dependencies resolve

```bash
barry pack show blender
```

**Expected:** both dependencies marked ✓, skills dir listed, and exactly three
traits — `blender`, `blender-read`, `blender-live` — with no duplicates.

> Duplicate `blender`/`blender-read` rows mean `getAllTraits` regressed: a
> manifest trait that reuses an auto-trait name must override it, not append.

### 10. Loads through Barry's pack loader (production path)

```bash
cd ~/repos/barry && cat > /tmp/qa-load.mts <<'EOF'
import { ensurePacksBuilt } from "/Users/tyler/repos/barry/packages/packs/src/build.js";
const r = await ensurePacksBuilt();
console.log(JSON.stringify(r.find((x: any) => x.name === "blender")));
EOF
npx tsx /tmp/qa-load.mts 2>&1 | grep -v DEP0205; rm -f /tmp/qa-load.mts
```

**Expected:** `{"name":"blender","ok":true,...}`. The MCP server loads the built
bundle, not the TypeScript source, so a pack that compiles can still fail here.

### 11. Live MCP handshake (Online — SKIP if the server is not running)

```bash
PID=$(pgrep -f "servers/mcp" | head -1)
SEC=$(ps eww -p "$PID" | tr ' ' '\n' | grep '^BARRY_SECRET=' | cut -d= -f2-)
curl -s -D /tmp/qa-h.txt -X POST http://localhost:4901/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SEC" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"qa","version":"1"}}}' >/dev/null
SID=$(grep -i "mcp-session-id" /tmp/qa-h.txt | tr -d '\r' | awk '{print $2}')
curl -s -X POST http://localhost:4901/mcp -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $SEC" \
  -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
curl -s -X POST http://localhost:4901/mcp -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $SEC" \
  -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | tr ',' '\n' | grep -o '"blender_[a-z_]*"' | sort -u
```

**Expected:** all 5 `blender_*` tool names.

Take `BARRY_SECRET` from the running process — the value under that key in
`com.barry.mcp.plist` is not the bearer token and returns 401.

After changing pack tools: rebuild the bundle (step 10) **and**
`barry service restart mcp`, or sessions keep the stale bundle.

## Cleanup

```bash
trash ~/.barry/blender/qa-* /tmp/qa-order "/tmp/qa br[1] dir" 2>/dev/null || true
```

## Known-good timings

| Render | Time |
|---|---|
| 12 frames, 320x240, EEVEE, 8 samples | ~2s |
| 48 frames, 640x360, EEVEE, 24 samples | ~18s |
| 3 frames, 160x120, Cycles/Metal, 8 samples | ~186s (first run) |

Cycles' first run on a machine compiles Metal GPU kernels before any frame
appears. That is warm-up, not a hang — later runs reuse the cache. Raise
`timeoutMinutes` for long Cycles jobs; the default cap is 20 minutes and a
timeout discards the partial render.

### 12. blender-live server launches and handshakes (Online)

```bash
{ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"qa","version":"1"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  sleep 3
} | uvx --from "git+https://projects.blender.org/lab/blender_mcp.git@v1.0.0#subdirectory=mcp" \
      --with "mcp[cli]<2" blender-mcp 2>/dev/null \
  | tail -1 | tr ',' '\n' | grep -o '"name":"[a-z_0-9]*"' | sort -u | wc -l
```

**Expected:** `26` tools, and the initialize response reports
`serverInfo.name = blender-mcp`.

The `--with "mcp[cli]<2"` pin is required. Upstream declares an unbounded
`mcp[cli]>=1.2.0`, which now resolves to mcp 2.x; that release removed
`mcp.server.fastmcp`, so an unpinned install starts and immediately dies with
`ModuleNotFoundError`. Without the pin this step fails.

### 13. A real session actually uses the tools (Online)

```bash
barry session run --traits blender --max-turns 14 \
  -p "Make a short animation: three colored spheres bouncing on a floor, with the camera slowly orbiting. Render it and tell me the video path."
```

**Expected:** the returned path is under `~/.barry/blender/<slug>/`, proving
`blender_render` was called. Then confirm the frames are not blank:

```bash
ffmpeg -y -v error -i <path> -vf "select='eq(n\,8)+eq(n\,36)',tile=2x1" \
  -frames:v 1 /tmp/check.png
```

Open `/tmp/check.png` and look at it. **This step is the whole point** — every
other check in this file passed while the pack was silently broken end to end.

A path in `/tmp` (or anywhere outside the render root) means the agent never
saw the tools and hand-rolled Bash instead. That failure mode is invisible from
the transcript: the agent reports success, and the video is a uniform grey
rectangle. Check the tools are visible first:

```bash
barry session run --traits blender --max-turns 3 \
  -p "List every tool available to you starting with 'blender'. If none, say NONE."
```

**Expected:** five `mcp__barry__blender_*` tools. `NONE` means trait→tool
resolution is broken — check that the `traits` row's `namespaces` is
`["blender"]` (not `["blender-live"]`), that a session row was created with the
trait, and that `BARRY_SECRET` reaches the MCP connection.

## Not covered

The `blender-live` tools are not exercised end to end. The server launches and
lists its tools (step 12), but every non-`*_for_cli` tool needs Blender running
in the GUI with the Blender Lab MCP add-on installed and enabled, which cannot
be done headlessly. The trait is opt-in and cannot affect the headless render
path.
