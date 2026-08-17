// ────────────────────────────────────────────────────────────────────────────
// Area of a polygon picked in 3D.
//
// The shoelace formula needs a plane, and clicked points never lie in one:
// snapping lands on real geometry, so a floor slab picked at four corners
// comes back a millimetre out of flat. Projecting onto a *fitted* plane
// instead of an axis plane is what keeps a sloped roof or a tilted wall
// honest — an XY projection would report the roof's footprint, not the roof.
//
// The fit is the plane through the centroid whose normal is the direction of
// least spread (the smallest eigenvector of the covariance matrix). For a
// nearly-flat ring that is the polygon's own plane; for a deliberately
// non-planar ring it is the closest thing to one, and the area is the best
// available answer rather than a wrong one.
// ────────────────────────────────────────────────────────────────────────────

import * as THREE from "three";

/** Below this the ring has collapsed and no plane can be fitted from it. */
const DEGENERATE = 1e-12;

export type AreaFit = {
  /** Unit normal of the fitted plane. */
  normal: THREE.Vector3;
  /** Centroid of the points — the plane passes through it. */
  origin: THREE.Vector3;
  /**
   * How far the points stray from the fitted plane, in metres (RMS). Zero for
   * a truly planar ring; the caller can warn when it is large relative to the
   * polygon, which means the area is a projection and not a real surface.
   */
  deviation: number;
};

/**
 * Fit a plane through the points by principal component analysis. Returns null
 * for fewer than three points or a degenerate (collinear / coincident) ring,
 * where no plane is defined.
 */
export function fitPlane(points: THREE.Vector3[]): AreaFit | null {
  if (points.length < 3) return null;

  const origin = new THREE.Vector3();
  for (const p of points) origin.add(p);
  origin.multiplyScalar(1 / points.length);

  // Covariance of the centred points. Symmetric, so six values describe it.
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    const dz = p.z - origin.z;
    xx += dx * dx;
    xy += dx * dy;
    xz += dx * dz;
    yy += dy * dy;
    yz += dy * dz;
    zz += dz * dz;
  }

  // The normal is the least-spread direction. Rather than a general
  // eigensolver, take the cofactor column with the largest determinant: for a
  // plane-like cloud that column IS the normal, and picking the largest keeps
  // it numerically stable whichever axis the plane happens to face.
  const detX = yy * zz - yz * yz;
  const detY = xx * zz - xz * xz;
  const detZ = xx * yy - xy * xy;
  const best = Math.max(detX, detY, detZ);
  if (best <= DEGENERATE) return null;

  let normal: THREE.Vector3;
  if (best === detX) {
    normal = new THREE.Vector3(detX, xz * yz - xy * zz, xy * yz - xz * yy);
  } else if (best === detY) {
    normal = new THREE.Vector3(xz * yz - xy * zz, detY, xy * xz - yz * xx);
  } else {
    normal = new THREE.Vector3(xy * yz - xz * yy, xy * xz - yz * xx, detZ);
  }
  const length = normal.length();
  if (length <= DEGENERATE) return null;
  normal.multiplyScalar(1 / length);

  let sq = 0;
  for (const p of points) {
    const d = normal.dot(p.clone().sub(origin));
    sq += d * d;
  }
  return {
    normal,
    origin,
    deviation: Math.sqrt(sq / points.length),
  };
}

/**
 * Two orthonormal directions spanning the plane with this normal. Which two
 * does not matter — area and shape are invariant to the choice — but they must
 * be orthonormal, and the helper axis has to avoid being parallel to the
 * normal or the cross product collapses.
 */
export function planeBasis(normal: THREE.Vector3): {
  u: THREE.Vector3;
  v: THREE.Vector3;
} {
  const helper =
    Math.abs(normal.x) < 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(normal, helper).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u);
  return { u, v };
}

/**
 * Area of the ring `points` in square metres, measured in its own best-fit
 * plane. Returns 0 for fewer than three points or a degenerate ring.
 *
 * The ring is treated as closed — the last point joins back to the first — and
 * the sign of the shoelace sum is discarded, so clicking clockwise and
 * anticlockwise give the same answer. Self-intersecting rings get the signed
 * sum of their loops, which is what shoelace means and is the honest result of
 * a bow-tie: the caller should not pretend otherwise.
 */
export function polygonArea(points: THREE.Vector3[]): number {
  const fit = fitPlane(points);
  if (!fit) return 0;

  const { u, v } = planeBasis(fit.normal);

  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i].clone().sub(fit.origin);
    const b = points[(i + 1) % n].clone().sub(fit.origin);
    sum += a.dot(u) * b.dot(v) - b.dot(u) * a.dot(v);
  }
  return Math.abs(sum) / 2;
}

/**
 * Points of the ring pushed onto the fitted plane, for drawing. The outline
 * has to be flat or it reads as a crumpled ribbon over the model; the numbers
 * come from `polygonArea`, which measures the same projection.
 */
export function projectToFitPlane(points: THREE.Vector3[]): THREE.Vector3[] {
  const fit = fitPlane(points);
  if (!fit) return points.map((p) => p.clone());
  return points.map((p) => {
    const offset = fit.normal.dot(p.clone().sub(fit.origin));
    return p.clone().addScaledVector(fit.normal, -offset);
  });
}
