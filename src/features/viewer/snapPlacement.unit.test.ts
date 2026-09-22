import { describe, it, expect } from "vitest";
import { previewForClick } from "./snapPlacement";

const corner = { id: "corner" };

describe("previewForClick", () => {
  it("places the point the reticle was showing when the cursor has not moved", () => {
    const got = previewForClick(
      { mouse: { x: 400, y: 300 }, result: corner },
      { x: 400, y: 300 },
      3,
    );
    expect(got).toBe(corner);
  });

  // The bug: a click a couple of pixels off used to re-pick and could resolve
  // to a different vertex than the one under the reticle.
  it("tolerates the pixel or two a click costs", () => {
    const got = previewForClick(
      { mouse: { x: 400, y: 300 }, result: corner },
      { x: 402, y: 301 },
      3,
    );
    expect(got).toBe(corner);
  });

  it("gives up once the cursor has left the previewed spot", () => {
    const got = previewForClick(
      { mouse: { x: 400, y: 300 }, result: corner },
      { x: 420, y: 300 },
      3,
    );
    expect(got).toBeNull();
  });

  it("measures diagonally, not per axis", () => {
    // 3px right and 3px down is 4.24px away — outside a 3px threshold, even
    // though neither axis alone exceeds it.
    const got = previewForClick(
      { mouse: { x: 400, y: 300 }, result: corner },
      { x: 403, y: 303 },
      3,
    );
    expect(got).toBeNull();
  });

  it("asks for a fresh pick when nothing was previewed", () => {
    expect(previewForClick(null, { x: 400, y: 300 }, 3)).toBeNull();
  });
});
