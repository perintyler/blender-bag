import { describe, it, expect } from "vitest";
import { buildRenderScript, buildInspectScript, extractJson } from "./scene.js";

describe("buildRenderScript", () => {
  const baseSettings = {
    outputDir: "/tmp/renders",
    frameStart: 1,
    frameEnd: 48,
    resolutionX: 1920,
    resolutionY: 1080,
    engine: "BLENDER_EEVEE" as const,
    samples: 64,
    transparent: false,
    fps: 24,
  };

  it("embeds resolution and frame range", () => {
    const script = buildRenderScript("pass", baseSettings);
    expect(script).toContain("scene.render.resolution_x = 1920");
    expect(script).toContain("scene.render.resolution_y = 1080");
    expect(script).toContain("scene.frame_start = 1");
    expect(script).toContain("scene.frame_end = 48");
    expect(script).toContain("scene.render.fps = 24");
  });

  it("embeds the scene code between markers", () => {
    const script = buildRenderScript("bpy.ops.mesh.primitive_cube_add()", baseSettings);
    expect(script).toContain("# ---- agent-authored scene ----");
    expect(script).toContain("bpy.ops.mesh.primitive_cube_add()");
    expect(script).toContain("# ---- end scene ----");
  });

  it("sets BLENDER_EEVEE engine", () => {
    const script = buildRenderScript("pass", baseSettings);
    expect(script).toContain('scene.render.engine = "BLENDER_EEVEE"');
    expect(script).toContain("scene.eevee.taa_render_samples = 64");
  });

  it("sets CYCLES engine", () => {
    const script = buildRenderScript("pass", { ...baseSettings, engine: "CYCLES" });
    expect(script).toContain('scene.render.engine = "CYCLES"');
    expect(script).toContain("scene.cycles.samples = 64");
  });

  it("sets BLENDER_WORKBENCH engine", () => {
    const script = buildRenderScript("pass", { ...baseSettings, engine: "BLENDER_WORKBENCH" });
    expect(script).toContain('scene.render.engine = "BLENDER_WORKBENCH"');
  });

  it("handles transparent = true", () => {
    const script = buildRenderScript("pass", { ...baseSettings, transparent: true });
    expect(script).toContain("scene.render.film_transparent = True");
    expect(script).toContain("'RGBA'");
  });

  it("handles transparent = false", () => {
    const script = buildRenderScript("pass", { ...baseSettings, transparent: false });
    expect(script).toContain("scene.render.film_transparent = False");
    expect(script).toContain("'RGB'");
  });

  it("embeds output directory", () => {
    const script = buildRenderScript("pass", { ...baseSettings, outputDir: "/my/output" });
    expect(script).toContain('"/my/output"');
  });

  it("imports bpy at the top", () => {
    const script = buildRenderScript("pass", baseSettings);
    expect(script).toMatch(/^import bpy/);
  });
});

describe("buildInspectScript", () => {
  it("returns a string containing bpy import", () => {
    const script = buildInspectScript();
    expect(script).toContain("import bpy");
  });

  it("contains BARRY_JSON_START and BARRY_JSON_END markers", () => {
    const script = buildInspectScript();
    expect(script).toContain("BARRY_JSON_START");
    expect(script).toContain("BARRY_JSON_END");
  });

  it("uses json.dumps for output", () => {
    const script = buildInspectScript();
    expect(script).toContain("json.dumps");
  });
});

describe("extractJson", () => {
  it("extracts JSON between markers", () => {
    const stdout = `Blender noise\nBARRY_JSON_START\n{"objects": []}\nBARRY_JSON_END\nmore noise`;
    const result = extractJson(stdout);
    expect(result).toEqual({ objects: [] });
  });

  it("handles complex JSON with surrounding noise", () => {
    const stdout = [
      "Blender 4.4.0 (hash abc123)",
      "Read prefs: ...",
      "BARRY_JSON_START",
      JSON.stringify({ objects: [{ name: "Cube", type: "MESH" }], frameStart: 1 }),
      "BARRY_JSON_END",
      "Blender quit",
    ].join("\n");
    const result = extractJson(stdout) as { objects: { name: string }[] };
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].name).toBe("Cube");
  });

  it("throws when BARRY_JSON_START is missing", () => {
    const stdout = `noise\n{"data": 1}\nBARRY_JSON_END`;
    expect(() => extractJson(stdout)).toThrow("Blender did not emit the expected JSON payload");
  });

  it("throws when BARRY_JSON_END is missing", () => {
    const stdout = `BARRY_JSON_START\n{"data": 1}\nnoise`;
    expect(() => extractJson(stdout)).toThrow("Blender did not emit the expected JSON payload");
  });

  it("throws when both markers are missing", () => {
    const stdout = `just some random blender output`;
    expect(() => extractJson(stdout)).toThrow("Blender did not emit the expected JSON payload");
  });

  it("throws on invalid JSON between markers", () => {
    const stdout = `BARRY_JSON_START\nnot valid json\nBARRY_JSON_END`;
    expect(() => extractJson(stdout)).toThrow();
  });
});
