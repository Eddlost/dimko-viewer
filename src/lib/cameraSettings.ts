/** Camera preferences, remembered between sessions. */

export type Projection = "perspective" | "orthographic";

export type CameraSettings = {
  projection: Projection;
  fov: number;
};

const STORAGE_KEY = "dimko-viewer-camera-v1";

/**
 * Orthographic by default: it has no perspective distortion at all, which is
 * what you want when reading a model rather than presenting it. Perspective is
 * one click away in the camera panel.
 */
export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  projection: "orthographic",
  fov: 35,
};

/** Tolerated field-of-view range; also the clamp used when reading storage. */
export const MIN_FOV = 15;
export const MAX_FOV = 80;

/**
 * Parsing is defensive on purpose — the value is user-writable (devtools, a
 * stale build, a hand-edited profile) and a bad number would put the camera in
 * an unrecoverable state that only clearing site data could fix.
 */
export function parseCameraSettings(raw: string | null): CameraSettings {
  if (!raw) return DEFAULT_CAMERA_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_CAMERA_SETTINGS;
  }
  if (!parsed || typeof parsed !== "object") return DEFAULT_CAMERA_SETTINGS;

  const record = parsed as Record<string, unknown>;
  const projection: Projection =
    record.projection === "perspective" || record.projection === "orthographic"
      ? record.projection
      : DEFAULT_CAMERA_SETTINGS.projection;

  const rawFov = Number(record.fov);
  const fov = Number.isFinite(rawFov)
    ? Math.min(Math.max(rawFov, MIN_FOV), MAX_FOV)
    : DEFAULT_CAMERA_SETTINGS.fov;

  return { projection, fov };
}

export function loadCameraSettings(): CameraSettings {
  try {
    return parseCameraSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_CAMERA_SETTINGS; // private mode / storage disabled
  }
}

export function saveCameraSettings(settings: CameraSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* quota or private mode — preferences just won't stick */
  }
}

/**
 * Where camera preferences live. The free viewer keeps them in localStorage;
 * an embedder with its own settings file (a project manifest, say) supplies its
 * own store, or passes `null` to the viewer to not persist at all.
 */
export type CameraSettingsStore = {
  load: () => CameraSettings | null;
  save: (settings: CameraSettings) => void;
};

export const localStorageCameraStore: CameraSettingsStore = {
  load: loadCameraSettings,
  save: saveCameraSettings,
};
