# blender pack

Generate 3D animations with [Blender](https://www.blender.org/) and get back an
mp4 — without opening the Blender GUI.

## Why this exists

Both existing Blender MCP servers (the official Blender Foundation one and the
popular community `ahujasid/blender-mcp`) drive a **running Blender desktop app**
over a TCP socket, and neither has any animation or video tooling — no keyframe
tools, no frame ranges, no encoding. Animation is reachable only by hand-writing
`bpy` through a generic "execute this Python" tool.

So this pack owns the render path itself: it runs Blender headlessly
(`blender -b -P script.py -a`), renders a PNG sequence, and encodes it to mp4
with ffmpeg. That works unattended in a background session, which the
socket-based servers cannot do.

The official MCP server is still registered, behind the opt-in `blender-live`
trait, because it is genuinely good at two things this pack doesn't do: inspecting
a scene you already have open, and searching the exact `bpy` API reference for
your installed Blender version.

## Install

```bash
brew install --cask blender     # also puts a `blender` wrapper on PATH
brew install ffmpeg             # Blender's macOS cask build cannot encode video

barry pack add blender ~/repos/packs/blender
barry pack enable blender
```

## Tools

| Tool | What it does |
|---|---|
| `blender_status` | Verify Blender + ffmpeg are installed; report version and engines |
| `blender_render` | Render an animation from `bpy` scene code → mp4 |
| `blender_run_script` | Run arbitrary `bpy` Python headlessly, return stdout |
| `blender_scene_info` | Summarize a `.blend`: objects, animation ranges, cameras, materials |
| `blender_encode_frames` | Re-encode a kept PNG sequence at different settings |

`blender_render` takes only scene-building code. Camera, lighting, frame range,
output settings, and encoding are handled for you, so the common failure modes
(black frames from a missing camera or light) can't happen by omission. Renders
land in `~/.barry/blender/<name>/`.

## Traits

- **`blender`** — headless authoring and rendering (default)
- **`blender-read`** — inspection only
- **`blender-live`** — the official MCP server (26 tools); requires Blender open
  with the [Blender Lab](https://lab.blender.org/) MCP add-on enabled. The
  server itself is verified to launch and hand-shake, but its tools have not
  been exercised against a live GUI session.

## Skills

- **`blender-animation`** — keyframes, easing, looping motion, cameras,
  materials, engine selection
- **`blender-node-graphs`** — shader and geometry node trees from Python:
  verified type strings, socket names, scattering, and the 5.2 compositor rework
- **`blender-physics`** — rigid bodies, cloth, particles, and the headless
  baking trap (a simulation does not advance unless you step the frames)
- **`blender-scripting`** — CLI flag ordering, engine identifiers, Blender 5.x
  API changes, and why renders come out black

Written from scratch rather than vendored. Surveyed open-source Blender agent
skills were either GUI/MCP-first (assuming a live Blender session, which this
pack deliberately avoids), unlicensed, or carried code that fails on Blender
5.x — several still publish `action.fcurves.find(...)`, removed in 4.4.

## Security

`blender_render` and `blender_run_script` execute model-written Python inside
Blender, which has full filesystem access through `bpy` and Python's standard
library. There is no sandbox. This is inherent to how Blender is automated —
both upstream MCP servers do the same, and the official one ships an explicit
warning recommending a VM.

Practically: treat these tools like running a script you didn't read. Renders
write only under `~/.barry/blender/`, but nothing *enforces* that.

## Notes

Verified against Blender 5.2.0 LTS on macOS (Apple Silicon). Four things that
cost real debugging time and are encoded in the tools and skills:

- Anything after `--` on the Blender command line goes to the *script*, so a
  render flag placed there is silently swallowed and nothing renders.
- Blender exits 0 even when your Python raises — `--python-exit-code 1` is what
  turns a traceback into a failed render instead of an empty video.
- The macOS cask build has no FFMPEG muxer compiled in, so a PNG sequence plus
  external ffmpeg is the only route to video, not merely a preference.
- h264 cannot carry alpha, so `transparent: true` keeps the RGBA PNG sequence
  and returns its path; the mp4 is a preview with the matte flattened to black.

EEVEE renders a short clip in seconds. Cycles is path-traced and much slower —
its first run on a machine spends 2–3 minutes compiling Metal GPU kernels before
any frame appears.
