---
name: blender-scripting
description: Blender bpy scripting reference and headless CLI gotchas — flag ordering, engine identifiers, API changes in Blender 5.x, and why renders come out black or empty. Use when writing bpy Python, debugging a Blender script, or running Blender from the command line.
context: current
allowed-tools: Bash, Read, Write
---

# Blender Scripting & Headless CLI

Reference for driving Blender from code. Everything here was verified against
**Blender 5.2.0 LTS on macOS (Apple Silicon)**.

## Why a render comes out black or empty

In order of how often it happens:

1. **No camera.** `scene.camera` must be set, not merely present in the scene.
   Adding a camera object is not enough — assign `scene.camera = cam`.
2. **No light** (except in `BLENDER_WORKBENCH`, which is flat-shaded).
3. **Camera pointing the wrong way.** Cameras aim down local -Z. Use
   `direction.to_track_quat('-Z', 'Y').to_euler()` rather than guessing angles.
4. **Nothing rendered at all.** See the `--` flag trap below.
5. **Geometry behind the camera** or outside its clip range.

## CLI flag ordering — the trap

Everything after a bare `--` is passed to the *script*, not to Blender. So this
silently renders nothing and still exits 0:

```bash
blender -b -P scene.py -- -a          # WRONG: -a goes to the script
```

Render flags must be real Blender arguments, before any `--`:

```bash
blender -b --factory-startup -P scene.py -E CYCLES -a -- --cycles-device METAL
```

`--cycles-device` is the exception that genuinely belongs after `--`.

Also note Blender **exits 0 even when your Python raises**. Always pass
`--python-exit-code 1` so a traceback fails the process. Without it, a broken
script looks like a successful run.

Use `--factory-startup` for reproducibility — otherwise Blender loads the user's
startup file and add-ons and the same script renders differently per machine.

## Render engines

`blender -E help` on 5.2 lists exactly three:

```
BLENDER_EEVEE      BLENDER_WORKBENCH      CYCLES
```

- The identifier is plain **`BLENDER_EEVEE`** — this *is* EEVEE Next. The
  transitional `BLENDER_EEVEE_NEXT` id no longer exists; code using it breaks.
- `CYCLES` is registered through the `-E CYCLES` flag. Inspecting
  `RenderSettings.bl_rna` enum items on a factory startup shows only
  `BLENDER_EEVEE`, which is misleading — Cycles still works when selected via
  `-E` or by assigning `scene.render.engine = 'CYCLES'`.
- Cycles on Apple Silicon uses the GPU via `-- --cycles-device METAL`.

## Video output: use a PNG sequence

The macOS cask build has **no FFMPEG muxer compiled in** — `FFMPEG` appears in
the RNA schema but assigning it raises:

```
enum "FFMPEG" not found in ('AVIF', 'JPEG', 'OPEN_EXR', 'PNG', 'WEBP', ...)
```

So render a PNG sequence and encode externally:

```bash
ffmpeg -y -framerate 24 -pattern_type glob -i 'frames/f_*.png' \
  -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart out.mp4
```

`-pix_fmt yuv420p` is required for QuickTime/Safari. libx264 also rejects odd
pixel dimensions — pad with `-vf "pad=ceil(iw/2)*2:ceil(ih/2)*2"`.

A sequence is the better default anyway: an interrupted render loses one frame
instead of the whole file, and frames can be re-encoded without re-rendering.

## Changing the current frame

Use `scene.frame_set(n)`, never `scene.frame_current = n`. Only `frame_set()`
re-evaluates the dependency graph; the assignment moves the playhead without
updating anything derived from it. Verified on 5.2 with an object keyframed from
z=0 to z=10:

```python
scene.frame_current = 20
obj.matrix_world.translation.z   # 0.0  — stale, silently wrong
scene.frame_set(20)
obj.matrix_world.translation.z   # 10.0 — correct
```

This bites any script that inspects animated state, bakes a simulation, or
exports per-frame data. There is no error — just wrong numbers.

## Blender 5.x API changes that bite

- **`Action.fcurves` is gone** (removed in 4.4's slotted-Actions rework). Curves
  now live at `action.layers[i].strips[j].channelbag(slot).fcurves`. Plain
  `obj.keyframe_insert(...)` is unaffected — only introspection breaks. See the
  `fcurves_of()` helper in the blender-animation skill.

  Be sceptical of `bpy` snippets found online here: several popular Blender
  agent-skill repos still publish `action.fcurves.find("location", index=0)`,
  which raises `AttributeError` on 5.2. Confirmed against this build:
  `hasattr(action, "fcurves")` is `False`.
- Principled BSDF socket names changed in 4.x (`Emission` → `Emission Color`).
  Index sockets by name and verify with `print([s.name for s in bsdf.inputs])`.

## Scene setup idioms

```python
bpy.ops.wm.read_factory_settings(use_empty=True)   # truly empty scene
```

`bpy.ops.*_add()` leaves the new object in `bpy.context.active_object`. Grab it
immediately — the next operator call replaces it.

Prefer data-API calls over operators where both exist; operators depend on
context and are fragile headless. For example `bpy.data.objects.remove(obj)`
rather than selecting and calling `bpy.ops.object.delete()`.

Frame numbers are integers and the range is inclusive: `frame_start=1`,
`frame_end=48` renders 48 frames.

## Debugging

Run snippets with `blender_run_script`, or directly:

```bash
blender -b --factory-startup --python-exit-code 1 \
  --python-expr "import bpy; print([o.name for o in bpy.data.objects])"
```

Blender writes tracebacks to stdout amid heavy progress logging — read the
*last* lines, not the first.

`blender_scene_info` summarizes an existing `.blend` (objects, animation ranges,
cameras, materials) without opening the GUI.

## The live MCP server (blender-live trait)

The official Blender Foundation MCP server can inspect a **running** Blender
desktop session and search the bundled `bpy` API reference for the exact
installed version — useful when a socket name or signature is uncertain.

It requires Blender open with the Lab MCP add-on installed and enabled
(extensions repo `https://lab.blender.org/`). It has no animation or video
tools, so it complements the headless tools rather than replacing them. It also
executes model-written code inside your live session with no sandbox — don't
point it at a file with unsaved work you care about.
