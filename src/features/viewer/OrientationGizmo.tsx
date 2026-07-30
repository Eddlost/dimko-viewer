import { useEffect, useRef } from "react";
import * as THREE from "three";
import { ViewportGizmo } from "three-viewport-gizmo";
import { useViewerContext } from "./ViewerContext";

// Orientation cube top-right corner of viewport. Wires the gizmo into the
// thatopen world's camera + Yomotsu CameraControls so face clicks snap to
// top/front/side/etc. and dragging the cube rotates the main camera.
//
// On face snap we detect axis-aligned views (camera direction collapses to
// ±X, ±Y or ±Z) and switch the world camera projection to Orthographic so
// 2D views render "flat" without perspective foreshortening. Any other
// orientation falls back to Perspective for normal 3D orbit.
export function OrientationGizmo() {
  const { ready, getWorld } = useViewerContext();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ready) return;
    const world = getWorld();
    const container = containerRef.current;
    if (!world || !container) return;

    const worldCam: any = world.camera;
    const controls: any = worldCam?.controls;
    const renderer = world.renderer?.three;
    if (!worldCam || !controls || !renderer) return;

    const gizmo = new ViewportGizmo(worldCam.three, renderer, {
      container,
      type: "cube",
      size: 96,
      placement: "top-right",
      offset: { top: 0, right: 0, left: 0, bottom: 0 },
      // Disable face-snap tween. ViewportGizmo's animation is designed around
      // perspective FOV math and produces unstable end positions when the
      // active camera is orthographic — clicking TOP repeatedly while in
      // Ortho mode visibly jerked the model. Instant snap is also more
      // CAD-conventional (Revit / AutoCAD snap without animation).
      animated: false,
      // Labeled axis spokes on the cube. Fragments loads IFC as Y-up, so the
      // composition stack / gravity axis is world Y (the top face) — surfacing
      // X/Y/Z lets the user pick the right stack axis in the pipelines.
      x: { label: "X", line: true, color: 0xef4444, labelColor: 0xffffff },
      y: { label: "Y", line: true, color: 0x22c55e, labelColor: 0x06210f },
      z: { label: "Z", line: true, color: 0x3b82f6, labelColor: 0xffffff },
      nx: { label: "", line: true, color: 0xef4444, opacity: 0.4 },
      ny: { label: "", line: true, color: 0x22c55e, opacity: 0.4 },
      nz: { label: "", line: true, color: 0x3b82f6, opacity: 0.4 },
    } as any);

    const isAxisAligned = (cam: THREE.Camera): boolean => {
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      const ax = Math.abs(dir.x);
      const ay = Math.abs(dir.y);
      const az = Math.abs(dir.z);
      const max = Math.max(ax, ay, az);
      const sum = ax + ay + az;
      return max > 0.999 && sum - max < 0.01;
    };

    // The jerk on repeated TOP clicks came from two overlapping animations:
    //   (1) gizmo's own face-snap tween (manipulates camera.position)
    //   (2) ProjectionManager.set ortho↔persp transition (swaps camera refs)
    // If (2) is launched while (1)'s onChange callbacks keep firing and
    // pushing controls.setPosition based on a now-stale activeCamera ref,
    // controls thrash. Solution: freeze controls + skip onChange during
    // projection swap, and always read the LIVE camera (worldCam.three)
    // instead of a closure-captured ref.
    let pendingProjection: Promise<void> | null = null;
    let swapping = false;

    const onStart = () => {
      controls.enabled = false;
    };
    const onEnd = () => {
      if (swapping) return;
      controls.enabled = true;
      if (!worldCam.projection?.set) return;
      const want = isAxisAligned(worldCam.three)
        ? "Orthographic"
        : "Perspective";
      if (worldCam.projection.current === want) return;
      if (pendingProjection) return;
      swapping = true;
      controls.enabled = false;
      pendingProjection = worldCam.projection
        .set(want)
        .catch((e: any) => console.warn("[gizmo] projection.set failed", e))
        .finally(() => {
          pendingProjection = null;
          swapping = false;
          controls.enabled = true;
        });
    };

    const onChange = () => {
      // Mid-swap controls/camera state is inconsistent — driving setPosition
      // here would race the projection transition.
      if (swapping) return;
      controls.setPosition(...worldCam.three.position.toArray());
    };
    const onControlsUpdate = () => {
      if (swapping) return;
      controls.getTarget(gizmo.target);
      gizmo.update();
    };

    gizmo.addEventListener("start", onStart);
    gizmo.addEventListener("end", onEnd);
    gizmo.addEventListener("change", onChange);
    controls.addEventListener("update", onControlsUpdate);

    // Re-bind gizmo's internal camera reference when projection swaps so
    // subsequent face clicks animate the now-active camera, not the stale
    // (pre-swap) one.
    const onProjectionChanged = () => {
      try {
        (gizmo as any).camera = worldCam.three;
        (gizmo as any).cameraUpdate?.();
      } catch (e) {
        console.warn("[gizmo] camera rebind failed", e);
      }
    };
    worldCam.projection?.onChanged?.add(onProjectionChanged);

    let raf = 0;
    const loop = () => {
      if (!swapping) gizmo.render();
      raf = requestAnimationFrame(loop);
    };
    loop();

    const onResize = () => gizmo.update();
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      gizmo.removeEventListener("start", onStart);
      gizmo.removeEventListener("end", onEnd);
      gizmo.removeEventListener("change", onChange);
      controls.removeEventListener("update", onControlsUpdate);
      worldCam.projection?.onChanged?.remove(onProjectionChanged);
      gizmo.dispose?.();
    };
  }, [ready, getWorld]);

  return (
    <div
      ref={containerRef}
      className="absolute top-3 right-3 w-24 h-24 pointer-events-auto"
    />
  );
}
