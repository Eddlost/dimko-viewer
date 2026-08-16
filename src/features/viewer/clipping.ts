// ────────────────────────────────────────────────────────────────────────────
// Which side of the active section planes a picked point falls on.
//
// Section planes only remove geometry on the GPU: the raycast data still holds
// the half the cut took away, so without this test a click on a cut face picks
// an element that is not on screen. Pure and unit-tested because the sign
// convention is easy to get backwards and the failure mode is silent.
// ────────────────────────────────────────────────────────────────────────────

import * as THREE from "three";

/**
 * Half a millimetre of slack. Section snap candidates are constructed to lie
 * exactly ON a plane, so an exact `>= 0` test throws them away on float error
 * — which would make the cut edge, the most useful thing to measure from,
 * unpickable.
 */
export const CLIP_PICK_TOLERANCE = 5e-4;

/**
 * True when `point` survives every plane. three.js keeps the half-space where
 * `distanceToPoint >= 0`, so that is the side a visible hit must be on.
 *
 * No planes ⇒ nothing to filter. A hit without a point cannot be judged, and
 * dropping it would silently lose selections, so it passes.
 */
export function insideClipPlanes(
  point: THREE.Vector3 | null | undefined,
  planes: THREE.Plane[],
): boolean {
  if (!point || !planes.length) return true;
  return planes.every(
    (plane) => plane.distanceToPoint(point) >= -CLIP_PICK_TOLERANCE,
  );
}
