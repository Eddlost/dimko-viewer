import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { markerScale, worldPerPixel } from "./screenScale";

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
