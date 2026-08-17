import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { fitPlane, polygonArea, projectToFitPlane } from "./area";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** 3×4 rectangle on the floor (y = 0). */
const floorRect = () => [v(0, 0, 0), v(3, 0, 0), v(3, 0, 4), v(0, 0, 4)];

describe("fitPlane", () => {
  it("finds the plane of a horizontal ring", () => {
    const fit = fitPlane(floorRect())!;
    expect(Math.abs(fit.normal.y)).toBeCloseTo(1);
    expect(fit.origin.y).toBeCloseTo(0);
    expect(fit.deviation).toBeCloseTo(0);
  });

  it("finds the plane of a vertical ring", () => {
    const fit = fitPlane([v(0, 0, 0), v(2, 0, 0), v(2, 5, 0), v(0, 5, 0)])!;
    expect(Math.abs(fit.normal.z)).toBeCloseTo(1);
  });

  it("finds the plane of a tilted ring", () => {
    // 45° roof plane: y rises with z.
    const fit = fitPlane([v(0, 0, 0), v(4, 0, 0), v(4, 3, 3), v(0, 3, 3)])!;
    expect(fit.normal.x).toBeCloseTo(0);
    expect(Math.abs(fit.normal.y)).toBeCloseTo(Math.SQRT1_2);
    expect(fit.deviation).toBeCloseTo(0);
  });

  it("reports how far a non-planar ring strays", () => {
    const fit = fitPlane([v(0, 0, 0), v(4, 0, 0), v(4, 0.2, 4), v(0, 0, 4)])!;
    expect(fit.deviation).toBeGreaterThan(0);
    expect(fit.deviation).toBeLessThan(0.2);
  });

  it("returns null when no plane is defined", () => {
    expect(fitPlane([v(0, 0, 0), v(1, 0, 0)])).toBeNull();
    // Collinear points span a line, not a plane.
    expect(fitPlane([v(0, 0, 0), v(1, 0, 0), v(2, 0, 0)])).toBeNull();
    expect(fitPlane([v(1, 1, 1), v(1, 1, 1), v(1, 1, 1)])).toBeNull();
  });
});

describe("polygonArea", () => {
  it("measures a rectangle on the floor", () => {
    expect(polygonArea(floorRect())).toBeCloseTo(12);
  });

  it("measures a triangle", () => {
    expect(polygonArea([v(0, 0, 0), v(4, 0, 0), v(0, 0, 3)])).toBeCloseTo(6);
  });

  it("measures a vertical wall — an XY projection would report zero", () => {
    expect(
      polygonArea([v(0, 0, 0), v(5, 0, 0), v(5, 2, 0), v(0, 2, 0)]),
    ).toBeCloseTo(10);
  });

  it("measures the true surface of a sloped roof, not its footprint", () => {
    // Runs 4 m wide, rises 3 m over 4 m of depth → slope length 5 m.
    const area = polygonArea([v(0, 0, 0), v(4, 0, 0), v(4, 3, 4), v(0, 3, 4)]);
    expect(area).toBeCloseTo(20);
    // The footprint would be 4 × 4 = 16, which is what a flat projection gives.
    expect(area).not.toBeCloseTo(16);
  });

  it("gives the same answer whichever way round the ring is clicked", () => {
    const forward = polygonArea(floorRect());
    const backward = polygonArea([...floorRect()].reverse());
    expect(backward).toBeCloseTo(forward);
  });

  it("is unaffected by where the model sits in world space", () => {
    const far = floorRect().map((p) => p.clone().add(v(1000, -500, 2500)));
    expect(polygonArea(far)).toBeCloseTo(12);
  });

  it("tolerates points that snapped a millimetre off the plane", () => {
    const noisy = floorRect().map((p, i) =>
      p.clone().add(v(0, i % 2 ? 0.001 : -0.001, 0)),
    );
    expect(polygonArea(noisy)).toBeCloseTo(12, 2);
  });

  it("handles an L-shaped room", () => {
    // 4×4 square with a 2×2 bite taken out of one corner → 12 m².
    const l = [
      v(0, 0, 0),
      v(4, 0, 0),
      v(4, 0, 2),
      v(2, 0, 2),
      v(2, 0, 4),
      v(0, 0, 4),
    ];
    expect(polygonArea(l)).toBeCloseTo(12);
  });

  it("returns zero rather than throwing on a ring that is not one", () => {
    expect(polygonArea([])).toBe(0);
    expect(polygonArea([v(0, 0, 0), v(1, 0, 0)])).toBe(0);
    expect(polygonArea([v(0, 0, 0), v(1, 0, 0), v(2, 0, 0)])).toBe(0);
  });
});

describe("projectToFitPlane", () => {
  it("leaves an already-flat ring where it is", () => {
    const flat = floorRect();
    const out = projectToFitPlane(flat);
    out.forEach((p, i) => expect(p.distanceTo(flat[i])).toBeCloseTo(0));
  });

  it("flattens a ring that strays, keeping the area it reports", () => {
    const bumpy = [v(0, 0, 0), v(4, 0, 0), v(4, 0.2, 4), v(0, 0, 4)];
    const flat = projectToFitPlane(bumpy);
    const fit = fitPlane(flat)!;
    expect(fit.deviation).toBeCloseTo(0);
    expect(polygonArea(flat)).toBeCloseTo(polygonArea(bumpy), 3);
  });

  it("passes a degenerate ring through untouched", () => {
    const line = [v(0, 0, 0), v(1, 0, 0)];
    expect(projectToFitPlane(line).map((p) => p.x)).toEqual([0, 1]);
  });
});
