import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CLIP_PICK_TOLERANCE, insideClipPlanes } from "./clipping";

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
