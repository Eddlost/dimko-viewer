import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  clipPlanesForDiagonal,
  DEFAULT_SCENE_DIAGONAL,
  markerScale,
  worldPerPixel,
} from "./screenScale";

const perspective = (fov = 60) => new THREE.PerspectiveCamera(fov, 1, 0.1, 1000);

function ortho(height = 10, zoom = 1): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-5, 5, height / 2, -height / 2);
  cam.zoom = zoom;
  return cam;
}

describe("worldPerPixel", () => {
  it("grows linearly with distance under perspective", () => {
    const cam = perspective();
    const near = worldPerPixel(cam, 600, 10);
    const far = worldPerPixel(cam, 600, 20);
    expect(far).toBeCloseTo(near * 2, 10);
  });

  it("matches the frustum height at a known distance", () => {
    // 90° fov: the visible height equals 2 * distance.
    const value = worldPerPixel(perspective(90), 100, 5);
    expect(value).toBeCloseTo((2 * 5) / 100, 10);
  });

  it("ignores distance under orthographic projection", () => {
    const cam = ortho(10);
    expect(worldPerPixel(cam, 500, 1)).toBeCloseTo(10 / 500, 10);
    expect(worldPerPixel(cam, 500, 1000)).toBeCloseTo(10 / 500, 10);
  });

  it("shrinks with orthographic zoom", () => {
    expect(worldPerPixel(ortho(10, 2), 500, 1)).toBeCloseTo(10 / 500 / 2, 10);
  });

  it("treats a zero-height viewport as one pixel tall", () => {
    expect(Number.isFinite(worldPerPixel(perspective(), 0, 10))).toBe(true);
  });
});

describe("clipPlanesForDiagonal", () => {
  it("puts the near plane well inside arm's reach for a building", () => {
    // 60 m building: you must be able to stand at a wall without it vanishing.
    const { near } = clipPlanesForDiagonal(60);
    expect(near).toBeLessThan(0.1);
    expect(near).toBeGreaterThan(0);
  });

  it("keeps the whole model inside the far plane", () => {
    for (const diagonal of [5, 60, 500]) {
      const { far } = clipPlanesForDiagonal(diagonal);
      expect(far).toBeGreaterThan(diagonal);
    }
  });

  it("caps the near plane so huge sites keep depth precision", () => {
    const { near, far } = clipPlanesForDiagonal(100000);
    expect(near).toBeLessThanOrEqual(0.5);
    // Depth precision degrades with the far/near ratio; keep it bounded.
    expect(far / near).toBeLessThan(1e7);
  });

  it("never lets the dolly limit push the target through the near plane", () => {
    for (const diagonal of [1, 50, 5000]) {
      const { near, minDistance, maxDistance, far } =
        clipPlanesForDiagonal(diagonal);
      expect(minDistance).toBeGreaterThan(near);
      expect(maxDistance).toBeLessThan(far);
      expect(maxDistance).toBeGreaterThan(minDistance);
    }
  });

  it("falls back to the default size for nonsense input", () => {
    const fallback = clipPlanesForDiagonal(DEFAULT_SCENE_DIAGONAL);
    expect(clipPlanesForDiagonal(0)).toEqual(fallback);
    expect(clipPlanesForDiagonal(-1)).toEqual(fallback);
    expect(clipPlanesForDiagonal(Number.NaN)).toEqual(fallback);
    expect(clipPlanesForDiagonal(Number.POSITIVE_INFINITY)).toEqual(fallback);
  });
});

describe("markerScale", () => {
  it("keeps the on-screen radius fixed as the camera pulls away", () => {
    const cam = perspective();
    const height = 600;
    const pixels = 5;

    // The rendered pixel radius is scale / worldPerPixel; it must not drift.
    for (const distance of [1, 10, 100, 5000]) {
      const scale = markerScale(cam, height, distance, pixels)!;
      const renderedPixels = scale / worldPerPixel(cam, height, distance);
      expect(renderedPixels).toBeCloseTo(pixels, 6);
    }
  });

  it("scales down for a smaller authored geometry", () => {
    const cam = perspective();
    const unit = markerScale(cam, 600, 10, 5, 1)!;
    const big = markerScale(cam, 600, 10, 5, 4)!;
    expect(big).toBeCloseTo(unit / 4, 10);
  });

  it("returns null instead of a degenerate scale", () => {
    const cam = perspective();
    expect(markerScale(cam, 600, 0, 5)).toBeNull(); // marker on the camera
    expect(markerScale(cam, 600, 10, 0)).toBeNull(); // zero pixel radius
    expect(markerScale(cam, 600, 10, 5, 0)).toBeNull(); // no geometry radius
  });
});
