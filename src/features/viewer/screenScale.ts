// ────────────────────────────────────────────────────────────────────────────
// Keeping markers a constant size on screen.
//
// A snap reticle or measurement dot authored in world units is a dot when you
// zoom out and swallows the model when you zoom in. Since the whole point of
// those markers is to show *where a measurement will land*, their size has to
// be expressed in pixels and converted back to world units every frame.
// ────────────────────────────────────────────────────────────────────────────

import * as THREE from "three";

/**
 * World-space size that one screen pixel covers.
 *
 * Perspective: the view frustum widens with distance, so the answer depends on
 * how far the marker is from the camera. Orthographic: it is constant, set by
 * the frustum height and zoom.
 */
export function worldPerPixel(
  camera: THREE.Camera,
  viewportHeight: number,
  distance: number,
): number {
  const height = viewportHeight > 0 ? viewportHeight : 1;
  const perspective = camera as THREE.PerspectiveCamera;
  if (perspective.isPerspectiveCamera) {
    return (2 * Math.tan((perspective.fov * Math.PI) / 360) * distance) / height;
  }
  const ortho = camera as THREE.OrthographicCamera;
  const zoom = ortho.zoom || 1;
  return (ortho.top - ortho.bottom) / (height * zoom);
}

/**
 * Scale factor that renders a `geometryRadius`-sized object at `pixelRadius`
 * pixels. Returns null when the inputs cannot produce a usable scale (marker
 * sitting exactly on the camera, zero-height viewport) so callers can leave
 * the previous scale alone rather than collapse the object to nothing.
 */
export function markerScale(
  camera: THREE.Camera,
  viewportHeight: number,
  distance: number,
  pixelRadius: number,
  geometryRadius = 1,
): number | null {
  if (geometryRadius <= 0) return null;
  const scale =
    (pixelRadius * worldPerPixel(camera, viewportHeight, distance)) /
    geometryRadius;
  return scale > 0 && Number.isFinite(scale) ? scale : null;
}
