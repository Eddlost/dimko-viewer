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

/** One ray hit reduced to what a cut-face test needs. */
export type SpanHit = {
  /** Distance along the ray. */
  distance: number;
  modelId?: string;
  localId?: number;
};

export type SectionCutPoint = {
  point: THREE.Vector3;
  distance: number;
  modelId?: string;
  localId?: number;
};

/**
 * Where the ray crosses the flat face a section cut opened in an element.
 *
 * That face is the one surface a user most wants to measure from, and it is
 * the one surface that does not exist: the clipper paints it on the GPU, no
 * triangle is there to hit. So it has to be derived — the ray meets the plane
 * at one point, and that point is on a real cut face exactly when it lies
 * *inside* some element, i.e. between that element's near and far hits. An
 * element the ray only grazes (one hit, no span) has no cut face and is
 * correctly skipped.
 *
 * Points cut away by another plane are dropped; the plane being crossed keeps
 * its own point via the tolerance in `insideClipPlanes`.
 */
export function sectionCutPoints(
  hits: SpanHit[],
  planes: THREE.Plane[],
  ray: THREE.Ray,
): SectionCutPoint[] {
  if (!planes.length || hits.length < 2) return [];

  // Near/far hit per element — its extent along this ray.
  const spans = new Map<
    string,
    { min: number; max: number; modelId?: string; localId?: number }
  >();
  for (const h of hits) {
    if (!Number.isFinite(h.distance)) continue;
    const key = `${h.modelId ?? ""}|${h.localId ?? ""}`;
    const span = spans.get(key);
    if (!span) {
      spans.set(key, {
        min: h.distance,
        max: h.distance,
        modelId: h.modelId,
        localId: h.localId,
      });
      continue;
    }
    if (h.distance < span.min) span.min = h.distance;
    if (h.distance > span.max) span.max = h.distance;
  }

  const out: SectionCutPoint[] = [];
  for (const plane of planes) {
    const t = ray.distanceToPlane(plane);
    if (t === null || !Number.isFinite(t)) continue;
    const point = ray.at(t, new THREE.Vector3());
    if (!insideClipPlanes(point, planes)) continue;
    for (const span of spans.values()) {
      if (span.min >= t || t >= span.max) continue;
      out.push({
        point: point.clone(),
        distance: t,
        modelId: span.modelId,
        localId: span.localId,
      });
    }
  }
  return out;
}
