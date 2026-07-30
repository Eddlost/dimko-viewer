import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMERA_SETTINGS,
  MAX_FOV,
  MIN_FOV,
  parseCameraSettings,
} from "./cameraSettings";

describe("parseCameraSettings", () => {
  it("defaults to orthographic so nothing is distorted out of the box", () => {
    expect(DEFAULT_CAMERA_SETTINGS.projection).toBe("orthographic");
    expect(parseCameraSettings(null)).toEqual(DEFAULT_CAMERA_SETTINGS);
  });

  it("round-trips a valid payload", () => {
    const raw = JSON.stringify({ projection: "perspective", fov: 42 });
    expect(parseCameraSettings(raw)).toEqual({
      projection: "perspective",
      fov: 42,
    });
  });

  it("falls back on anything unparseable", () => {
    for (const raw of ["", "not json", "[]", "null", '"perspective"', "7"]) {
      expect(parseCameraSettings(raw)).toEqual(DEFAULT_CAMERA_SETTINGS);
    }
  });

  it("rejects an unknown projection but keeps a valid fov", () => {
    const raw = JSON.stringify({ projection: "isometric", fov: 50 });
    expect(parseCameraSettings(raw)).toEqual({
      projection: DEFAULT_CAMERA_SETTINGS.projection,
      fov: 50,
    });
  });

  it("clamps a field of view that would wreck the view", () => {
    const low = parseCameraSettings(JSON.stringify({ fov: 1 }));
    const high = parseCameraSettings(JSON.stringify({ fov: 1000 }));
    expect(low.fov).toBe(MIN_FOV);
    expect(high.fov).toBe(MAX_FOV);
  });

  it("ignores a non-numeric fov", () => {
    const raw = JSON.stringify({ projection: "perspective", fov: "wide" });
    expect(parseCameraSettings(raw).fov).toBe(DEFAULT_CAMERA_SETTINGS.fov);
  });
});
