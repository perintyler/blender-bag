import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFrames } from "./exec.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "barry-blender-test-"));
}

describe("listFrames", () => {
  it("returns empty array for nonexistent directory", () => {
    expect(listFrames("/nonexistent/path/xyz")).toEqual([]);
  });

  it("returns empty array for empty directory", () => {
    const dir = makeTempDir();
    expect(listFrames(dir)).toEqual([]);
  });

  it("filters out non-PNG files", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "f_001.png"), "");
    writeFileSync(join(dir, "readme.txt"), "");
    writeFileSync(join(dir, "scene.blend"), "");
    writeFileSync(join(dir, "f_002.jpg"), "");

    const result = listFrames(dir);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("f_001.png");
  });

  it("sorts numerically, not lexicographically", () => {
    const dir = makeTempDir();
    // Without numeric sort, "f_10" would come before "f_2"
    writeFileSync(join(dir, "f_1.png"), "");
    writeFileSync(join(dir, "f_2.png"), "");
    writeFileSync(join(dir, "f_10.png"), "");
    writeFileSync(join(dir, "f_20.png"), "");
    writeFileSync(join(dir, "f_3.png"), "");

    const result = listFrames(dir);
    expect(result.map((p) => p.split("/").pop())).toEqual([
      "f_1.png",
      "f_2.png",
      "f_3.png",
      "f_10.png",
      "f_20.png",
    ]);
  });

  it("returns absolute paths", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "f_001.png"), "");

    const result = listFrames(dir);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(join(dir, "f_001.png"));
  });

  it("handles zero-padded frame numbers", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "f_0001.png"), "");
    writeFileSync(join(dir, "f_0002.png"), "");
    writeFileSync(join(dir, "f_0010.png"), "");

    const result = listFrames(dir);
    expect(result.map((p) => p.split("/").pop())).toEqual([
      "f_0001.png",
      "f_0002.png",
      "f_0010.png",
    ]);
  });

  it("is case-insensitive on .PNG extension", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "f_001.PNG"), "");
    writeFileSync(join(dir, "f_002.png"), "");

    const result = listFrames(dir);
    expect(result).toHaveLength(2);
  });
});
