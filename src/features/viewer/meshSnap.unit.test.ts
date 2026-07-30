import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  chooseSnapCandidate,
  faceSnapCandidates,
  projectToScreen,
  type SnapCandidate,
} from "./meshSnap";

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

/** Unit triangle in the XY plane, hit on its first face. */
function triangleHit(offset = new THREE.Vector3()): THREE.Intersection {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 2, 0], 3),
  );
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.position.copy(offset);
  mesh.updateMatrixWorld(true);
  return {
    distance: 1,
    point: new THREE.Vector3(0.5, 0.5, 0).add(offset),
    object: mesh,
    // The raycaster hands back a plain record, not a class instance.
    face: { a: 0, b: 1, c: 2, normal: new THREE.Vector3(0, 0, 1), materialIndex: 0 },
  } as unknown as THREE.Intersection;
}

describe("projectToScreen", () => {
  it("puts the origin at the canvas centre", () => {
    const screen = projectToScreen(new THREE.Vector3(0, 0, 0), camera(), 800, 600);
    expect(screen).not.toBeNull();
    expect(screen!.x).toBeCloseTo(400, 5);
    expect(screen!.y).toBeCloseTo(300, 5);
  });

  it("flips the y axis (world up = screen up)", () => {
    const screen = projectToScreen(new THREE.Vector3(0, 1, 0), camera(), 800, 600);
    expect(screen!.y).toBeLessThan(300);
  });

  it("rejects points behind the camera", () => {
    expect(
      projectToScreen(new THREE.Vector3(0, 0, 200), camera(), 800, 600),
    ).toBeNull();
  });
});

describe("faceSnapCandidates", () => {
  it("returns three corners then three edge midpoints", () => {
    const candidates = faceSnapCandidates(triangleHit());
    expect(candidates.map((c) => c.kind)).toEqual([
      "vertex",
      "vertex",
      "vertex",
      "edge",
      "edge",
      "edge",
    ]);
    expect(candidates[1].point.toArray()).toEqual([2, 0, 0]);
    // midpoint of (0,0,0)-(2,0,0)
    expect(candidates[3].point.toArray()).toEqual([1, 0, 0]);
  });

  it("applies the mesh world transform", () => {
    const candidates = faceSnapCandidates(triangleHit(new THREE.Vector3(5, 0, 0)));
    expect(candidates[0].point.toArray()).toEqual([5, 0, 0]);
    expect(candidates[1].point.toArray()).toEqual([7, 0, 0]);
  });

  it("returns nothing when the hit carries no face", () => {
    const hit = triangleHit();
    (hit as any).face = null;
    expect(faceSnapCandidates(hit)).toEqual([]);
  });
});

describe("chooseSnapCandidate", () => {
  const cam = camera();
  const frame = (x: number, y: number) => ({ x, y, width: 800, height: 600 });

  const candidates: SnapCandidate[] = [
    { point: new THREE.Vector3(0, 0, 0), kind: "vertex" },
    { point: new THREE.Vector3(2, 0, 0), kind: "vertex" },
  ];

  it("snaps to the candidate under the cursor", () => {
    const chosen = chooseSnapCandidate(candidates, cam, frame(402, 301), 12);
    expect(chosen?.point.toArray()).toEqual([0, 0, 0]);
  });

  it("returns null when everything is beyond the threshold", () => {
    expect(chooseSnapCandidate(candidates, cam, frame(10, 10), 12)).toBeNull();
  });

  it("picks the nearest of several in-range candidates", () => {
    const origin = projectToScreen(candidates[0].point, cam, 800, 600)!;
    const other = projectToScreen(candidates[1].point, cam, 800, 600)!;
    // Sit just off the second candidate, still within reach of both.
    const gap = Math.abs(other.x - origin.x);
    const chosen = chooseSnapCandidate(
      candidates,
      cam,
      frame(other.x - 1, other.y),
      gap,
    );
    expect(chosen?.point.toArray()).toEqual([2, 0, 0]);
  });

  it("prefers the corner when a corner and an edge midpoint tie", () => {
    const corner = new THREE.Vector3(0, 0, 0);
    const tied: SnapCandidate[] = [
      { point: corner, kind: "vertex" },
      { point: corner.clone(), kind: "edge" },
    ];
    const screen = projectToScreen(corner, cam, 800, 600)!;
    const chosen = chooseSnapCandidate(tied, cam, frame(screen.x, screen.y), 12);
    expect(chosen?.kind).toBe("vertex");
  });
});
