/**
 * Python injected around user scene code for renders.
 *
 * The agent-authored snippet only has to build geometry and keyframes; this
 * preamble/epilogue owns the parts that are easy to get wrong and that silently
 * produce an empty video when omitted: an empty scene, a camera (Blender
 * renders black with no scene.camera), the frame range, and output settings.
 */

export interface RenderSettings {
  outputDir: string;
  frameStart: number;
  frameEnd: number;
  resolutionX: number;
  resolutionY: number;
  engine: "BLENDER_EEVEE" | "CYCLES" | "BLENDER_WORKBENCH";
  samples: number;
  transparent: boolean;
  fps: number;
}

function py(value: string): string {
  return JSON.stringify(value);
}

export function buildRenderScript(sceneCode: string, s: RenderSettings): string {
  return `import bpy, math, mathutils, os, sys

# Start from a genuinely empty scene so nothing depends on Blender's default
# cube/camera/light being present (or absent).
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

def look_at(obj, target=(0.0, 0.0, 0.0)):
    """Point obj at target. Cameras/lights aim down -Z, hence the track_to quat."""
    direction = mathutils.Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()

# ---- agent-authored scene ----
${sceneCode}
# ---- end scene ----

# A camera is required or every frame renders black. Only synthesize one when
# the scene code did not supply it.
if scene.camera is None:
    cam = next((o for o in scene.objects if o.type == 'CAMERA'), None)
    if cam is None:
        bpy.ops.object.camera_add(location=(7.5, -7.5, 5.5))
        cam = bpy.context.active_object
        look_at(cam)
    scene.camera = cam

# Likewise, an unlit scene renders black in both EEVEE and Cycles.
if not any(o.type == 'LIGHT' for o in scene.objects):
    bpy.ops.object.light_add(type='SUN', location=(4.0, -4.0, 8.0))
    bpy.context.active_object.data.energy = 4.0

scene.frame_start = ${s.frameStart}
scene.frame_end = ${s.frameEnd}
scene.render.fps = ${s.fps}
scene.render.engine = ${py(s.engine)}
scene.render.resolution_x = ${s.resolutionX}
scene.render.resolution_y = ${s.resolutionY}
scene.render.resolution_percentage = 100
scene.render.film_transparent = ${s.transparent ? "True" : "False"}

if scene.render.engine == 'CYCLES':
    scene.cycles.samples = ${s.samples}
elif scene.render.engine == 'BLENDER_EEVEE':
    try:
        scene.eevee.taa_render_samples = ${s.samples}
    except AttributeError:
        pass

# PNG sequence, not a video container: the macOS cask build has no FFMPEG
# muxer compiled in, and a sequence survives an interrupted render.
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = ${s.transparent ? "'RGBA'" : "'RGB'"}
scene.render.filepath = os.path.join(${py(s.outputDir)}, "f_")

print("BARRY_SCENE_OK objects=%d frames=%d-%d engine=%s" % (
    len(scene.objects), scene.frame_start, scene.frame_end, scene.render.engine))
`;
}

export function buildInspectScript(): string {
  return `import bpy, json

scene = bpy.context.scene
objects = []
for o in bpy.data.objects:
    entry = {"name": o.name, "type": o.type,
             "location": [round(v, 4) for v in o.location]}
    anim = o.animation_data
    if anim and anim.action:
        # Keyframe coordinates live under the action's slotted channelbags in
        # Blender 4.4+ (action.fcurves was removed), so read frame_range, which
        # is stable across both layouts.
        rng = anim.action.frame_range
        entry["animated"] = True
        entry["keyframeRange"] = [round(rng[0], 2), round(rng[1], 2)]
    objects.append(entry)

print("BARRY_JSON_START")
print(json.dumps({
    "objects": objects,
    "frameStart": scene.frame_start,
    "frameEnd": scene.frame_end,
    "fps": scene.render.fps,
    "engine": scene.render.engine,
    "resolution": [scene.render.resolution_x, scene.render.resolution_y],
    "cameras": [o.name for o in bpy.data.objects if o.type == 'CAMERA'],
    "activeCamera": scene.camera.name if scene.camera else None,
    "materials": [m.name for m in bpy.data.materials],
}))
print("BARRY_JSON_END")
`;
}

/** Blender prints plenty of noise around our payload, so it is delimited. */
export function extractJson(stdout: string): unknown {
  const start = stdout.indexOf("BARRY_JSON_START");
  const end = stdout.indexOf("BARRY_JSON_END");
  if (start === -1 || end === -1) {
    throw new Error("Blender did not emit the expected JSON payload");
  }
  return JSON.parse(stdout.slice(start + "BARRY_JSON_START".length, end).trim());
}
