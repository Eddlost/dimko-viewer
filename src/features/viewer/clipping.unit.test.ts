import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  CLIP_PICK_TOLERANCE,
  insideClipPlanes,
  sectionCutPoints,
} from "./clipping";

// Keeps the half-space y >= 0.
const floor = () => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
// Keeps the half-space x <= 2.
const wall = () => new THREE.Plane(new THREE.Vector3(-1, 0, 0), 2);

describe("insideClipPlanes", () => {
  it("passes everything when no plane is active", () => {
    expect(insideClipPlanes(new THREE.Vector3(0, -100, 0), [])).toBe(true);
  });

  it("keeps the visible side and drops the cut-away side", () => {
    expect(insideClipPlanes(new THREE.Vector3(0, 1, 0), [floor()])).toBe(true);
    expect(insideClipPlanes(new THREE.Vector3(0, -1, 0), [floor()])).toBe(false);
  });

  it("requires the point to survive every plane, not just one", () => {
    const planes = [floor(), wall()];
    expect(insideClipPlanes(new THREE.Vector3(1, 1, 0), planes)).toBe(true);
    // Above the floor but past the wall.
    expect(insideClipPlanes(new THREE.Vector3(5, 1, 0), planes)).toBe(false);
    // Behind the floor but inside the wall.
    expect(insideClipPlanes(new THREE.Vector3(1, -1, 0), planes)).toBe(false);
  });

  it("keeps points sitting exactly on a plane — that is the section snap", () => {
    expect(insideClipPlanes(new THREE.Vector3(0, 0, 0), [floor()])).toBe(true);
    // Float error of the size a plane/edge intersection produces.
    const jitter = -CLIP_PICK_TOLERANCE / 2;
    expect(insideClipPlanes(new THREE.Vector3(0, jitter, 0), [floor()])).toBe(
      true,
    );
  });

  it("still drops a point that is behind by more than the tolerance", () => {
    const behind = new THREE.Vector3(0, -CLIP_PICK_TOLERANCE * 10, 0);
    expect(insideClipPlanes(behind, [floor()])).toBe(false);
  });

  it("passes a hit that carries no point rather than losing it", () => {
    expect(insideClipPlanes(undefined, [floor()])).toBe(true);
    expect(insideClipPlanes(null, [floor()])).toBe(true);
  });
});

describe("sectionCutPoints", () => {
  // Ray down +x from the origin; plane keeps x >= 5, so the cut sits at x = 5.
  const ray = () =>
    new THREE.Ray(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0));
  const cutAtX = (x: number) =>
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -x);
  const hit = (distance: number, localId = 1, modelId = "m1") => ({
    distance,
    localId,
    modelId,
  });

  it("finds the cut face where the plane passes through an element", () => {
    // Wall spans x = 2..8, so the ray crosses its cut face at x = 5.
    const found = sectionCutPoints([hit(2), hit(8)], [cutAtX(5)], ray());
    expect(found).toHaveLength(1);
    expect(found[0].point.x).toBeCloseTo(5);
    expect(found[0].distance).toBeCloseTo(5);
    expect(found[0].localId).toBe(1);
    expect(found[0].modelId).toBe("m1");
  });

  it("ignores an element the plane misses entirely", () => {
    // Wall spans x = 6..8; the plane at x = 5 is in front of it, not through.
    expect(sectionCutPoints([hit(6), hit(8)], [cutAtX(5)], ray())).toEqual([]);
  });

  it("ignores an element with no extent along the ray", () => {
    // One hit = a graze, not a solid the plane can open a face in.
    expect(sectionCutPoints([hit(5)], [cutAtX(5)], ray())).toEqual([]);
  });

  it("reports the element the plane actually cuts, not its neighbour", () => {
    const hits = [hit(2, 1), hit(8, 1), hit(20, 2), hit(30, 2)];
    const found = sectionCutPoints(hits, [cutAtX(5)], ray());
    expect(found.map((f) => f.localId)).toEqual([1]);
  });

  it("separates elements by model as well as by id", () => {
    const hits = [
      hit(2, 1, "m1"),
      hit(8, 1, "m1"),
      hit(3, 1, "m2"),
      hit(9, 1, "m2"),
    ];
    const found = sectionCutPoints(hits, [cutAtX(5)], ray());
    expect(found.map((f) => f.modelId).sort()).toEqual(["m1", "m2"]);
  });

  it("drops a cut point that a second plane has removed", () => {
    // Cut at x = 5, but a second plane keeps only x >= 6.
    const found = sectionCutPoints(
      [hit(2), hit(8)],
      [cutAtX(5), cutAtX(6)],
      ray(),
    );
    // The x = 5 point is behind the second plane; the x = 6 point is inside
    // the same span and survives.
    expect(found).toHaveLength(1);
    expect(found[0].point.x).toBeCloseTo(6);
  });

  it("ignores a plane the ray never reaches", () => {
    const behind = new THREE.Plane(new THREE.Vector3(1, 0, 0), 5); // x >= -5
    expect(sectionCutPoints([hit(2), hit(8)], [behind], ray())).toEqual([]);
  });

  it("returns nothing without planes or without a span to cut", () => {
    expect(sectionCutPoints([hit(2), hit(8)], [], ray())).toEqual([]);
    expect(sectionCutPoints([], [cutAtX(5)], ray())).toEqual([]);
  });
});
