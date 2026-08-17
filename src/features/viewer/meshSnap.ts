// ────────────────────────────────────────────────────────────────────────────
// Vertex/edge snapping for plain three.js geometry (OBJ models).
//
// IFC models go through fragments, whose worker-side `raycastWithSnapping`
// does this for us. OBJ has no such pipeline: the meshes live on the main
// thread, so we derive snap candidates from the face that was hit and pick the
// one closest to the cursor *in screen space* — snapping must feel the same at
// any zoom level, which world-space distance cannot give you.
// ────────────────────────────────────────────────────────────────────────────

import * as THREE from "three";

export type SnapKind = "vertex" | "edge" | "section" | "surface";

export type SnapCandidate = {
  point: THREE.Vector3;
  kind: SnapKind;
};

/** Cursor position and canvas size, in CSS pixels relative to the canvas. */
export type ScreenFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Project a world point to canvas pixels. Returns null when the point sits
 * behind the camera, where the perspective divide flips the result.
 */
export function projectToScreen(
  point: THREE.Vector3,
  camera: THREE.Camera,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const ndc = point.clone().project(camera);
  if (ndc.z > 1 || ndc.z < -1) return null;
  return {
    x: ((ndc.x + 1) / 2) * width,
    y: ((1 - ndc.y) / 2) * height,
  };
}

/** World-space corners of the triangle that was hit, or null if unavailable. */
function triangleCorners(hit: THREE.Intersection): THREE.Vector3[] | null {
  const face = hit.face;
  const object = hit.object as THREE.Mesh;
  const geometry = object?.geometry as THREE.BufferGeometry | undefined;
  const position = geometry?.attributes?.position as
    | THREE.BufferAttribute
    | undefined;
  if (!face || !position) return null;

  return [face.a, face.b, face.c].map((index) => {
    const v = new THREE.Vector3().fromBufferAttribute(position, index);
    return object.localToWorld(v);
  });
}

/**
 * Where a section plane cuts the hit triangle.
 *
 * A section exposes an edge that exists only on screen — no vertex of the
 * model sits on it — so measuring along a cut is impossible without snapping
 * to it. Each plane crosses the triangle in at most one segment; both its ends
 * and its midpoint are offered.
 */
export function sectionSnapCandidates(
  hit: THREE.Intersection,
  planes: THREE.Plane[],
): SnapCandidate[] {
  if (!planes.length) return [];
  const corners = triangleCorners(hit);
  if (!corners) return [];

  const out: SnapCandidate[] = [];
  for (const plane of planes) {
    const crossings: THREE.Vector3[] = [];
    for (let i = 0; i < 3; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 3];
      const da = plane.distanceToPoint(a);
      const db = plane.distanceToPoint(b);
      // Same side, or an edge lying in the plane (no single crossing point).
      if (da === db || (da > 0 && db > 0) || (da < 0 && db < 0)) continue;
      crossings.push(a.clone().lerp(b, da / (da - db)));
    }
    for (const point of crossings) out.push({ point, kind: "section" });
    if (crossings.length === 2) {
      out.push({
        point: crossings[0].clone().lerp(crossings[1], 0.5),
        kind: "section",
      });
    }
  }
  return out;
}

/**
 * Corner and edge-midpoint candidates of the hit triangle, in world space.
 * Corners come first so that a tie in screen distance resolves to the corner —
 * that is what a user aiming at a box edge expects.
 */
export function faceSnapCandidates(hit: THREE.Intersection): SnapCandidate[] {
  const corners = triangleCorners(hit);
  if (!corners) return [];

  const out: SnapCandidate[] = corners.map((point) => ({
    point,
    kind: "vertex" as const,
  }));
  for (let i = 0; i < 3; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 3];
    out.push({
      point: a.clone().add(b).multiplyScalar(0.5),
      kind: "edge",
    });
  }
  return out;
}

/**
 * Nearest item to the cursor within `thresholdPx`, or null when nothing is
 * close enough (the caller then keeps the raw surface point).
 *
 * Strictly nearest, so equal screen distances resolve to whichever came first
 * in the list — that is how callers express priority between kinds of snap.
 */
export function nearestOnScreen<T extends { point: THREE.Vector3 }>(
  items: T[],
  camera: THREE.Camera,
  frame: ScreenFrame,
  thresholdPx: number,
): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const item of items) {
    const screen = projectToScreen(
      item.point,
      camera,
      frame.width,
      frame.height,
    );
    if (!screen) continue;
    const dx = screen.x - frame.x;
    const dy = screen.y - frame.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= thresholdPx && distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return best;
}

export function chooseSnapCandidate(
  candidates: SnapCandidate[],
  camera: THREE.Camera,
  frame: ScreenFrame,
  thresholdPx: number,
): SnapCandidate | null {
  return nearestOnScreen(candidates, camera, frame, thresholdPx);
}
