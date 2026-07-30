import { useCallback, useEffect, useRef, useState } from "react";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import {
  buildPropertyIndex,
  type BuildProgress,
  type PropertyIndex,
} from "../properties/propertyIndex";
import {
  chooseSnapshotMode,
  filterSelectionBySnapshot,
  type VisibilitySnapshotEntry,
} from "./visibility";
import {
  chooseSnapCandidate,
  faceSnapCandidates,
  sectionSnapCandidates,
} from "./meshSnap";
import {
  clipPlanesForDiagonal,
  markerScale,
  DEFAULT_SCENE_DIAGONAL,
  type ClipPlanes,
} from "./screenScale";
import {
  loadCameraSettings,
  saveCameraSettings,
  MAX_FOV,
  MIN_FOV,
  type Projection,
} from "../../lib/cameraSettings";
import {
  disposeMeshModel,
  idsForModel,
  isObjectVisible,
  isolateMeshParts,
  meshModelsBounds,
  parseObj,
  setMeshPartsVisible,
  type MeshModel,
} from "./objModel";

/// One section cut: `normal` plus a coplanar `point` rebuild the clipping
/// plane through createFromNormalAndCoplanarPoint.
export type SavedViewClip = {
  normal: [number, number, number];
  point: [number, number, number];
};

// web-ifc konstanty (import celého web-ifc jen kvůli konstantám by natáhl
// WASM binding modul do bundle).
const WEBIFC_IFCGROUP = 2706460486;
const WEBIFC_IFCRELASSIGNSTOGROUP = 1307041759;

export type LoadedModel = {
  id: string;
  name: string;
  /** "ifc" = fragments model (worker-side), "obj" = plain three.js geometry. */
  kind: "ifc" | "obj";
};

/** Screen-space radius, in CSS pixels, within which an OBJ vertex snaps. */
const MESH_SNAP_RADIUS_PX = 14;

export type { Projection } from "../../lib/cameraSettings";

// Result of a snap-aware pick: world point (snapped to a vertex when one is
// in range, else the raw surface hit), the element it belongs to, and whether
// the point actually snapped to a vertex (drives the hover reticle colour).
type SnapResult = {
  point: THREE.Vector3;
  localId: number;
  modelId: string | undefined;
  normal?: THREE.Vector3;
  snapped: boolean;
};

// SnappingClass.POINT from @thatopen/fragments. The enum lives in the
// transitive fragments package (not a direct dep), so we use the numeric
// literal: POINT = 0, LINE = 1, FACE = 2.
const SNAP_CLASS_POINT = 0;

type SpatialTreeNode = {
  category: string | null;
  localId: number | null;
  children?: SpatialTreeNode[];
};

async function buildInclusiveStoreys(
  model: any,
): Promise<Map<string, Set<number>>> {
  const result = new Map<string, Set<number>>();
  if (!model || typeof model.getSpatialStructure !== "function") return result;
  let root: SpatialTreeNode | null = null;
  try {
    root = await model.getSpatialStructure();
  } catch (e) {
    console.warn("[viewer] getSpatialStructure failed", e);
    return result;
  }
  if (!root) return result;

  const storeyNodes: { localId: number; ids: Set<number> }[] = [];
  const collect = (node: SpatialTreeNode, current?: { ids: Set<number> }) => {
    if (node.category === "IFCBUILDINGSTOREY" && node.localId !== null) {
      const bucket = { localId: node.localId, ids: new Set<number>() };
      bucket.ids.add(node.localId);
      storeyNodes.push(bucket);
      current = bucket;
    } else if (current && node.localId !== null) {
      current.ids.add(node.localId);
    }
    if (node.children) {
      for (const child of node.children) collect(child, current);
    }
  };
  collect(root);

  if (!storeyNodes.length) return result;

  try {
    const ids = storeyNodes.map((s) => s.localId);
    const datas = await model.getItemsData(ids, {
      attributesDefault: true,
    });
    for (let i = 0; i < storeyNodes.length; i++) {
      const name =
        datas?.[i]?.Name?.value ??
        datas?.[i]?.LongName?.value ??
        `Storey ${storeyNodes[i].localId}`;
      result.set(String(name), storeyNodes[i].ids);
    }
  } catch (e) {
    console.warn("[viewer] storey name lookup failed", e);
  }
  return result;
}

export type SelectionTarget = { modelId: string; localId: number } | null;

export type VisibilityMap = Record<string, number[]>;

export type { VisibilitySnapshotEntry } from "./visibility";

export function useViewer(containerRef: React.RefObject<HTMLDivElement | null>) {
  const componentsRef = useRef<OBC.Components | null>(null);
  const worldRef = useRef<any>(null);
  const fragmentsRef = useRef<OBC.FragmentsManager | null>(null);
  const highlighterRef = useRef<OBF.Highlighter | null>(null);
  const hiderRef = useRef<OBC.Hider | null>(null);
  const clipperRef = useRef<OBC.Clipper | null>(null);
  const clipModeRef = useRef(false);
  // Custom measurement state. We don't use OBF.LengthMeasurement because its
  // vertex-snap pipeline depends on a sequence of init steps (Raycasters,
  // CSS2D, pointer parentElement handlers) that proved finicky in our setup
  // — snap markers never appeared. The fragments.raycast path is the same
  // one we use for click selection and is known to hit. So we build a tiny
  // 2-click measurement on top of it instead.
  const measureModeRef = useRef(false);
  const measureAnchorRef = useRef<THREE.Vector3 | null>(null);
  const measureGroupRef = useRef<THREE.Group | null>(null);
  const measureAnchorVisualRef = useRef<THREE.Object3D | null>(null);
  // Volume measurement — click N corners, finalize on Enter / "Hotovo".
  // Points accumulate, sphere markers parented to measureGroup so
  // deleteAllMeasurements clears them together with distance measurements.
  const volumeModeRef = useRef(false);
  const volumePointsRef = useRef<THREE.Vector3[]>([]);
  const volumeMarkersRef = useRef<THREE.Object3D[]>([]);
  // Lazy-bound callback refs so keydown handler installed inside the
  // useEffect can call finalize/cancel/undo defined as useCallback below.
  const finalizeVolumeRef = useRef<(() => void) | null>(null);
  const cancelVolumeRef = useRef<(() => void) | null>(null);
  const undoVolumePointRef = useRef<(() => void) | null>(null);
  // Polyline measurement — click N points, finalize on Enter / "Hotovo".
  // Mirrors the volume-click flow but sums segment lengths (open chain).
  // Markers + segment lines parented to measureGroup so deleteAll clears them.
  const polylineModeRef = useRef(false);
  const polylinePointsRef = useRef<THREE.Vector3[]>([]);
  const polylineObjectsRef = useRef<THREE.Object3D[]>([]);
  const finalizePolylineRef = useRef<(() => void) | null>(null);
  const cancelPolylineRef = useRef<(() => void) | null>(null);
  const undoPolylinePointRef = useRef<(() => void) | null>(null);
  // Cross-cancel hook: fully exit polyline mode (clear pending + flags) when
  // another left-click mode is enabled. Bound below.
  const exitPolylineRef = useRef<(() => void) | null>(null);
  // 3D vertex snap. snapEnabledRef drives both the click pick and the hover
  // reticle; ON by default. pickSnappedRef is bound in the bootstrap effect
  // once fragments are ready (parallel to pickFirstVisibleRef).
  const snapEnabledRef = useRef(true);
  const pickSnappedRef = useRef<((mouse: THREE.Vector2) => Promise<SnapResult | null>) | null>(null);
  // Hover reticle shown while a snap-consuming mode is active. Throttled +
  // in-flight guarded so the async snap raycast never piles up on mousemove.
  const snapHoverRef = useRef<THREE.Object3D | null>(null);
  const snapHoverInFlightRef = useRef(false);
  const snapHoverLastRef = useRef(0);
  // Live preview segment from the last placed point to the cursor while
  // drawing a polyline / distance measure.
  const rubberBandRef = useRef<THREE.Line | null>(null);
  // Lazy-bound (set in bootstrap effect) so mode setters + onCanvasMove can
  // drive the reticle that's created inside the effect closure.
  const clearSnapHoverRef = useRef<(() => void) | null>(null);
  const updateSnapHoverRef = useRef<((mouse: THREE.Vector2) => void) | null>(null);
  // Pick helper that walks all models, sorts hits, returns first visible.
  // Set inside the bootstrapping useEffect once fragments are ready.
  const pickFirstVisibleRef = useRef<((mouse: THREE.Vector2) => Promise<any | null>) | null>(null);
  const displayNamesRef = useRef<Map<string, string>>(new Map());
  const propertyIndexCache = useRef<Map<string, PropertyIndex>>(new Map());
  // OBJ models, kept beside fragments.list because they are main-thread
  // three.js objects with no fragments counterpart.
  const meshModelsRef = useRef<Map<string, MeshModel>>(new Map());
  // Set by the bootstrap effect so loaders outside it can refresh the list.
  const syncModelsRef = useRef<(() => void) | null>(null);
  // OBJ meshes whose material was swapped for the selection tint, mapped to
  // the material to put back.
  const meshHighlightsRef = useRef<
    Map<THREE.Mesh, THREE.Material | THREE.Material[]>
  >(new Map());
  // Bounds of the current selection, cached so the wheel handler can act
  // without awaiting an async box query mid-gesture. null = nothing selected.
  const selectionBoxRef = useRef<THREE.Box3 | null>(null);
  // Whether the view has already been squared up on the current selection.
  const recentredOnSelectionRef = useRef(false);
  // Camera settings survive a projection swap, which replaces `camera.three`,
  // and a reload (localStorage).
  const initialCameraRef = useRef(loadCameraSettings());
  const fovRef = useRef(initialCameraRef.current.fov);
  const clipPlanesRef = useRef<ClipPlanes>(
    clipPlanesForDiagonal(DEFAULT_SCENE_DIAGONAL),
  );

  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<LoadedModel[]>([]);
  const [selection, setSelection] = useState<SelectionTarget>(null);
  const [selectionMap, setSelectionMap] = useState<Record<string, Set<number>>>({});
  const selectionMapRef = useRef<Record<string, Set<number>>>({});
  const [clipMode, setClipModeState] = useState(false);
  const [clipCount, setClipCount] = useState(0);
  const [measureMode, setMeasureModeState] = useState(false);
  const [measureCount, setMeasureCount] = useState(0);
  const [volumeMode, setVolumeModeState] = useState(false);
  const [volumePointCount, setVolumePointCount] = useState(0);
  const [polylineMode, setPolylineModeState] = useState(false);
  const [polylinePointCount, setPolylinePointCount] = useState(0);
  const [snapEnabled, setSnapEnabledState] = useState(true);
  // Just-finalized measurement awaiting a user-provided name. The Měření
  // panel watches this and prompts inline. null = nothing pending.
  const [pendingMeasurement, setPendingMeasurement] = useState<{
    kind: "distance" | "polyline" | "volume-hull" | "volume-pair" | "volume-mesh" | "volume-approx";
    /** Ties the stored row to its scene objects; see removeMeasurementVisual. */
    visualId?: string;
    value: number;
    unit: string;
    points: Array<[number, number, number]>;
    elements?: Array<{ modelId: string; localId: number }>;
  } | null>(null);
  const [projection, setProjectionState] = useState<Projection>(
    initialCameraRef.current.projection,
  );
  const [fov, setFovState] = useState(initialCameraRef.current.fov);
  const [showAllVersion, setShowAllVersion] = useState(0);
  // Active drag-select rectangle (canvas pixel coords). When non-null,
  // Viewport renders an overlay outline. The mouseup handler clears it.
  const [selectRect, setSelectRect] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);
  // Bumped whenever any runtime hider operation runs (isolate, hide,
  // setVisibility, setModelHidden, showModelAll, showAll). Tree's
  // ModelBlock subscribes and re-derives its local checkbox state from
  // the live FragmentsModel visibility, so external ops (agent, property
  // filter) no longer leave the tree out of sync with the scene.
  const [runtimeVisibilityVersion, setRuntimeVisibilityVersion] = useState(0);
  const bumpRuntimeVisibility = useCallback(
    () => setRuntimeVisibilityVersion((v) => v + 1),
    [],
  );
  // Isolation root = sticky subset for downstream operations (e.g. property
  // filter "Izolovat" sets this so tree-driven storey toggles intersect with
  // it instead of resetting). Stored as Record<modelId, Set<localId>>.
  const isolationRootRef = useRef<Record<string, Set<number>> | null>(null);
  const [isolationRootVersion, setIsolationRootVersion] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    let disposed = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      const components = new OBC.Components();
      const worlds = components.get(OBC.Worlds);
      const world = worlds.create<
        OBC.SimpleScene,
        OBC.OrthoPerspectiveCamera,
        OBF.RendererWith2D
      >();

      world.scene = new OBC.SimpleScene(components);
      // OBF.RendererWith2D = WebGL + CSS2DRenderer in one. Required for the
      // measurement tool's snap markers + dimension labels (CSS2DObject)
      // and any other HTML-overlay components. Plain OBC.SimpleRenderer
      // would render the WebGL but never mount the DOM markers, so the
      // measurement looked like "snap doesn't work".
      world.renderer = new OBF.RendererWith2D(components, container);
      // RendererWith2D.setupHtmlRenderer forces `container.style.position`
      // to "relative" so it can append a CSS2D layer absolutely-positioned
      // inside. That clobbers our Tailwind `absolute inset-0` layout —
      // container loses its pin to the parent, shrinks to natural size,
      // and the bottom toolbar visually drops off-frame plus camera aspect
      // drifts (zoom feels wrong). Restore absolute positioning; the CSS2D
      // child is still absolute inside it, so the host-style "relative"
      // is functionally unneeded once the inset-0 ancestor pin is back.
      container.style.position = "absolute";
      container.style.top = "0";
      container.style.left = "0";
      container.style.right = "0";
      container.style.bottom = "0";
      world.camera = new OBC.OrthoPerspectiveCamera(components);

      components.init();

      const fragments = components.get(OBC.FragmentsManager);

      try {
        const workerURL = await OBC.FragmentsManager.getWorker();
        if (disposed) {
          components.dispose();
          return;
        }
        fragments.init(workerURL);
      } catch (e: any) {
        if (!disposed) {
          setError(e?.message ?? "Fragments init failed");
          console.error(e);
        }
        components.dispose();
        return;
      }

      world.scene.setup();
      world.scene.three.background = new THREE.Color(0x171717);
      world.camera.controls.setLookAt(12, 8, 12, 0, 0, 0);
      applyCameraSettings(world, fovRef.current, clipPlanesRef.current);

      // The camera starts perspective; honour the remembered projection.
      if (initialCameraRef.current.projection === "orthographic") {
        try {
          await (world.camera as any).projection?.set?.("Orthographic");
        } catch (e) {
          console.warn("[viewer] initial projection swap failed", e);
        }
        if (disposed) {
          components.dispose();
          return;
        }
        // The swap happens before onProjectionChanged is subscribed below, so
        // the fresh camera would keep the library's near/far otherwise.
        applyCameraSettings(world, fovRef.current, clipPlanesRef.current);
      }

      const grids = components.get(OBC.Grids);
      grids.create(world);

      const requestUpdate = () => {
        if (fragments.initialized) fragments.core.update(true);
      };
      world.camera.controls.addEventListener("rest", requestUpdate);
      world.camera.controls.addEventListener("update", requestUpdate);

      // OBC.SimpleRenderer + SimpleCamera register their resize handlers on
      // `window.resize`, not on container mutations. Sidebar collapse/open
      // changes the container size without firing a window resize, so the
      // canvas keeps its old framebuffer and the projection matrix goes
      // out of sync. Observe the container and call OBC's own resize methods
      // (and dispatch a window resize as a belt-and-braces fallback that
      // also triggers any other listeners hooked into the global event).
      const resizeObserver = new ResizeObserver(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === 0 || h === 0) return;
        try {
          (world.renderer as any)?.resize?.();
          (world.camera as any)?.updateAspect?.();
        } catch (e) {
          console.warn("[viewer] OBC resize failed", e);
        }
        // Hard fallback — also drive THREE directly in case OBC's resize is
        // a no-op for this container/state.
        try {
          const renderer = (world.renderer as any)?.three;
          if (renderer?.setSize) renderer.setSize(w, h, false);
          const cam: any = world.camera?.three;
          if (cam && "aspect" in cam) {
            cam.aspect = w / h;
            cam.updateProjectionMatrix?.();
          }
        } catch (e) {
          console.warn("[viewer] direct resize failed", e);
        }
        window.dispatchEvent(new Event("resize"));
        if (fragments.initialized) fragments.core.update(true);
      });
      resizeObserver.observe(container);

      const syncModels = () => {
        const next: LoadedModel[] = [];
        const seen = new Set<string>();
        for (const [key, m] of fragments.list as any) {
          const id = (m as any)?.modelId ?? key;
          if (seen.has(id)) continue;
          seen.add(id);
          next.push({
            id,
            name: displayNamesRef.current.get(id) ?? id,
            kind: "ifc",
          });
        }
        for (const [id, model] of meshModelsRef.current) {
          if (seen.has(id)) continue;
          seen.add(id);
          next.push({ id, name: model.name, kind: "obj" });
        }
        setModels(next);
      };
      syncModelsRef.current = syncModels;

      const onItemSet = ({ value: model }: { value: any }) => {
        model.useCamera(world.camera.three);
        world.scene.three.add(model.object);
        syncModels();
        requestUpdate();
      };
      fragments.list.onItemSet.add(onItemSet);

      // Projection swap (perspective ↔ orthographic) replaces world.camera.three
      // with a new THREE.Camera instance. Re-bind every loaded model so LOD /
      // raycast pipelines pick up the active camera; also re-anchor controls.
      const onProjectionChanged = () => {
        const cam = world.camera.three;
        // The swap hands back a different THREE camera, so fov and clipping
        // planes have to be re-applied or the new one reverts to library
        // defaults (60° / near 1) that this viewer deliberately moved away from.
        applyCameraSettings(world, fovRef.current, clipPlanesRef.current);
        setProjectionState(
          (cam as THREE.PerspectiveCamera).isPerspectiveCamera
            ? "perspective"
            : "orthographic",
        );
        for (const [, m] of fragments.list as any) {
          try {
            (m as any).useCamera?.(cam);
          } catch (e) {
            console.warn("[viewer] useCamera reattach failed", e);
          }
        }
        if (fragments.initialized) fragments.core.update(true);
      };
      world.camera.projection.onChanged.add(onProjectionChanged);

      const onItemDeleted = (key: string) => {
        propertyIndexCache.current.delete(key);
        syncModels();
      };
      fragments.list.onItemDeleted.add(onItemDeleted);

      const onFragmentsLoaded = () => syncModels();
      fragments.onFragmentsLoaded.add(onFragmentsLoaded);

      const highlighter = components.get(OBF.Highlighter);
      highlighter.setup({ world, autoHighlightOnClick: false });

      // OrthoPerspectiveCamera installs a default NavigationMode (Orbit) which
      // re-binds mouseButtons on activation. Force the mode explicitly first,
      // THEN overwrite mouseButtons — otherwise our middle=TRUCK assignment is
      // silently clobbered by mode init and middle-click pan stops working.
      try {
        (world.camera as any).set?.("Orbit");
      } catch {}
      const controls = world.camera.controls as any;
      // Dalux-style navigation: left drag orbits, left click selects, middle
      // drag pans, right does nothing. The left button stays NONE here because
      // rotation is driven by hand below — camera-controls cannot express
      // "rotate only once the pointer has moved", which is what lets the same
      // button also select.
      const applyMouseBindings = () => {
        controls.mouseButtons.left = 0; // NONE (we drive rotate + picking)
        controls.mouseButtons.middle = 2; // TRUCK (pan)
        controls.mouseButtons.right = 0; // NONE
        // Wheel keeps its default action (DOLLY in perspective, ZOOM in
        // orthographic); dollyToCursor makes both move toward the pointer
        // rather than the screen centre. Re-asserted here because the
        // navigation mode resets it when it activates.
        controls.dollyToCursor = true;
      };
      applyMouseBindings();
      // Re-apply after projection swap (projection.set may reset some control
      // state when switching ortho↔persp internally).
      world.camera.projection.onChanged.add(applyMouseBindings);

      const canvas = world.renderer!.three.domElement;
      const ROT_SPEED = 0.005;
      const SELECT_DRAG_THRESHOLD = 5;
      const mouseStart = {
        x: 0,
        y: 0,
        t: 0,
        shift: false,
        lastX: 0,
        lastY: 0,
        // left button currently held — gates drag arming so a plain move with
        // no button pressed never rotates or draws the rectangle.
        down: false,
        // plain left-drag past threshold = orbit
        dragging: false,
        // shift+left-drag past threshold = rectangle select
        selecting: false as boolean,
        additive: false as boolean,
        // press landed on a section plane's drag gizmo — the Clipper owns it
        overClipGizmo: false as boolean,
      };

      // Section planes are moved with their own TransformControls, which also
      // want the left button. Without this the camera orbits while the plane
      // stays put, and a section created flush with a surface can never be
      // pushed into the model — which is most of what a section is for.
      const clipGizmoUnderPointer = (): boolean => {
        const clipper = clipperRef.current as any;
        if (!clipper) return false;
        for (const plane of clipper.list.values()) {
          const gizmo = (plane as any)?._controls;
          if (gizmo && (gizmo.dragging || gizmo.axis)) return true;
        }
        return false;
      };

      const onCanvasDown = (e: MouseEvent) => {
        if (e.button !== 0) return;
        // Skip drag-select when a special mode owns the left click
        // (clip, distance measure, volume/polyline click capture).
        const inSpecialMode =
          clipModeRef.current ||
          measureModeRef.current ||
          volumeModeRef.current ||
          polylineModeRef.current;
        mouseStart.x = e.clientX;
        mouseStart.y = e.clientY;
        mouseStart.lastX = e.clientX;
        mouseStart.lastY = e.clientY;
        mouseStart.t = Date.now();
        mouseStart.overClipGizmo = clipGizmoUnderPointer();
        if (mouseStart.overClipGizmo) {
          mouseStart.down = false;
          return;
        }
        mouseStart.down = true;
        mouseStart.shift = e.shiftKey;
        mouseStart.dragging = false;
        mouseStart.selecting = false;
        mouseStart.additive = e.metaKey || e.ctrlKey;
        if (e.shiftKey) e.preventDefault();
        // A left press is ambiguous until the pointer moves: click = select,
        // drag = orbit (or rectangle select with shift). Nothing is decided
        // here; onCanvasMove commits once past SELECT_DRAG_THRESHOLD.
        void inSpecialMode;
      };

      const onCanvasMove = (e: MouseEvent) => {
        // Button released outside the canvas (mouseup never reached us) —
        // disarm so we don't keep drawing the rect on a button-less move.
        if (mouseStart.down && (e.buttons & 1) === 0) {
          mouseStart.down = false;
          mouseStart.dragging = false;
          if (mouseStart.selecting) {
            mouseStart.selecting = false;
            mouseStart.t = 0;
            setSelectRect(null);
          }
        }
        // Commit the drag intent once the pointer has travelled far enough
        // that this can no longer be a click. Plain drag orbits; shift+drag
        // draws a selection rectangle. Special modes own the left button
        // outright, so neither arms while one is active.
        if (
          mouseStart.down &&
          !mouseStart.dragging &&
          !mouseStart.selecting &&
          !clipModeRef.current &&
          !measureModeRef.current &&
          !volumeModeRef.current &&
          !polylineModeRef.current
        ) {
          const dist = Math.hypot(
            e.clientX - mouseStart.x,
            e.clientY - mouseStart.y,
          );
          if (dist > SELECT_DRAG_THRESHOLD) {
            if (mouseStart.shift) {
              mouseStart.selecting = true;
            } else {
              mouseStart.dragging = true;
              // Anchor the orbit delta at the current position, otherwise the
              // camera jumps by the whole threshold on the first frame.
              mouseStart.lastX = e.clientX;
              mouseStart.lastY = e.clientY;
            }
          }
        }

        if (mouseStart.dragging) {
          const dx = e.clientX - mouseStart.lastX;
          const dy = e.clientY - mouseStart.lastY;
          mouseStart.lastX = e.clientX;
          mouseStart.lastY = e.clientY;
          controls.rotate(-dx * ROT_SPEED, -dy * ROT_SPEED, false);
          return;
        }

        if (mouseStart.selecting) {
          setSelectRect({
            x1: mouseStart.x,
            y1: mouseStart.y,
            x2: e.clientX,
            y2: e.clientY,
          });
        }
        // Snap hover preview while a snap-consuming mode is active and the
        // user is not mid-drag (rotate/select own the cursor then).
        if (
          !mouseStart.dragging &&
          !mouseStart.selecting &&
          snapEnabledRef.current &&
          (measureModeRef.current ||
            polylineModeRef.current ||
            clipModeRef.current)
        ) {
          updateSnapHoverRef.current?.(new THREE.Vector2(e.clientX, e.clientY));
        } else if (snapHoverRef.current) {
          clearSnapHoverRef.current?.();
        }
      };

      // Visibility-aware raycast: FragmentsManager.raycast returns only the
      // single closest hit and does NOT skip elements that the Hider has
      // turned invisible (per-element flag) — clicks then "see through"
      // to a hidden element on top and pick its data, which surfaces stale
      // selection in the properties panel. Iterate models manually using
      // raycastAll per model, sort all candidates by distance, and pick the
      // first one whose localId is still in the visible set for that model.
      // model.object.visible=false (whole-model hidden) is honored up front.
      // OBJ geometry lives on the main thread, so a plain Raycaster reaches it.
      // Hits are normalised to the shape the fragments worker returns so both
      // sources can be merged and sorted by distance in one list.
      const meshRaycaster = new THREE.Raycaster();
      // Active section planes as THREE.Plane. The Clipper keeps these updated
      // as the user drags a plane, so holding the references is enough.
      const activeClipPlanes = (): THREE.Plane[] => {
        const clipper = clipperRef.current as any;
        if (!clipper) return [];
        const out: THREE.Plane[] = [];
        for (const plane of clipper.list.values()) {
          if (plane?.three?.isPlane) out.push(plane.three);
        }
        return out;
      };
      const cursorFrame = (mouse: THREE.Vector2) => {
        const rect = canvas.getBoundingClientRect();
        return {
          x: mouse.x - rect.left,
          y: mouse.y - rect.top,
          width: rect.width,
          height: rect.height,
        };
      };
      const raycastMeshes = (mouse: THREE.Vector2): any[] => {
        const models = meshModelsRef.current;
        if (!models.size) return [];
        const frame = cursorFrame(mouse);
        if (!frame.width || !frame.height) return [];
        meshRaycaster.setFromCamera(
          new THREE.Vector2(
            (frame.x / frame.width) * 2 - 1,
            -(frame.y / frame.height) * 2 + 1,
          ),
          world.camera.three,
        );
        const targets: THREE.Object3D[] = [];
        for (const model of models.values()) {
          if (model.object.visible) targets.push(model.object);
        }
        if (!targets.length) return [];
        const planes = activeClipPlanes();
        return meshRaycaster
          .intersectObjects(targets, true)
          // The raycaster does not consult `visible`, so hidden parts would
          // still be pickable after an isolate or hide.
          .filter((hit) => isObjectVisible(hit.object))
          // Nor does it know about clipping: without this, clicking a section
          // picks the geometry the cut removed, which is not on screen.
          .filter((hit) =>
            planes.every((plane) => plane.distanceToPoint(hit.point) >= 0),
          )
          .map((hit) => ({
          point: hit.point,
          distance: hit.distance,
          localId: (hit.object.userData?.localId as number) ?? -1,
          // Mirrors the fragments hit shape; `getItemsByVisibility` is absent,
          // which the visibility filter below reads as "nothing to filter".
          fragments: { modelId: hit.object.userData?.modelId as string },
          normal: hit.face?.normal
            ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
            : undefined,
          meshIntersection: hit,
        }));
      };

      const pickFirstVisible = async (mouse: THREE.Vector2): Promise<any | null> => {
        const all: any[] = raycastMeshes(mouse);
        for (const [, model] of fragments.list as any) {
          const obj = (model as any)?.object;
          if (obj && obj.visible === false) continue;
          try {
            const hits = await (model as any).raycastAll?.({
              camera: world.camera.three,
              mouse,
              dom: canvas,
            });
            if (hits && hits.length) for (const h of hits) all.push(h);
          } catch (err) {
            console.warn("[viewer] raycastAll failed", err);
          }
        }
        if (!all.length) return null;
        all.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
        // Cache visibility set per model to avoid re-querying for each hit.
        const visibleByModel = new Map<string, Set<number>>();
        for (const h of all) {
          const mid = h.fragments?.modelId;
          if (!mid) continue;
          let set = visibleByModel.get(mid);
          if (!set) {
            try {
              const vis = await h.fragments.getItemsByVisibility?.(true);
              set = new Set<number>(Array.isArray(vis) ? vis : []);
            } catch {
              set = null as any;
            }
            // null = couldn't query (no API / no items tracked yet) → trust the
            // hit. Skip filtering for this model.
            visibleByModel.set(mid, set as any);
          }
          if (!set || set.size === 0 || set.has(h.localId)) return h;
        }
        return null;
      };

      pickFirstVisibleRef.current = pickFirstVisible;

      // Snap-aware pick: when snap is on, run a per-model raycast with vertex
      // (POINT) snapping and return the nearest snapped point that belongs to
      // a still-visible element. Falls back to the plain surface hit when no
      // vertex is in range or snap is off. Same worker-side per-model API as
      // raycastAll, so it's safe across the fragments worker boundary (unlike
      // OBF.LengthMeasurement, whose init pipeline failed for us before).
      const surfaceResult = async (mouse: THREE.Vector2): Promise<SnapResult | null> => {
        const hit: any = await pickFirstVisible(mouse);
        if (!hit?.point) return null;
        return {
          point: hit.point.clone(),
          localId: hit.localId,
          modelId: hit.fragments?.modelId,
          normal: hit.normal ? hit.normal.clone() : undefined,
          snapped: false,
        };
      };
      const pickSnapped = async (mouse: THREE.Vector2): Promise<SnapResult | null> => {
        if (!snapEnabledRef.current) return surfaceResult(mouse);
        // OBJ has no worker-side snapping pipeline — derive candidates from the
        // hit triangle and pick the one nearest the cursor on screen.
        const planes = activeClipPlanes();
        const all: any[] = raycastMeshes(mouse).map((hit) => {
          const face = faceSnapCandidates(hit.meshIntersection);
          // Vertices win ties, then the section cut, then plain edge midpoints:
          // a real corner is the most trustworthy thing to measure from, but a
          // cut edge beats the middle of an uncut edge.
          const candidate = chooseSnapCandidate(
            [
              ...face.filter((c) => c.kind === "vertex"),
              ...sectionSnapCandidates(hit.meshIntersection, planes),
              ...face.filter((c) => c.kind === "edge"),
            ],
            world.camera.three,
            cursorFrame(mouse),
            MESH_SNAP_RADIUS_PX,
          );
          return candidate
            ? { ...hit, point: candidate.point, snappedVertex: true }
            : hit;
        });
        for (const [, model] of fragments.list as any) {
          const obj = (model as any)?.object;
          if (obj && obj.visible === false) continue;
          try {
            const hits = await (model as any).raycastWithSnapping?.({
              camera: world.camera.three,
              mouse,
              dom: canvas,
              snappingClasses: [SNAP_CLASS_POINT],
            });
            if (hits && hits.length) for (const h of hits) all.push(h);
          } catch (err) {
            console.warn("[viewer] raycastWithSnapping failed", err);
          }
        }
        if (all.length) {
          all.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
          const visibleByModel = new Map<string, Set<number>>();
          for (const h of all) {
            const mid = h.fragments?.modelId;
            if (!mid || !h.point) continue;
            let set = visibleByModel.get(mid);
            if (!set) {
              try {
                const vis = await h.fragments.getItemsByVisibility?.(true);
                set = new Set<number>(Array.isArray(vis) ? vis : []);
              } catch {
                set = null as any;
              }
              visibleByModel.set(mid, set as any);
            }
            if (!set || set.size === 0 || set.has(h.localId)) {
              return {
                point: h.point.clone(),
                localId: h.localId,
                modelId: mid,
                normal: h.normal ? h.normal.clone() : undefined,
                snapped: h.snappedVertex === true || h.snappingClass === SNAP_CLASS_POINT,
              };
            }
          }
        }
        // No vertex in range — fall back to the surface point so the user
        // still gets a usable measurement anchor.
        return surfaceResult(mouse);
      };
      pickSnappedRef.current = pickSnapped;

      // Hover reticle: while a snap-consuming mode is active, preview the
      // point the next click will land on. Throttled + in-flight guarded.
      const clearSnapHover = () => {
        const group = measureGroupRef.current;
        if (snapHoverRef.current && group) {
          group.remove(snapHoverRef.current);
          disposeObject(snapHoverRef.current);
        }
        snapHoverRef.current = null;
        if (rubberBandRef.current && group) {
          group.remove(rubberBandRef.current);
          disposeObject(rubberBandRef.current);
        }
        rubberBandRef.current = null;
      };
      clearSnapHoverRef.current = clearSnapHover;
      // Anchor the rubber-band starts from: the last polyline vertex, or the
      // pending distance-measure anchor. null = nothing to preview a line from.
      const rubberBandAnchor = (): THREE.Vector3 | null => {
        if (polylineModeRef.current && polylinePointsRef.current.length)
          return polylinePointsRef.current[polylinePointsRef.current.length - 1];
        if (measureModeRef.current && measureAnchorRef.current)
          return measureAnchorRef.current;
        return null;
      };
      const updateSnapHover = (mouse: THREE.Vector2) => {
        if (snapHoverInFlightRef.current) return;
        const now = performance.now();
        if (now - snapHoverLastRef.current < 55) return;
        snapHoverLastRef.current = now;
        snapHoverInFlightRef.current = true;
        pickSnapped(mouse)
          .then((res) => {
            const group = measureGroupRef.current;
            const active =
              measureModeRef.current ||
              polylineModeRef.current ||
              clipModeRef.current;
            if (!group || !active || !res) {
              clearSnapHover();
            } else {
              if (!snapHoverRef.current) {
                snapHoverRef.current = makeSnapReticle(res.point, res.snapped);
                group.add(snapHoverRef.current);
              } else {
                snapHoverRef.current.position.copy(res.point);
                applyReticleColor(snapHoverRef.current, res.snapped);
              }
              // Rubber-band: live segment from the last placed point to the
              // cursor so the user sees the line they're drawing.
              const anchor = rubberBandAnchor();
              if (anchor) {
                if (!rubberBandRef.current) {
                  rubberBandRef.current = makeRubberBand(anchor, res.point);
                  group.add(rubberBandRef.current);
                } else {
                  updateRubberBand(rubberBandRef.current, anchor, res.point);
                }
              } else if (rubberBandRef.current) {
                group.remove(rubberBandRef.current);
                disposeObject(rubberBandRef.current);
                rubberBandRef.current = null;
              }
            }
            const fr = fragmentsRef.current;
            if (fr?.initialized) fr.core.update(true);
          })
          .catch(() => {})
          .finally(() => {
            snapHoverInFlightRef.current = false;
          });
      };
      updateSnapHoverRef.current = updateSnapHover;

      const onCanvasUp = async (e: MouseEvent) => {
        if (e.button !== 0) return;
        // The Clipper handled this gesture; do not also select on release.
        if (mouseStart.overClipGizmo) {
          mouseStart.overClipGizmo = false;
          return;
        }
        mouseStart.down = false;
        const dragging = mouseStart.dragging;
        mouseStart.dragging = false;
        if (dragging) return;
        const dx = e.clientX - mouseStart.x;
        const dy = e.clientY - mouseStart.y;
        const dist = Math.hypot(dx, dy);

        // Drag-select branch: if the cursor moved past threshold without
        // a special mode owning the drag, run a rectangle raycast per
        // visible model and aggregate the hits into a multi-selection.
        if (mouseStart.selecting) {
          mouseStart.selecting = false;
          mouseStart.t = 0;
          setSelectRect(null);
          const x1 = Math.min(mouseStart.x, e.clientX);
          const y1 = Math.min(mouseStart.y, e.clientY);
          const x2 = Math.max(mouseStart.x, e.clientX);
          const y2 = Math.max(mouseStart.y, e.clientY);
          if (x2 - x1 < SELECT_DRAG_THRESHOLD && y2 - y1 < SELECT_DRAG_THRESHOLD) {
            return;
          }
          try {
            const topLeft = new THREE.Vector2(x1, y1);
            const bottomRight = new THREE.Vector2(x2, y2);
            const aggregated: Record<string, Set<number>> = {};
            for (const [, model] of fragments.list as any) {
              const obj = (model as any).object;
              if (obj?.visible === false) continue;
              try {
                const res = await (model as any).rectangleRaycast?.({
                  camera: world.camera.three,
                  dom: canvas,
                  topLeft,
                  bottomRight,
                  fullyIncluded: false,
                });
                if (!res || !Array.isArray(res.localIds) || !res.localIds.length)
                  continue;
                const mid = (res.fragments as any)?.modelId ?? (model as any).modelId;
                if (!mid) continue;
                // Filter against runtime visibility — hider may have
                // turned individual items off and we don't want them in
                // a fresh selection.
                let visSet: Set<number> | null = null;
                try {
                  const vis = await (model as any).getItemsByVisibility?.(true);
                  visSet = new Set<number>(Array.isArray(vis) ? vis : []);
                } catch {
                  visSet = null;
                }
                const bucket = aggregated[mid] ?? new Set<number>();
                for (const id of res.localIds) {
                  if (!visSet || visSet.size === 0 || visSet.has(id)) {
                    bucket.add(id);
                  }
                }
                if (bucket.size) aggregated[mid] = bucket;
              } catch (err) {
                console.warn("[viewer] rectangleRaycast failed", err);
              }
            }
            if (mouseStart.additive) {
              const merged: Record<string, Set<number>> = {};
              for (const [mid, set] of Object.entries(selectionMapRef.current)) {
                merged[mid] = new Set(set);
              }
              for (const [mid, set] of Object.entries(aggregated)) {
                const into = merged[mid] ?? new Set<number>();
                for (const id of set) into.add(id);
                merged[mid] = into;
              }
              if (Object.keys(merged).length === 0) {
                await highlighter.clear("select");
              } else {
                await highlighter.highlightByID("select", merged as any, true, false);
              }
            } else {
              if (Object.keys(aggregated).length === 0) {
                await highlighter.clear("select");
              } else {
                await highlighter.highlightByID(
                  "select",
                  aggregated as any,
                  true,
                  false,
                );
              }
            }
          } catch (err) {
            console.error("[viewer] drag-select failed", err);
          }
          return;
        }

        // Anything that stayed put is a click, however long the button was
        // held — a slow press must still select.
        if (dist > SELECT_DRAG_THRESHOLD) return;
        const mouse = new THREE.Vector2(e.clientX, e.clientY);
        try {
          const hit: any = await pickFirstVisible(mouse);
          if (!hit || hit.localId === undefined || hit.localId === null) {
            if (!clipModeRef.current) await highlighter.clear("select");
            return;
          }
          if (clipModeRef.current && hit.point && hit.normal) {
            const clipper = clipperRef.current;
            if (clipper) {
              // Normal stays the surface normal (a vertex snap has none), but
              // the plane origin snaps to the nearest vertex so section cuts
              // align to corners/edges.
              let origin = hit.point.clone();
              if (snapEnabledRef.current) {
                const snap = await pickSnapped(mouse);
                if (snap?.point) origin = snap.point;
              }
              clipper.createFromNormalAndCoplanarPoint(world, hit.normal, origin);
              setClipCount(clipper.list.size);
            }
            clearSnapHover();
            return;
          }
          if (volumeModeRef.current) {
            if (!hit.point) return;
            const group = measureGroupRef.current;
            if (!group) return;
            const point = hit.point.clone();
            volumePointsRef.current.push(point);
            const marker = makeAnchorSphere(point);
            (marker as any).userData.dimkoMeasure = "volume-pending";
            group.add(marker);
            volumeMarkersRef.current.push(marker);
            setVolumePointCount(volumePointsRef.current.length);
            if (fragments.initialized) fragments.core.update(true);
            return;
          }
          if (polylineModeRef.current) {
            const snap = snapEnabledRef.current ? await pickSnapped(mouse) : null;
            const src = snap?.point ?? hit.point;
            if (!src) return;
            const point = src.clone();
            const group = measureGroupRef.current;
            if (!group) return;
            const pts = polylinePointsRef.current;
            const prev = pts[pts.length - 1];
            pts.push(point);
            const marker = makeAnchorSphere(point);
            (marker as any).userData.dimkoMeasure = "polyline-pending";
            group.add(marker);
            polylineObjectsRef.current.push(marker);
            if (prev) {
              const seg = makeSegmentLine(prev, point);
              (seg as any).userData.dimkoMeasure = "polyline-pending";
              group.add(seg);
              polylineObjectsRef.current.push(seg);
            }
            setPolylinePointCount(pts.length);
            clearSnapHover();
            if (fragments.initialized) fragments.core.update(true);
            return;
          }
          if (measureModeRef.current) {
            const snap = snapEnabledRef.current ? await pickSnapped(mouse) : null;
            const src = snap?.point ?? hit.point;
            if (!src) return;
            const point = src.clone();
            const group = measureGroupRef.current;
            if (!group) return;
            clearSnapHover();
            if (!measureAnchorRef.current) {
              // First click — store anchor and drop a sphere marker.
              measureAnchorRef.current = point;
              const sphere = makeAnchorSphere(point);
              group.add(sphere);
              measureAnchorVisualRef.current = sphere;
            } else {
              // Second click — close the measurement.
              const a = measureAnchorRef.current;
              const b = point;
              measureAnchorRef.current = null;
              if (measureAnchorVisualRef.current) {
                group.remove(measureAnchorVisualRef.current);
                disposeObject(measureAnchorVisualRef.current);
                measureAnchorVisualRef.current = null;
              }
              const visualId = nextMeasurementId();
              group.add(makeMeasurement(a, b, visualId));
              setMeasureCount(countMeasurements(group));
              const distance = a.distanceTo(b);
              setPendingMeasurement({
                kind: "distance",
                visualId,
                value: distance,
                unit: "m",
                points: [
                  [a.x, a.y, a.z],
                  [b.x, b.y, b.z],
                ],
              });
            }
            if (fragments.initialized) fragments.core.update(true);
            return;
          }
          const modelId = hit.fragments?.modelId;
          if (!modelId) return;
          const localId = hit.localId as number;
          const additive = e.metaKey || e.ctrlKey;
          if (additive) {
            const next: Record<string, Set<number>> = {};
            for (const [mid, ids] of Object.entries(selectionMapRef.current)) {
              next[mid] = new Set(ids);
            }
            const set = next[modelId] ?? new Set<number>();
            if (set.has(localId)) {
              set.delete(localId);
              if (set.size === 0) delete next[modelId];
              else next[modelId] = set;
            } else {
              set.add(localId);
              next[modelId] = set;
            }
            if (Object.keys(next).length === 0) {
              await highlighter.clear("select");
            } else {
              await highlighter.highlightByID("select", next, true, false);
            }
          } else {
            const map: OBC.ModelIdMap = { [modelId]: new Set([localId]) };
            await highlighter.highlightByID("select", map, true, false);
          }
        } catch (err) {
          console.error("[viewer] pick failed", err);
        }
      };

      const onContextMenu = (e: MouseEvent) => e.preventDefault();

      canvas.addEventListener("mousedown", onCanvasDown);
      canvas.addEventListener("mousemove", onCanvasMove);
      canvas.addEventListener("mouseup", onCanvasUp);
      canvas.addEventListener("contextmenu", onContextMenu);

      // Orbit and dolly around whatever was just selected. In a scene holding
      // several objects the controls otherwise pivot about the scene centre,
      // so zooming into one object swings it straight out of frame.
      // `setOrbitPoint` moves the pivot without moving the camera, which keeps
      // the view stable at the moment of selection.
      const focusPivot = async (map: Record<string, Set<number>>) => {
        const controls: any = world.camera.controls;
        if (typeof controls?.setOrbitPoint !== "function") return;

        const merged = new THREE.Box3();
        let hasAny = false;
        const absorb = (box: THREE.Box3) => {
          if (box.isEmpty()) return;
          if (hasAny) {
            merged.union(box);
          } else {
            merged.copy(box);
            hasAny = true;
          }
        };

        for (const [modelId, ids] of Object.entries(map)) {
          if (!ids?.size) continue;
          const meshModel = meshModelsRef.current.get(modelId);
          if (meshModel) {
            for (const localId of ids) {
              const part = meshModel.parts.get(localId);
              if (part) absorb(new THREE.Box3().setFromObject(part.mesh));
            }
            continue;
          }
          const model: any = fragments.list.get(modelId);
          if (!model) continue;
          try {
            absorb(await model.getMergedBox(Array.from(ids)));
          } catch (e) {
            console.warn("[viewer] pivot box failed", modelId, e);
          }
        }
        if (!hasAny) {
          selectionBoxRef.current = null;
          return;
        }

        // The wheel handler needs these synchronously.
        selectionBoxRef.current = merged.clone();
        recentredOnSelectionRef.current = false;
        // Zoom should converge on the selection rather than chase the pointer.
        controls.dollyToCursor = false;

        const center = merged.getCenter(new THREE.Vector3());
        try {
          controls.setOrbitPoint(center.x, center.y, center.z);
        } catch (e) {
          console.warn("[viewer] setOrbitPoint failed", e);
        }
      };

      // Zoom behaviour depends on whether anything is selected.
      //
      // With a selection, the wheel should home in on that object. Setting the
      // orbit point alone is not enough: it deliberately leaves the object
      // wherever it sits on screen (compensating with a focal offset), so
      // dollying would enlarge it off-centre and never frame it. Squaring the
      // view up on the selection is what makes repeated scrolling converge on
      // "the object, centred, filling the window".
      //
      // That re-centring is a visible camera move, so it waits for the first
      // scroll instead of firing on every click — selecting something to read
      // its properties should not throw the view around.
      const onWheel = () => {
        const box = selectionBoxRef.current;
        if (!box || recentredOnSelectionRef.current) return;
        recentredOnSelectionRef.current = true;
        const center = box.getCenter(new THREE.Vector3());
        try {
          controls.setFocalOffset(0, 0, 0, true);
          controls.moveTo(center.x, center.y, center.z, true);
        } catch (e) {
          console.warn("[viewer] wheel recentre failed", e);
        }
      };
      canvas.addEventListener("wheel", onWheel, { passive: true });

      const onHighlight = (modelIdMap: OBC.ModelIdMap) => {
        const normalized: Record<string, Set<number>> = {};
        let primary: SelectionTarget = null;
        for (const [mid, ids] of Object.entries(modelIdMap)) {
          if (!ids) continue;
          const set =
            ids instanceof Set
              ? new Set(ids as Set<number>)
              : new Set(ids as number[]);
          if (!set.size) continue;
          normalized[mid] = set;
          if (!primary) {
            const first = set.values().next().value;
            if (first !== undefined) primary = { modelId: mid, localId: Number(first) };
          }
        }
        selectionMapRef.current = normalized;
        setSelectionMap(normalized);
        setSelection(primary);
        void focusPivot(normalized);
      };
      const onClear = () => {
        selectionMapRef.current = {};
        setSelectionMap({});
        setSelection(null);
        // Nothing to converge on — the wheel goes back to following the
        // pointer, which is the right default when browsing a whole model.
        selectionBoxRef.current = null;
        recentredOnSelectionRef.current = false;
        controls.dollyToCursor = true;
      };
      highlighter.events.select.onHighlight.add(onHighlight);
      highlighter.events.select.onClear.add(onClear);

      const hider = components.get(OBC.Hider);

      const clipper = components.get(OBC.Clipper);
      clipper.enabled = true;
      clipper.config.color = new THREE.Color(0x00d4ff);
      clipper.config.opacity = 0.15;
      const onAfterDelete = () => setClipCount(clipper.list.size);
      clipper.onAfterDelete.add(onAfterDelete);

      // Custom measurement group attached directly to the scene. All
      // dimension visuals (anchor spheres, line, CSS2D labels) get parented
      // here so deleteAll = clear children + dispose.
      const measureGroup = new THREE.Group();
      measureGroup.name = "DIMKO_measurements";
      world.scene.three.add(measureGroup);
      measureGroupRef.current = measureGroup;

      // Dev-only handle so the viewer can be driven from a browser test
      // harness (camera state and scene contents are otherwise unreachable
      // from page scripts). Never present in a production build.
      if (import.meta.env.DEV) {
        (window as any).__dimkoViewer = {
          world,
          fragments,
          measureGroup,
          components,
          clipper,
        };
      }

      const onKeyDown = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
        if (e.key === "Enter" && volumeModeRef.current) {
          finalizeVolumeRef.current?.();
          return;
        }
        if (e.key === "Enter" && polylineModeRef.current) {
          finalizePolylineRef.current?.();
          return;
        }
        if (e.key === "Backspace" && volumeModeRef.current && volumePointsRef.current.length) {
          undoVolumePointRef.current?.();
          return;
        }
        if (e.key === "Backspace" && polylineModeRef.current && polylinePointsRef.current.length) {
          undoPolylinePointRef.current?.();
          return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          if (clipper.list.size) {
            clipper.deleteAll();
            setClipCount(0);
          }
        } else if (e.key === "Escape") {
          if (volumeModeRef.current) {
            cancelVolumeRef.current?.();
            return;
          }
          if (polylineModeRef.current) {
            cancelPolylineRef.current?.();
            return;
          }
          if (measureModeRef.current) {
            // If anchor is pending, just cancel that — let user keep
            // measuring. Otherwise fully exit measure mode.
            if (measureAnchorRef.current) {
              const group = measureGroupRef.current;
              if (measureAnchorVisualRef.current && group) {
                group.remove(measureAnchorVisualRef.current);
                disposeObject(measureAnchorVisualRef.current);
              }
              measureAnchorVisualRef.current = null;
              measureAnchorRef.current = null;
            } else {
              measureModeRef.current = false;
              setMeasureModeState(false);
            }
          } else if (clipModeRef.current) {
            clipModeRef.current = false;
            setClipModeState(false);
          } else if (Object.keys(selectionMapRef.current).length > 0) {
            highlighter.clear("select").catch(() => {});
          }
        }
      };
      window.addEventListener("keydown", onKeyDown);

      componentsRef.current = components;
      worldRef.current = world;
      fragmentsRef.current = fragments;
      highlighterRef.current = highlighter;
      hiderRef.current = hider;
      clipperRef.current = clipper;
      if (import.meta.env.DEV) (window as any).__viewer = { components, world, fragments, highlighter, hider, OBC };
      setReady(true);

      cleanup = () => {
        canvas.removeEventListener("mousedown", onCanvasDown);
        canvas.removeEventListener("mousemove", onCanvasMove);
        canvas.removeEventListener("mouseup", onCanvasUp);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("contextmenu", onContextMenu);
        window.removeEventListener("keydown", onKeyDown);
        clipper.onAfterDelete.remove(onAfterDelete);
        resizeObserver.disconnect();
        world.camera.controls.removeEventListener("rest", requestUpdate);
        world.camera.controls.removeEventListener("update", requestUpdate);
        if (fragments.initialized) {
          fragments.list.onItemSet.remove(onItemSet);
          fragments.list.onItemDeleted.remove(onItemDeleted);
          fragments.onFragmentsLoaded.remove(onFragmentsLoaded);
        }
        world.camera.projection.onChanged.remove(onProjectionChanged);
        world.camera.projection.onChanged.remove(applyMouseBindings);
        highlighter.events.select.onHighlight.remove(onHighlight);
        highlighter.events.select.onClear.remove(onClear);
        components.dispose();
      };

      if (disposed) {
        cleanup();
        cleanup = null;
      }
    })();

    return () => {
      disposed = true;
      if (cleanup) cleanup();
      componentsRef.current = null;
      worldRef.current = null;
      fragmentsRef.current = null;
      highlighterRef.current = null;
      hiderRef.current = null;
      clipperRef.current = null;
      clipModeRef.current = false;
      measureGroupRef.current = null;
      measureAnchorRef.current = null;
      measureAnchorVisualRef.current = null;
      measureModeRef.current = false;
      volumeModeRef.current = false;
      volumePointsRef.current = [];
      volumeMarkersRef.current = [];
      pickFirstVisibleRef.current = null;
      setReady(false);
      setModels([]);
      setSelection(null);
      setSelectionMap({});
      selectionMapRef.current = {};
      setClipModeState(false);
      setClipCount(0);
      setMeasureModeState(false);
      setMeasureCount(0);
      setVolumeModeState(false);
      setVolumePointCount(0);
    };
  }, [containerRef]);

  const loadIfcBytes = useCallback(
    async (
      bytes: Uint8Array,
      modelId: string,
      displayName?: string,
    ): Promise<Uint8Array | null> => {
      const components = componentsRef.current;
      const fragments = fragmentsRef.current;
      if (!components || !fragments?.initialized) return null;

      setLoading(true);
      setError(null);
      try {
        displayNamesRef.current.set(modelId, displayName ?? modelId);
        const ifcLoader = components.get(OBC.IfcLoader);
        await ifcLoader.setup({
          autoSetWasm: false,
          // Must follow Vite's base: a root-absolute "/wasm/" 404s as soon as
          // the app is served from a subpath, which is exactly what a GitHub
          // Pages project site does.
          wasm: { path: `${import.meta.env.BASE_URL}wasm/`, absolute: false },
        });
        const model = await ifcLoader.load(bytes, true, modelId, {
          // IFCGROUP není v defaultním class setu importeru a členská relace
          // IFCRELASSIGNSTOGROUP není v defaultní relations mapě — bez obojího
          // se rozpočtové skupiny do .frag vůbec nedostanou. Modely
          // fragmentované před touto změnou skupiny nemají; je potřeba
          // re-import IFC.
          instanceCallback: (importer: any) => {
            importer.classes.abstract.add(WEBIFC_IFCGROUP);
            importer.relations.set(WEBIFC_IFCRELASSIGNSTOGROUP, {
              forRelating: "IsGroupedBy",
              forRelated: "HasAssignments",
            });
          },
        });
        try {
          const buf = await model.getBuffer(false);
          return new Uint8Array(buf);
        } catch (e) {
          console.warn("[viewer] getBuffer failed; frag cache skipped", e);
          return null;
        }
      } catch (e: any) {
        setError(e?.message ?? "IFC load failed");
        console.error(e);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const loadFragBytes = useCallback(
    async (bytes: Uint8Array, modelId: string, displayName?: string) => {
      const fragments = fragmentsRef.current;
      if (!fragments?.initialized) return;

      setLoading(true);
      setError(null);
      try {
        displayNamesRef.current.set(modelId, displayName ?? modelId);
        await fragments.core.load(bytes, { modelId, raw: false });
      } catch (e: any) {
        setError(e?.message ?? "Frag load failed");
        console.error(e);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const loadObjBytes = useCallback(
    async (bytes: Uint8Array, modelId: string, displayName?: string) => {
      const world = worldRef.current;
      if (!world) return;

      setLoading(true);
      setError(null);
      try {
        const model = parseObj(
          new TextDecoder().decode(bytes),
          modelId,
          displayName ?? modelId,
        );
        if (!model.parts.size) {
          throw new Error("This OBJ file contains no geometry");
        }
        displayNamesRef.current.set(modelId, displayName ?? modelId);
        meshModelsRef.current.set(modelId, model);
        world.scene.three.add(model.object);
        syncModelsRef.current?.();
      } catch (e: any) {
        setError(e?.message ?? "OBJ load failed");
        console.error(e);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  /** Parts of a loaded OBJ, for the structure tree. Empty for IFC models. */
  const getMeshParts = useCallback((modelId: string) => {
    const model = meshModelsRef.current.get(modelId);
    return model ? [...model.parts.values()] : [];
  }, []);

  const loadIfc = useCallback(
    async (file: File) => {
      const buffer = new Uint8Array(await file.arrayBuffer());
      await loadIfcBytes(buffer, file.name, file.name);
    },
    [loadIfcBytes],
  );

  /**
   * Put every swapped material back. Must run before any OBJ model is
   * disposed: disposeMeshModel frees whatever material a mesh is holding, and
   * a highlighted mesh is holding the shared tint, which every later
   * selection would then be missing.
   */
  const restoreMeshHighlights = useCallback(() => {
    for (const [mesh, material] of meshHighlightsRef.current) {
      mesh.material = material;
    }
    meshHighlightsRef.current.clear();
  }, []);

  // Mirror the selection onto OBJ geometry. Fragments models are handled by
  // the Highlighter; this covers the meshes it cannot see.
  useEffect(() => {
    const models = meshModelsRef.current;
    const highlighted = meshHighlightsRef.current;
    if (!models.size && !highlighted.size) return;

    const wanted = new Set<THREE.Mesh>();
    for (const [modelId, ids] of Object.entries(selectionMap)) {
      const model = models.get(modelId);
      if (!model) continue;
      for (const localId of ids) {
        const part = model.parts.get(localId);
        if (part) wanted.add(part.mesh);
      }
    }

    for (const [mesh, material] of highlighted) {
      if (!wanted.has(mesh)) {
        mesh.material = material;
        highlighted.delete(mesh);
      }
    }
    for (const mesh of wanted) {
      if (highlighted.has(mesh)) continue;
      highlighted.set(mesh, mesh.material);
      mesh.material = meshHighlightMaterial;
    }

    const fragments = fragmentsRef.current;
    if (fragments?.initialized) fragments.core.update(true);
  }, [selectionMap]);

  const clear = useCallback(() => {
    restoreMeshHighlights();
    for (const model of meshModelsRef.current.values()) disposeMeshModel(model);
    meshModelsRef.current.clear();

    const fragments = fragmentsRef.current;
    if (!fragments) {
      syncModelsRef.current?.();
      return;
    }
    const ids = Array.from(fragments.list.keys());
    for (const id of ids) {
      fragments.core.disposeModel(id).catch(() => {});
    }
    propertyIndexCache.current.clear();
    setSelection(null);
    selectionMapRef.current = {};
    setSelectionMap({});
    syncModelsRef.current?.();
    if (fragments.initialized) fragments.core.update(true);
  }, [restoreMeshHighlights]);

  const removeModel = useCallback(async (modelId: string) => {
    const meshModel = meshModelsRef.current.get(modelId);
    if (meshModel) {
      restoreMeshHighlights();
      disposeMeshModel(meshModel);
      meshModelsRef.current.delete(modelId);
      displayNamesRef.current.delete(modelId);
      setSelection((prev) => (prev?.modelId === modelId ? null : prev));
      syncModelsRef.current?.();
      return;
    }

    const fragments = fragmentsRef.current;
    if (!fragments) return;
    try {
      await fragments.core.disposeModel(modelId);
    } catch (e) {
      console.error("[viewer] removeModel failed", e);
      return;
    }
    setSelection((prev) => (prev?.modelId === modelId ? null : prev));
    if (selectionMapRef.current[modelId]) {
      const next = { ...selectionMapRef.current };
      delete next[modelId];
      selectionMapRef.current = next;
      setSelectionMap(next);
    }
    if (fragments.initialized) fragments.core.update(true);
  }, [restoreMeshHighlights]);

  const setVisibility = useCallback(async (visible: boolean, items?: OBC.ModelIdMap) => {
    setMeshPartsVisible(meshModelsRef.current, visible, items as any);
    const hider = hiderRef.current;
    if (!hider) {
      bumpRuntimeVisibility();
      return;
    }
    await hider.set(visible, items);
    bumpRuntimeVisibility();
  }, [bumpRuntimeVisibility]);

  // Drop just-hidden ids from the highlighter selection. Without this the
  // hidden elements stay "selected" as ghosts — the properties panel keeps
  // showing them and an additive drag-select merges them right back.
  // `items` = per-model ids that went invisible; a null id set means the
  // whole model went invisible (drop all its selected ids).
  const pruneSelection = useCallback(
    async (items: Record<string, Set<number> | null>) => {
      const highlighter = highlighterRef.current;
      if (!highlighter) return;
      const current = selectionMapRef.current;
      let changed = false;
      const next: Record<string, Set<number>> = {};
      for (const [mid, ids] of Object.entries(current)) {
        if (!(mid in items)) {
          next[mid] = ids;
          continue;
        }
        const hiddenSet = items[mid];
        if (hiddenSet === null) {
          changed = true;
          continue;
        }
        const kept = new Set<number>();
        for (const id of ids) if (!hiddenSet.has(id)) kept.add(id);
        if (kept.size !== ids.size) changed = true;
        if (kept.size) next[mid] = kept;
      }
      if (!changed) return;
      try {
        if (Object.keys(next).length) {
          await highlighter.highlightByID("select", next as any, true, false);
        } else {
          await highlighter.clear("select");
        }
      } catch (e) {
        console.warn("[viewer] pruneSelection failed", e);
      }
    },
    [],
  );

  const isolate = useCallback(async (items: OBC.ModelIdMap) => {
    const hider = hiderRef.current;
    const fragments = fragmentsRef.current;
    // OBJ parts are plain meshes the Hider cannot see, so their visibility is
    // driven directly. Done before the early return: a scene of only OBJ
    // models has no Hider to speak of.
    isolateMeshParts(meshModelsRef.current, items as any);
    if (!hider) return;
    // hider.isolate(items) only affects models present in items. In multi-model
    // scenes "isolate" must hide everything else, including geometry of models
    // not referenced in items — otherwise an agent / filter isolate on model A
    // leaves model B fully visible. Toggle model.object.visible directly
    // (transient — not persisted to manifest, reset by showAll()).
    if (fragments) {
      const targetKeys = new Set(Object.keys(items));
      for (const [key, m] of fragments.list as any) {
        const mid = (m as any)?.modelId ?? key;
        const obj = (m as any)?.object;
        if (!obj || typeof obj.visible !== "boolean") continue;
        obj.visible = targetKeys.has(mid);
      }
    }
    await hider.isolate(items);
    // Selection outside the isolated set just went invisible — prune it
    // (models absent from items are fully hidden → drop; models present
    // keep only the intersection with the isolated ids).
    const sel = selectionMapRef.current;
    const pruneMap: Record<string, Set<number> | null> = {};
    for (const [mid, ids] of Object.entries(sel)) {
      const target = (items as any)[mid];
      if (!target) {
        pruneMap[mid] = null;
        continue;
      }
      const visSet: Set<number> =
        target instanceof Set ? target : new Set(target as number[]);
      const hiddenIds = new Set<number>();
      for (const id of ids) if (!visSet.has(id)) hiddenIds.add(id);
      if (hiddenIds.size) pruneMap[mid] = hiddenIds;
    }
    if (Object.keys(pruneMap).length) await pruneSelection(pruneMap);
    if (fragments?.initialized) fragments.core.update(true);
    bumpRuntimeVisibility();
  }, [bumpRuntimeVisibility, pruneSelection]);

  // Normalize ModelIdMap (Set or array) → Record<modelId, Set<number>> for
  // intersect-friendly storage.
  const normalizeIdMap = (items: OBC.ModelIdMap) => {
    const out: Record<string, Set<number>> = {};
    for (const [mid, ids] of Object.entries(items)) {
      if (!ids) continue;
      out[mid] = ids instanceof Set ? new Set(ids as Set<number>) : new Set(ids as number[]);
    }
    return out;
  };

  const setIsolationRoot = useCallback((items: OBC.ModelIdMap | null) => {
    isolationRootRef.current = items ? normalizeIdMap(items) : null;
    setIsolationRootVersion((v) => v + 1);
  }, []);

  const getIsolationRoot = useCallback(
    () => isolationRootRef.current,
    [],
  );

  const hide = useCallback(async (items: OBC.ModelIdMap) => {
    setMeshPartsVisible(meshModelsRef.current, false, items as any);
    const hider = hiderRef.current;
    if (hider) await hider.set(false, items);
    const pruneMap: Record<string, Set<number> | null> = {};
    for (const [mid, ids] of Object.entries(items)) {
      if (!ids) continue;
      pruneMap[mid] =
        ids instanceof Set ? (ids as Set<number>) : new Set(ids as number[]);
    }
    await pruneSelection(pruneMap);
    bumpRuntimeVisibility();
  }, [bumpRuntimeVisibility, pruneSelection]);

  // Restore fragment-level visibility for ONE model without touching any
  // other model. Catalog cache enumerates the elements when available;
  // otherwise we ask the model itself which items the hider turned off and
  // re-show exactly those. Never falls back to a global hider.set(true) —
  // that used to leak across models (un-hiding model B resurrected hidden
  // IFCSPACE elements of model A).
  const restoreModelElements = useCallback(async (modelId: string) => {
    const hider = hiderRef.current;
    const fragments = fragmentsRef.current;
    const model: any = fragments?.list.get(modelId);
    if (!hider || !model) return;
    const idx = propertyIndexCache.current.get(modelId);
    if (idx && idx.categoryByElement.size > 0) {
      const allIds = new Set<number>(idx.categoryByElement.keys());
      await hider.set(true, { [modelId]: allIds });
      return;
    }
    try {
      const hiddenIds = await model.getItemsByVisibility?.(false);
      if (Array.isArray(hiddenIds) && hiddenIds.length) {
        await hider.set(true, { [modelId]: new Set<number>(hiddenIds) });
      }
    } catch (e) {
      console.warn("[viewer] restoreModelElements failed", modelId, e);
    }
  }, []);

  // Set EXACT element visibility for one model without touching any other
  // model. OBC.Hider.isolate(map) is global — it hides everything in every
  // model first (set(false)) and then shows the map, so it must never be
  // used for per-model operations like tree storey/category toggles. This
  // diffs against the model's current hider state and applies two scoped
  // set() calls instead.
  const setModelExactVisibility = useCallback(
    async (modelId: string, visibleIds: Set<number>) => {
      const hider = hiderRef.current;
      const fragments = fragmentsRef.current;
      const model: any = fragments?.list.get(modelId);
      if (!hider || !model) return;
      try {
        const curVisible: number[] =
          (await model.getItemsByVisibility?.(true)) ?? [];
        const curHidden: number[] =
          (await model.getItemsByVisibility?.(false)) ?? [];
        const toHide = curVisible.filter((id) => !visibleIds.has(id));
        const toShow = curHidden.filter((id) => visibleIds.has(id));
        if (toHide.length) await hider.set(false, { [modelId]: new Set(toHide) });
        if (toShow.length) await hider.set(true, { [modelId]: new Set(toShow) });
        if (toHide.length) {
          await pruneSelection({ [modelId]: new Set(toHide) });
        }
      } catch (e) {
        console.warn("[viewer] setModelExactVisibility failed", modelId, e);
        return;
      }
      if (fragments?.initialized) fragments.core.update(true);
      bumpRuntimeVisibility();
    },
    [bumpRuntimeVisibility, pruneSelection],
  );
  // model without touching other intentionally-hidden models. Used by tree's
  // empty-hidden-set path so toggling the last hidden patro back on doesn't
  // also un-hide another model the user wanted gone.
  const showModelAll = useCallback(async (modelId: string) => {
    const fragments = fragmentsRef.current;
    const model: any = fragments?.list.get(modelId);
    if (!model) return;
    await restoreModelElements(modelId);
    if (typeof model.object?.visible === "boolean") {
      model.object.visible = true;
    }
    if (fragments?.initialized) fragments.core.update(true);
    bumpRuntimeVisibility();
  }, [bumpRuntimeVisibility, restoreModelElements]);

  const showAll = useCallback(async () => {
    setMeshPartsVisible(meshModelsRef.current, true);
    const hider = hiderRef.current;
    const fragments = fragmentsRef.current;
    if (!hider) {
      isolationRootRef.current = null;
      setIsolationRootVersion((v) => v + 1);
      setShowAllVersion((v) => v + 1);
      bumpRuntimeVisibility();
      return;
    }
    await hider.set(true);
    if (fragments) {
      for (const [, model] of fragments.list as any) {
        if (model?.object && typeof model.object.visible === "boolean") {
          model.object.visible = true;
        }
      }
    }
    if (fragments?.initialized) fragments.core.update(true);
    isolationRootRef.current = null;
    setIsolationRootVersion((v) => v + 1);
    setShowAllVersion((v) => v + 1);
    bumpRuntimeVisibility();
  }, [bumpRuntimeVisibility]);

  const setClipMode = useCallback((enabled: boolean) => {
    clipModeRef.current = enabled;
    setClipModeState(enabled);
    clearSnapHoverRef.current?.();
    if (enabled) exitPolylineRef.current?.();
    // Clip, measure, volume, polyline are mutually exclusive — all consume
    // left-click.
    if (enabled && measureModeRef.current) {
      const group = measureGroupRef.current;
      if (measureAnchorVisualRef.current && group) {
        group.remove(measureAnchorVisualRef.current);
        disposeObject(measureAnchorVisualRef.current);
      }
      measureAnchorVisualRef.current = null;
      measureAnchorRef.current = null;
      measureModeRef.current = false;
      setMeasureModeState(false);
    }
    if (enabled && volumeModeRef.current) {
      const group = measureGroupRef.current;
      if (group) {
        for (const m of volumeMarkersRef.current) {
          group.remove(m);
          disposeObject(m);
        }
      }
      volumeMarkersRef.current = [];
      volumePointsRef.current = [];
      setVolumePointCount(0);
      volumeModeRef.current = false;
      setVolumeModeState(false);
    }
  }, []);

  const cancelMeasureAnchor = useCallback(() => {
    const group = measureGroupRef.current;
    if (measureAnchorVisualRef.current && group) {
      group.remove(measureAnchorVisualRef.current);
      disposeObject(measureAnchorVisualRef.current);
    }
    measureAnchorVisualRef.current = null;
    measureAnchorRef.current = null;
  }, []);

  const setMeasureMode = useCallback(
    (enabled: boolean) => {
      measureModeRef.current = enabled;
      setMeasureModeState(enabled);
      clearSnapHoverRef.current?.();
      if (!enabled) cancelMeasureAnchor();
      if (enabled) exitPolylineRef.current?.();
      if (enabled && clipModeRef.current) {
        clipModeRef.current = false;
        setClipModeState(false);
      }
      if (enabled && volumeModeRef.current) {
        const group = measureGroupRef.current;
        if (group) {
          for (const m of volumeMarkersRef.current) {
            group.remove(m);
            disposeObject(m);
          }
        }
        volumeMarkersRef.current = [];
        volumePointsRef.current = [];
        setVolumePointCount(0);
        volumeModeRef.current = false;
        setVolumeModeState(false);
      }
    },
    [cancelMeasureAnchor],
  );

  const clearVolumePending = useCallback(() => {
    const group = measureGroupRef.current;
    if (group) {
      for (const m of volumeMarkersRef.current) {
        group.remove(m);
        disposeObject(m);
      }
    }
    volumeMarkersRef.current = [];
    volumePointsRef.current = [];
    setVolumePointCount(0);
  }, []);

  const setVolumeMode = useCallback(
    (enabled: boolean) => {
      volumeModeRef.current = enabled;
      setVolumeModeState(enabled);
      clearSnapHoverRef.current?.();
      if (!enabled) {
        clearVolumePending();
      } else {
        exitPolylineRef.current?.();
        // Mutex against measure / clip — both consume left-click.
        if (measureModeRef.current) {
          measureModeRef.current = false;
          setMeasureModeState(false);
          cancelMeasureAnchor();
        }
        if (clipModeRef.current) {
          clipModeRef.current = false;
          setClipModeState(false);
        }
      }
    },
    [cancelMeasureAnchor, clearVolumePending],
  );

  const undoVolumePoint = useCallback(() => {
    const group = measureGroupRef.current;
    if (!volumePointsRef.current.length) return;
    volumePointsRef.current.pop();
    const marker = volumeMarkersRef.current.pop();
    if (marker && group) {
      group.remove(marker);
      disposeObject(marker);
    }
    setVolumePointCount(volumePointsRef.current.length);
    const fragments = fragmentsRef.current;
    if (fragments?.initialized) fragments.core.update(true);
  }, []);

  const cancelVolume = useCallback(() => {
    clearVolumePending();
    volumeModeRef.current = false;
    setVolumeModeState(false);
    const fragments = fragmentsRef.current;
    if (fragments?.initialized) fragments.core.update(true);
  }, [clearVolumePending]);

  const finalizeVolume = useCallback(() => {
    const group = measureGroupRef.current;
    if (!group) return;
    const pts = volumePointsRef.current;
    if (pts.length < 4) {
      // Need at least tetrahedron for finite volume; just discard.
      clearVolumePending();
      return;
    }
    // Strip pending markers — final mesh will carry its own endpoint dots.
    for (const m of volumeMarkersRef.current) {
      group.remove(m);
      disposeObject(m);
    }
    volumeMarkersRef.current = [];
    let built: { object: THREE.Object3D; volume: number } | null = null;
    try {
      built = makeVolumeMeasurement(pts);
    } catch (e) {
      console.warn("[viewer] volume hull build failed", e);
      volumePointsRef.current = [];
      setVolumePointCount(0);
      return;
    }
    if (built) {
      group.add(built.object);
      setMeasureCount(countMeasurements(group));
      setPendingMeasurement({
        kind: "volume-hull",
        value: built.volume,
        unit: "m³",
        points: pts.map((p): [number, number, number] => [p.x, p.y, p.z]),
      });
    }
    volumePointsRef.current = [];
    setVolumePointCount(0);
    volumeModeRef.current = false;
    setVolumeModeState(false);
    const fragments = fragmentsRef.current;
    if (fragments?.initialized) fragments.core.update(true);
  }, [clearVolumePending]);

  // Keep keydown closure refs in sync.
  finalizeVolumeRef.current = finalizeVolume;
  cancelVolumeRef.current = cancelVolume;
  undoVolumePointRef.current = undoVolumePoint;

  // ── Polyline measurement (open chain, sum of segment lengths) ──
  const clearPolylinePending = useCallback(() => {
    const group = measureGroupRef.current;
    if (group) {
      for (const o of polylineObjectsRef.current) {
        group.remove(o);
        disposeObject(o);
      }
    }
    polylineObjectsRef.current = [];
    polylinePointsRef.current = [];
    setPolylinePointCount(0);
  }, []);

  const setPolylineMode = useCallback(
    (enabled: boolean) => {
      polylineModeRef.current = enabled;
      setPolylineModeState(enabled);
      clearSnapHoverRef.current?.();
      if (!enabled) {
        clearPolylinePending();
      } else {
        // Mutex against measure / clip / volume — all consume left-click.
        if (measureModeRef.current) {
          measureModeRef.current = false;
          setMeasureModeState(false);
          cancelMeasureAnchor();
        }
        if (clipModeRef.current) {
          clipModeRef.current = false;
          setClipModeState(false);
        }
        if (volumeModeRef.current) {
          clearVolumePending();
          volumeModeRef.current = false;
          setVolumeModeState(false);
        }
      }
    },
    [cancelMeasureAnchor, clearPolylinePending, clearVolumePending],
  );

  const undoPolylinePoint = useCallback(() => {
    const group = measureGroupRef.current;
    const pts = polylinePointsRef.current;
    if (!pts.length) return;
    pts.pop();
    // Each point after the first added a marker + a segment line; the first
    // added only a marker. Pop the trailing objects accordingly.
    const popCount = pts.length === 0 ? 1 : 2;
    for (let i = 0; i < popCount; i++) {
      const o = polylineObjectsRef.current.pop();
      if (o && group) {
        group.remove(o);
        disposeObject(o);
      }
    }
    setPolylinePointCount(pts.length);
    const fragments = fragmentsRef.current;
    if (fragments?.initialized) fragments.core.update(true);
  }, []);

  const cancelPolyline = useCallback(() => {
    clearPolylinePending();
    polylineModeRef.current = false;
    setPolylineModeState(false);
    clearSnapHoverRef.current?.();
    const fragments = fragmentsRef.current;
    if (fragments?.initialized) fragments.core.update(true);
  }, [clearPolylinePending]);

  const finalizePolyline = useCallback(() => {
    const group = measureGroupRef.current;
    if (!group) return;
    const pts = polylinePointsRef.current;
    if (pts.length < 2) {
      clearPolylinePending();
      polylineModeRef.current = false;
      setPolylineModeState(false);
      return;
    }
    const points = pts.map((p) => p.clone());
    // Strip pending markers/segments — the final object carries its own.
    for (const o of polylineObjectsRef.current) {
      group.remove(o);
      disposeObject(o);
    }
    polylineObjectsRef.current = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) total += points[i].distanceTo(points[i - 1]);
    const visualId = nextMeasurementId();
    group.add(makePolyline(points, total, visualId));
    setMeasureCount(countMeasurements(group));
    setPendingMeasurement({
      kind: "polyline",
      visualId,
      value: total,
      unit: "m",
      points: points.map((p): [number, number, number] => [p.x, p.y, p.z]),
    });
    polylinePointsRef.current = [];
    setPolylinePointCount(0);
    polylineModeRef.current = false;
    setPolylineModeState(false);
    clearSnapHoverRef.current?.();
    const fragments = fragmentsRef.current;
    if (fragments?.initialized) fragments.core.update(true);
  }, [clearPolylinePending]);

  finalizePolylineRef.current = finalizePolyline;
  cancelPolylineRef.current = cancelPolyline;
  undoPolylinePointRef.current = undoPolylinePoint;
  exitPolylineRef.current = cancelPolyline;

  const setSnapEnabled = useCallback((enabled: boolean) => {
    snapEnabledRef.current = enabled;
    setSnapEnabledState(enabled);
    if (!enabled) clearSnapHoverRef.current?.();
  }, []);

  /**
   * Drop the objects drawn for one measurement. The panel owns the list, the
   * viewer owns the scene, and `visualId` is the only thing joining them —
   * without this a deleted row leaves its line and label floating in the model.
   */
  const removeMeasurementVisual = useCallback((visualId: string) => {
    const group = measureGroupRef.current;
    if (!group) return;
    const target = group.children.find(
      (child) => (child as any).userData?.measurementId === visualId,
    );
    if (!target) return;
    group.remove(target);
    disposeObject(target);
    setMeasureCount(countMeasurements(group));
    const fragments = fragmentsRef.current;
    if (fragments?.initialized) fragments.core.update(true);
  }, []);

  const deleteAllMeasurements = useCallback(() => {
    const group = measureGroupRef.current;
    if (!group) return;
    cancelMeasureAnchor();
    clearVolumePending();
    clearPolylinePending();
    clearSnapHoverRef.current?.();
    const children = [...group.children];
    for (const c of children) {
      group.remove(c);
      disposeObject(c);
    }
    setMeasureCount(0);
    const fragments = fragmentsRef.current;
    if (fragments?.initialized) fragments.core.update(true);
  }, [cancelMeasureAnchor, clearVolumePending, clearPolylinePending]);

  const clipFromHit = useCallback(
    (normal: THREE.Vector3, point: THREE.Vector3) => {
      const clipper = clipperRef.current;
      const world = worldRef.current;
      if (!clipper || !world) return;
      clipper.createFromNormalAndCoplanarPoint(world, normal, point);
      setClipCount(clipper.list.size);
    },
    [],
  );

  const deleteAllClips = useCallback(() => {
    const clipper = clipperRef.current;
    if (!clipper) return;
    clipper.deleteAll();
    setClipCount(0);
  }, []);

  // Flip every clipping plane to its opposite half-space — same position, the
  // normal is negated so the cut hides the other side. A face-aligned cut
  // (right-click "Řez tímto") clips away whatever the picked face points
  // toward; flipping lets the user choose the positive vs negative side
  // without re-picking. setFromNormalAndCoplanarPoint also repositions the
  // helper gizmo so the visual arrow follows.
  const flipClips = useCallback(() => {
    const clipper = clipperRef.current;
    if (!clipper) return;
    const fragments = fragmentsRef.current;
    for (const plane of clipper.list.values() as IterableIterator<any>) {
      const normal = plane.normal.clone().negate();
      const origin = plane.origin.clone();
      plane.setFromNormalAndCoplanarPoint(normal, origin);
      plane.update?.();
    }
    if (fragments?.initialized) fragments.core.update(true);
  }, []);

  // Snapshot the active clipping planes for a saved view. Each plane carries
  // `normal` + `origin` (a coplanar point); both are enough to rebuild it via
  // createFromNormalAndCoplanarPoint on restore.
  const captureClips = useCallback((): SavedViewClip[] => {
    const clipper = clipperRef.current;
    if (!clipper) return [];
    const out: SavedViewClip[] = [];
    for (const plane of clipper.list.values() as IterableIterator<any>) {
      const n = plane.normal;
      const o = plane.origin;
      if (!n || !o) continue;
      out.push({ normal: [n.x, n.y, n.z], point: [o.x, o.y, o.z] });
    }
    return out;
  }, []);

  // Restore a saved view's section cuts: drop the current planes, then rebuild
  // each saved one. An empty list clears all clips (a view without a section
  // removes any active cut), so callers should always pass `v.clips ?? []`.
  const applyClips = useCallback((clips: SavedViewClip[]) => {
    const clipper = clipperRef.current;
    const world = worldRef.current;
    if (!clipper || !world) return;
    clipper.deleteAll();
    for (const c of clips) {
      const normal = new THREE.Vector3(c.normal[0], c.normal[1], c.normal[2]);
      const point = new THREE.Vector3(c.point[0], c.point[1], c.point[2]);
      clipper.createFromNormalAndCoplanarPoint(world, normal, point);
    }
    setClipCount(clipper.list.size);
    const fragments = fragmentsRef.current;
    if (fragments?.initialized) fragments.core.update(true);
  }, []);

  const pickAt = useCallback(
    async (clientX: number, clientY: number) => {
      const world = worldRef.current;
      const pick = pickFirstVisibleRef.current;
      if (!world || !pick) return null;
      const mouse = new THREE.Vector2(clientX, clientY);
      try {
        const hit: any = await pick(mouse);
        if (!hit || hit.localId === undefined || hit.localId === null) return null;
        const modelId = hit.fragments?.modelId;
        if (!modelId) return null;
        return {
          modelId: modelId as string,
          localId: hit.localId as number,
          point: hit.point as THREE.Vector3 | undefined,
          normal: hit.normal as THREE.Vector3 | undefined,
        };
      } catch (e) {
        console.error("[viewer] pickAt failed", e);
        return null;
      }
    },
    [],
  );

  const setModelHidden = useCallback(
    async (modelId: string, hidden: boolean) => {
      const meshModel = meshModelsRef.current.get(modelId);
      if (meshModel) {
        meshModel.object.visible = !hidden;
        if (hidden) await pruneSelection({ [modelId]: null });
        bumpRuntimeVisibility();
        return;
      }

      const fragments = fragmentsRef.current;
      const model: any = fragments?.list.get(modelId);
      if (!model) return;
      try {
        if (typeof model.object?.visible === "boolean") {
          model.object.visible = !hidden;
        }
        // When un-hiding a whole model, also restore fragment-level visibility
        // — prior hider operations (filter isolate, agent isolate, category
        // toggle) may have left individual elements invisible and
        // model.object.visible=true alone won't override that GPU-instance
        // mask. Scoped strictly to THIS model so hidden elements of other
        // models stay hidden.
        if (!hidden) {
          await restoreModelElements(modelId);
        } else {
          // Whole model went invisible — its elements must leave the
          // selection (ghost selection otherwise).
          await pruneSelection({ [modelId]: null });
        }
        if (fragments?.initialized) fragments.core.update(true);
        bumpRuntimeVisibility();
      } catch (e) {
        console.warn("[viewer] setModelHidden failed", e);
      }
    },
    [bumpRuntimeVisibility, pruneSelection, restoreModelElements],
  );

  const getModelGroups = useCallback(async (modelId: string) => {
    const components = componentsRef.current;
    const fragments = fragmentsRef.current;
    if (!components || !fragments?.list.get(modelId)) return null;

    const classifier = components.get(OBC.Classifier);
    const finder = components.get(OBC.ItemsFinder);

    // Run classifications globally across all loaded models, idempotently.
    // ItemsFinder.addFromCategories skips categories already registered, so
    // we must reset both classifier entries AND finder entries before each
    // re-run; otherwise the second invocation produces empty Categories.
    classifier.list.delete("Storeys");
    classifier.list.delete("Categories");
    finder.list.clear();

    await classifier.byIfcBuildingStorey();
    await classifier.byCategory();

    const storeysMap = classifier.list.get("Storeys");
    const catsMap = classifier.list.get("Categories");

    const pickForModel = (full: OBC.ModelIdMap): OBC.ModelIdMap | null => {
      const ids = (full as any)[modelId];
      if (!ids) return null;
      const size = ids instanceof Set ? ids.size : (ids as any).length;
      if (!size) return null;
      return { [modelId]: ids };
    };

    const inclusiveStoreys = await buildInclusiveStoreys(
      fragments.list.get(modelId),
    );

    const storeys: Array<{ name: string; items: OBC.ModelIdMap }> = [];
    if (storeysMap) {
      for (const [name, data] of storeysMap) {
        const incIds = inclusiveStoreys.get(name);
        if (incIds && incIds.size) {
          storeys.push({ name, items: { [modelId]: incIds } });
          continue;
        }
        const items = await data.get();
        const scoped = pickForModel(items);
        if (scoped) storeys.push({ name, items: scoped });
      }
    }

    const categories: Array<{ name: string; items: OBC.ModelIdMap }> = [];
    if (catsMap) {
      for (const [name, data] of catsMap) {
        const items = await data.get();
        const scoped = pickForModel(items);
        if (scoped) categories.push({ name, items: scoped });
      }
    }

    return { storeys, categories };
  }, []);

  const getItemData = useCallback(
    async (modelId: string, localId: number) => {
      const fragments = fragmentsRef.current;
      const model = fragments?.list.get(modelId);
      if (!model) return null;
      const [data] = await model.getItemsData([localId], {
        attributesDefault: true,
        relations: {
          IsDefinedBy: { attributes: true, relations: true },
          AssociatesMaterial: { attributes: true, relations: true },
          ContainedInStructure: { attributes: true, relations: false },
        },
        relationsDefault: { attributes: false, relations: false },
      });
      return data ?? null;
    },
    [],
  );

  const getRawModel = useCallback((modelId: string): any => {
    return fragmentsRef.current?.list.get(modelId) ?? null;
  }, []);

  // Mesh-volume: sum the actual triangulated mesh volume of every selected
  // element by delegating to fragments' worker-side `getItemsVolume`. This
  // is the exact volume of the elements themselves (not the gap between
  // stacked elements — for that, export to OBJ and use an external tool).
  const measureMeshVolume = useCallback(async (): Promise<number> => {
    const sel = selectionMapRef.current;
    const fragments = fragmentsRef.current;
    if (!fragments) throw new Error("Viewer not ready");
    let total = 0;
    let touched = 0;
    for (const [mid, set] of Object.entries(sel)) {
      const model: any = fragments.list.get(mid);
      if (!model) continue;
      const ids = Array.from(set);
      if (!ids.length) continue;
      try {
        const v = await model.getItemsVolume?.(ids);
        if (typeof v === "number" && Number.isFinite(v)) {
          total += v;
          touched++;
        }
      } catch (e) {
        console.warn("[viewer] getItemsVolume failed", mid, e);
      }
    }
    if (!touched) {
      throw new Error("Vyber alespoň 1 prvek; nepodařilo se získat objem.");
    }
    const group = measureGroupRef.current;
    if (group) {
      const elements: Array<{ modelId: string; localId: number }> = [];
      const centroidAccum = new THREE.Vector3();
      let centroidCount = 0;
      for (const [mid, idsSet] of Object.entries(sel)) {
        const model: any = fragments.list.get(mid);
        if (!model) continue;
        for (const id of idsSet) elements.push({ modelId: mid, localId: id });
        try {
          const box: THREE.Box3 = await model.getMergedBox(Array.from(idsSet));
          if (!box.isEmpty()) {
            const c = new THREE.Vector3();
            box.getCenter(c);
            centroidAccum.add(c);
            centroidCount++;
          }
        } catch {
          // skip
        }
      }
      const centroid: [number, number, number] = centroidCount
        ? [
            centroidAccum.x / centroidCount,
            centroidAccum.y / centroidCount,
            centroidAccum.z / centroidCount,
          ]
        : [0, 0, 0];
      const visual = makeVolumeLabelVisual(total, centroid);
      group.add(visual);
      setMeasureCount(countMeasurements(group));
      setPendingMeasurement({
        kind: "volume-mesh",
        value: total,
        unit: "m³",
        points: [centroid],
        elements,
      });
    }
    return total;
  }, []);

  const getPropertyIndex = useCallback(
    async (
      modelId: string,
      opts?: { onProgress?: (p: BuildProgress) => void; signal?: AbortSignal },
    ): Promise<PropertyIndex | null> => {
      const cached = propertyIndexCache.current.get(modelId);
      if (cached) return cached;
      const model = getRawModel(modelId);
      if (!model) return null;
      const index = await buildPropertyIndex(model, opts);
      propertyIndexCache.current.set(modelId, index);
      return index;
    },
    [getRawModel],
  );

  const peekPropertyIndex = useCallback(
    (modelId: string): PropertyIndex | null => {
      return propertyIndexCache.current.get(modelId) ?? null;
    },
    [],
  );

  const setPropertyIndex = useCallback((modelId: string, idx: PropertyIndex) => {
    propertyIndexCache.current.set(modelId, idx);
  }, []);

  const invalidatePropertyIndex = useCallback((modelId?: string) => {
    if (modelId) propertyIndexCache.current.delete(modelId);
    else propertyIndexCache.current.clear();
  }, []);

  const selectItem = useCallback(
    async (modelId: string, localId: number) => {
      const highlighter = highlighterRef.current;
      if (!highlighter) return;
      const map: OBC.ModelIdMap = { [modelId]: new Set([localId]) };
      await highlighter.highlightByID("select", map, true, false);
    },
    [],
  );

  const selectMany = useCallback(async (map: OBC.ModelIdMap) => {
    const highlighter = highlighterRef.current;
    if (!highlighter) return;
    await highlighter.highlightByID("select", map, true, false);
  }, []);

  const clearSelection = useCallback(async () => {
    const highlighter = highlighterRef.current;
    if (!highlighter) return;
    await highlighter.clear("select");
  }, []);

  const zoomToSelection = useCallback(async (map: OBC.ModelIdMap) => {
    const world = worldRef.current;
    const fragments = fragmentsRef.current;
    if (!world) return;
    const merged = new THREE.Box3();
    let hasAny = false;

    // OBJ parts: bounds straight off the scene graph.
    for (const [modelId, model] of meshModelsRef.current) {
      const ids = idsForModel(map as any, modelId);
      if (!ids) continue;
      for (const id of ids) {
        const part = model.parts.get(id);
        if (!part) continue;
        const box = new THREE.Box3().setFromObject(part.mesh);
        if (box.isEmpty()) continue;
        if (hasAny) {
          merged.union(box);
        } else {
          merged.copy(box);
          hasAny = true;
        }
      }
    }

    for (const [modelId, ids] of Object.entries(map)) {
      if (!fragments) break;
      const model: any = fragments.list.get(modelId);
      if (!model) continue;
      const idArr = ids instanceof Set ? Array.from(ids) : (ids as any[]);
      if (!idArr.length) continue;
      try {
        const box: THREE.Box3 = await model.getMergedBox(idArr);
        if (!box.isEmpty()) {
          if (!hasAny) {
            merged.copy(box);
            hasAny = true;
          } else {
            merged.union(box);
          }
        }
      } catch (e) {
        console.warn("[viewer] getMergedBox failed", modelId, e);
      }
    }
    if (!hasAny || merged.isEmpty()) return;
    const expanded = merged.clone().expandByScalar(merged.getSize(new THREE.Vector3()).length() * 0.1);
    try {
      await (world.camera.controls as any).fitToBox(expanded, true);
    } catch (e) {
      console.warn("[viewer] fitToBox failed", e);
    }
  }, []);

  // Recenter / "home" — fit the camera to every currently-visible model so a
  // user who orbited or panned off into empty space can get back to the model
  // in one click. Unions the merged box of each model's visible items, then
  // fitToBox. Falls back to a default framing when nothing is visible.
  const recenter = useCallback(async () => {
    const world = worldRef.current;
    const fragments = fragmentsRef.current;
    if (!world || !fragments) return;
    const merged = new THREE.Box3();
    let hasAny = false;
    // OBJ bounds come straight off the scene graph.
    const meshBounds = meshModelsBounds(
      [...meshModelsRef.current.values()].filter((m) => m.object.visible),
    );
    if (meshBounds) {
      merged.copy(meshBounds);
      hasAny = true;
    }
    for (const [, model] of fragments.list as any) {
      const obj = (model as any)?.object;
      if (obj && obj.visible === false) continue;
      try {
        const vis = await (model as any).getItemsByVisibility?.(true);
        const ids = Array.isArray(vis) ? vis : [];
        if (!ids.length) continue;
        const box: THREE.Box3 = await (model as any).getMergedBox(ids);
        if (!box.isEmpty()) {
          if (!hasAny) {
            merged.copy(box);
            hasAny = true;
          } else {
            merged.union(box);
          }
        }
      } catch (e) {
        console.warn("[viewer] recenter box failed", e);
      }
    }
    const controls = (world.camera.controls as any) ?? null;
    if (!controls) return;

    // Clipping planes track the model: this is the one moment we reliably know
    // how big the scene is, and it runs after every import.
    const diagonal =
      hasAny && !merged.isEmpty()
        ? merged.getSize(new THREE.Vector3()).length()
        : DEFAULT_SCENE_DIAGONAL;
    clipPlanesRef.current = clipPlanesForDiagonal(diagonal);
    applyCameraSettings(world, fovRef.current, clipPlanesRef.current);

    if (!hasAny || merged.isEmpty()) {
      try {
        await controls.setLookAt(12, 8, 12, 0, 0, 0, true);
      } catch (e) {
        console.warn("[viewer] recenter default lookAt failed", e);
      }
      return;
    }
    const expanded = merged
      .clone()
      .expandByScalar(merged.getSize(new THREE.Vector3()).length() * 0.1);
    try {
      await controls.fitToBox(expanded, true);
    } catch (e) {
      console.warn("[viewer] recenter fitToBox failed", e);
    }
  }, []);

  /** Vertical field of view in degrees; ignored in orthographic mode. */
  const setFov = useCallback((degrees: number) => {
    const clamped = Math.min(Math.max(degrees, MIN_FOV), MAX_FOV);
    fovRef.current = clamped;
    setFovState(clamped);
    const world = worldRef.current;
    if (!world) return;
    applyCameraSettings(world, clamped, clipPlanesRef.current);
    const fragments = fragmentsRef.current;
    if (fragments?.initialized) fragments.core.update(true);
  }, []);

  // Remember how the user likes to look at models.
  useEffect(() => {
    saveCameraSettings({ projection, fov });
  }, [projection, fov]);

  const setProjection = useCallback(async (mode: Projection) => {
    const world = worldRef.current;
    const proj: any = (world?.camera as any)?.projection;
    if (!proj?.set) return;
    const target = mode === "orthographic" ? "Orthographic" : "Perspective";
    if (proj.current?.toLowerCase?.() === target.toLowerCase()) return;
    try {
      await proj.set(target);
      // onProjectionChanged re-applies fov/clip planes and syncs React state.
    } catch (e) {
      console.warn("[viewer] setProjection failed", e);
    }
  }, []);

  const getWorld = useCallback(() => worldRef.current, []);

  // Returns current camera state — position, target, projection mode — so
  // a saved view can later restore camera framing exactly.
  const captureCamera = useCallback((): {
    position: [number, number, number];
    target: [number, number, number];
    projection: "perspective" | "orthographic";
  } | null => {
    const world = worldRef.current;
    if (!world) return null;
    const controls: any = world.camera.controls;
    const pos = new THREE.Vector3();
    const tgt = new THREE.Vector3();
    try {
      controls.getPosition?.(pos);
      controls.getTarget?.(tgt);
    } catch (e) {
      console.warn("[viewer] captureCamera read failed", e);
      return null;
    }
    let projection: "perspective" | "orthographic" = "perspective";
    try {
      const cur = (world.camera as any).projection?.current;
      if (typeof cur === "string") {
        projection = cur.toLowerCase().startsWith("ortho")
          ? "orthographic"
          : "perspective";
      }
    } catch {
      // ignore — keep default
    }
    return {
      position: [pos.x, pos.y, pos.z],
      target: [tgt.x, tgt.y, tgt.z],
      projection,
    };
  }, []);

  // Returns current selection as a serializable payload: Record<modelId,
  // localIds[]>. Captures whatever the highlighter currently holds.
  const captureSelection = useCallback((): Array<{
    modelId: string;
    localIds: number[];
  }> => {
    const out: Array<{ modelId: string; localIds: number[] }> = [];
    for (const [mid, set] of Object.entries(selectionMapRef.current)) {
      if (set && set.size) out.push({ modelId: mid, localIds: Array.from(set) });
    }
    return out;
  }, []);

  // Returns currently-visible item ids per model from the live hider state.
  // Used by Pohledy as a fallback when nothing is explicitly highlighted —
  // we still want the saved view to reproduce the visible subset of the
  // scene (typical agent / filter "Izolovat" flow doesn't always leave a
  // selection behind).
  const captureVisibleItems = useCallback(async (): Promise<Array<{
    modelId: string;
    localIds: number[];
  }>> => {
    const fragments = fragmentsRef.current;
    if (!fragments) return [];
    const out: Array<{ modelId: string; localIds: number[] }> = [];
    for (const [, model] of fragments.list as any) {
      const obj = (model as any).object;
      if (obj?.visible === false) continue; // whole-model hidden
      try {
        const visible: number[] = await (model as any).getItemsByVisibility?.(true);
        const hidden: number[] = await (model as any).getItemsByVisibility?.(false);
        // If the hider has never touched this model, both sets may be empty.
        // In that case nothing is "filtered" — the full model is visible and
        // we don't need to enumerate it (would be huge and the view restore
        // path treats an empty selection as "show all").
        if (
          (!visible || !visible.length) &&
          (!hidden || !hidden.length)
        ) {
          continue;
        }
        if (visible && visible.length) {
          out.push({
            modelId: (model as any).modelId,
            localIds: visible,
          });
        }
      } catch (e) {
        console.warn("[viewer] captureVisibleItems failed for model", e);
      }
    }
    return out;
  }, []);

  // Full per-model visibility snapshot: "hidden" (model toggled off),
  // "partial" (hider hides some elements; visibleIds enumerates the rest)
  // or "all" (untouched / fully visible). Unlike captureVisibleItems this
  // also records hidden models and explicitly distinguishes "all", so a
  // saved view can restore the exact scene in multi-model projects.
  const captureVisibilitySnapshot = useCallback(async (): Promise<
    VisibilitySnapshotEntry[]
  > => {
    const fragments = fragmentsRef.current;
    if (!fragments) return [];
    const out: VisibilitySnapshotEntry[] = [];
    for (const [key, model] of fragments.list as any) {
      const mid = (model as any)?.modelId ?? key;
      const obj = (model as any)?.object;
      if (obj && obj.visible === false) {
        out.push(chooseSnapshotMode(mid, [], [], true));
        continue;
      }
      try {
        const visible: number[] =
          (await (model as any).getItemsByVisibility?.(true)) ?? [];
        const hiddenIds: number[] =
          (await (model as any).getItemsByVisibility?.(false)) ?? [];
        out.push(chooseSnapshotMode(mid, visible, hiddenIds, false));
      } catch (e) {
        console.warn("[viewer] captureVisibilitySnapshot failed", mid, e);
        out.push({ modelId: mid, mode: "all", visibleIds: [] });
      }
    }
    return out;
  }, []);

  // Restore the scene to a saved visibility snapshot. Models absent from the
  // snapshot (added to the project later) are left fully visible. Partial
  // entries become the isolation root so subsequent tree toggles intersect
  // with the restored subset instead of resetting it.
  const applyVisibilitySnapshot = useCallback(
    async (snapshot: VisibilitySnapshotEntry[]) => {
      const fragments = fragmentsRef.current;
      const hider = hiderRef.current;
      if (!fragments || !hider) return;
      const byModel = new Map(snapshot.map((s) => [s.modelId, s]));
      const partialRoot: Record<string, Set<number>> = {};
      for (const [key, model] of fragments.list as any) {
        const mid = (model as any)?.modelId ?? key;
        const obj = (model as any)?.object;
        const entry = byModel.get(mid);
        const mode = entry?.mode ?? "all";
        if (obj && typeof obj.visible === "boolean") {
          obj.visible = mode !== "hidden";
        }
        if (mode === "hidden") continue;
        if (mode === "all") {
          await restoreModelElements(mid);
        } else if (mode === "partial-hidden" && entry) {
          // Show everything in this model, then hide the enumerated few.
          await restoreModelElements(mid);
          const ids = new Set<number>(entry.hiddenIds ?? []);
          if (ids.size) {
            try {
              await hider.set(false, { [mid]: ids });
            } catch (e) {
              console.warn("[viewer] applyVisibilitySnapshot hide failed", mid, e);
            }
          }
        } else if (entry) {
          // Scoped per-model diff — hider.isolate would globally hide every
          // other model's elements and undo the entries restored before it.
          const ids = new Set<number>(entry.visibleIds);
          partialRoot[mid] = ids;
          await setModelExactVisibility(mid, ids);
        }
      }
      isolationRootRef.current = Object.keys(partialRoot).length
        ? partialRoot
        : null;
      setIsolationRootVersion((v) => v + 1);
      if (fragments.initialized) fragments.core.update(true);
      bumpRuntimeVisibility();
    },
    [bumpRuntimeVisibility, restoreModelElements, setModelExactVisibility],
  );

  // One-stop capture for saved views: camera + visibility snapshot +
  // selection already filtered to visible elements. Used by the Pohledy
  // panel and the agent's save_view tool so both persist identical state.
  const captureViewState = useCallback(async (): Promise<{
    camera: ReturnType<typeof captureCamera>;
    selection: Array<{ modelId: string; localIds: number[] }>;
    visibility: VisibilitySnapshotEntry[];
    clips: SavedViewClip[];
  }> => {
    const camera = captureCamera();
    const visibility = await captureVisibilitySnapshot();
    const selection = filterSelectionBySnapshot(captureSelection(), visibility);
    const clips = captureClips();
    return { camera, selection, visibility, clips };
  }, [captureCamera, captureClips, captureSelection, captureVisibilitySnapshot]);

  // Restore camera from a saved view. Swap projection first (perspective
  // ↔ ortho re-binds camera.three), then setLookAt to position/target.
  const applyCamera = useCallback(
    async (cam: {
      position: [number, number, number];
      target: [number, number, number];
      projection: "perspective" | "orthographic";
    }) => {
      const world = worldRef.current;
      if (!world) return;
      try {
        const proj: any = (world.camera as any).projection;
        if (proj?.set) {
          const target = cam.projection === "orthographic" ? "Orthographic" : "Perspective";
          if (proj.current?.toLowerCase?.() !== target.toLowerCase()) {
            await proj.set(target);
          }
        }
      } catch (e) {
        console.warn("[viewer] applyCamera projection swap failed", e);
      }
      try {
        await (world.camera.controls as any).setLookAt(
          cam.position[0],
          cam.position[1],
          cam.position[2],
          cam.target[0],
          cam.target[1],
          cam.target[2],
          true,
        );
      } catch (e) {
        console.warn("[viewer] applyCamera setLookAt failed", e);
      }
      const fragments = fragmentsRef.current;
      if (fragments?.initialized) fragments.core.update(true);
    },
    [],
  );

  return {
    ready,
    loading,
    error,
    models,
    selection,
    selectionMap,
    getWorld,
    loadIfc,
    loadIfcBytes,
    loadFragBytes,
    loadObjBytes,
    getMeshParts,
    clear,
    removeModel,
    setVisibility,
    isolate,
    hide,
    showAll,
    setIsolationRoot,
    getIsolationRoot,
    showModelAll,
    setModelExactVisibility,
    isolationRootVersion,
    clipMode,
    clipCount,
    setClipMode,
    clipFromHit,
    deleteAllClips,
    flipClips,
    measureMode,
    measureCount,
    setMeasureMode,
    deleteAllMeasurements,
    removeMeasurementVisual,
    volumeMode,
    volumePointCount,
    setVolumeMode,
    finalizeVolume,
    cancelVolume,
    undoVolumePoint,
    polylineMode,
    polylinePointCount,
    setPolylineMode,
    finalizePolyline,
    cancelPolyline,
    undoPolylinePoint,
    snapEnabled,
    setSnapEnabled,
    projection,
    setProjection,
    fov,
    setFov,
    captureClips,
    applyClips,
    pendingMeasurement,
    setPendingMeasurement,
    clearPendingMeasurement: () => setPendingMeasurement(null),
    measureMeshVolume,
    showAllVersion,
    runtimeVisibilityVersion,
    selectRect,
    pickAt,
    setModelHidden,
    getModelGroups,
    getItemData,
    getRawModel,
    getPropertyIndex,
    peekPropertyIndex,
    setPropertyIndex,
    invalidatePropertyIndex,
    selectItem,
    selectMany,
    clearSelection,
    zoomToSelection,
    recenter,
    captureCamera,
    captureSelection,
    captureVisibleItems,
    captureVisibilitySnapshot,
    applyVisibilitySnapshot,
    captureViewState,
    applyCamera,
  };
}

export type ViewerApi = ReturnType<typeof useViewer>;

// ──────────────────────────────────────────────────────────────────────────────
// Custom measurement helpers — minimal Three.js objects plus CSS2DObject label.
// Kept module-scope so they're plain pure functions (no captured viewer state).
// ──────────────────────────────────────────────────────────────────────────────

const ANCHOR_COLOR = 0xff6b3d;
const LINE_COLOR = 0xff6b3d;
// Reticle colours: cyan when locked onto a vertex, dim grey when riding a
// plain surface point.
const SNAP_VERTEX_COLOR = 0x22d3ee;
const SNAP_SURFACE_COLOR = 0x94a3b8;

// On-screen radii, in CSS pixels, of the measurement markers. They are held
// constant by keepScreenSize below.
const RETICLE_PX = 5;
const ANCHOR_PX = 4.5;
const ENDPOINT_PX = 4;

// The radius the sphere geometry is authored with. Scale = wanted world size
// divided by this.
const MARKER_GEOMETRY_RADIUS = 1;

const tmpMarkerPosition = new THREE.Vector3();

/**
 * Hold a marker at a fixed pixel size no matter the zoom.
 *
 * A marker authored in world units is invisible when zoomed out and swallows
 * the model when zoomed in — the exact thing you cannot afford when the marker
 * shows *where a measurement will land*. `onBeforeRender` runs before the
 * renderer derives `modelViewMatrix` from `matrixWorld`, so refreshing the
 * matrix here lands in the same frame rather than one frame late.
 */
function keepScreenSize(mesh: THREE.Mesh, pixelRadius: number) {
  mesh.onBeforeRender = (renderer, _scene, camera) => {
    const distance = camera.position.distanceTo(
      mesh.getWorldPosition(tmpMarkerPosition),
    );
    const scale = markerScale(
      camera,
      renderer.domElement.clientHeight,
      distance,
      pixelRadius,
      MARKER_GEOMETRY_RADIUS,
    );
    if (scale === null) return;
    mesh.scale.setScalar(scale);
    mesh.updateMatrixWorld(true);
  };
}

/**
 * Selection tint for OBJ parts. The fragments Highlighter only reaches
 * worker-side geometry, so plain three.js meshes would otherwise select with
 * no visible feedback at all.
 */
const meshHighlightMaterial = new THREE.MeshLambertMaterial({
  color: 0x38bdf8,
  emissive: 0x0c4a6e,
  side: THREE.DoubleSide,
});

/**
 * Push field of view and clipping planes onto whichever THREE camera the
 * OrthoPerspectiveCamera currently exposes, and keep the dolly limits in step
 * so the controls cannot drive the target through the near plane.
 */
function applyCameraSettings(world: any, fov: number, planes: ClipPlanes) {
  const camera = world?.camera?.three as THREE.Camera | undefined;
  if (!camera) return;
  const perspective = camera as THREE.PerspectiveCamera;
  if (perspective.isPerspectiveCamera) {
    perspective.fov = fov;
    perspective.near = planes.near;
  } else {
    // Orthographic has no vanishing point, so the camera can end up sitting
    // inside the model with half of it behind the lens. A near plane behind
    // the camera keeps that half visible instead of slicing it off.
    (camera as THREE.OrthographicCamera).near = -planes.far;
  }
  (camera as THREE.PerspectiveCamera).far = planes.far;
  (camera as any).updateProjectionMatrix?.();

  const controls = world?.camera?.controls;
  if (controls) {
    controls.minDistance = planes.minDistance;
    controls.maxDistance = planes.maxDistance;
  }
}

/**
 * Handle tying a stored measurement to the objects drawn for it, so deleting
 * a row in the panel can clear the scene too.
 */
let measurementSeq = 0;
function nextMeasurementId(): string {
  measurementSeq += 1;
  return `mv-${measurementSeq}`;
}

/** Unit-radius sphere; every marker is scaled to its pixel size at render. */
function markerGeometry(segments = 12): THREE.SphereGeometry {
  return new THREE.SphereGeometry(MARKER_GEOMETRY_RADIUS, segments, segments);
}

function makeAnchorSphere(point: THREE.Vector3): THREE.Object3D {
  const mat = new THREE.MeshBasicMaterial({ color: ANCHOR_COLOR });
  const mesh = new THREE.Mesh(markerGeometry(), mat);
  mesh.position.copy(point);
  (mesh as any).userData.dimkoMeasure = "anchor";
  keepScreenSize(mesh, ANCHOR_PX);
  return mesh;
}

// Small always-on-top reticle previewing where the next click lands.
function makeSnapReticle(point: THREE.Vector3, snapped: boolean): THREE.Object3D {
  const mat = new THREE.MeshBasicMaterial({
    color: snapped ? SNAP_VERTEX_COLOR : SNAP_SURFACE_COLOR,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
  const mesh = new THREE.Mesh(markerGeometry(14), mat);
  mesh.position.copy(point);
  mesh.renderOrder = 1000;
  (mesh as any).userData.dimkoMeasure = "snap-hover";
  keepScreenSize(mesh, RETICLE_PX);
  return mesh;
}

function applyReticleColor(obj: THREE.Object3D, snapped: boolean) {
  const mat = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
  if (mat?.color) mat.color.setHex(snapped ? SNAP_VERTEX_COLOR : SNAP_SURFACE_COLOR);
}

// Dashed live segment from the last placed point to the cursor (preview only).
function makeRubberBand(a: THREE.Vector3, b: THREE.Vector3): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const mat = new THREE.LineDashedMaterial({
    color: SNAP_VERTEX_COLOR,
    dashSize: 0.15,
    gapSize: 0.1,
    depthTest: false,
    transparent: true,
    opacity: 0.9,
  });
  const line = new THREE.Line(geo, mat);
  line.computeLineDistances();
  line.renderOrder = 1000;
  (line as any).userData.dimkoMeasure = "snap-hover";
  return line;
}

function updateRubberBand(line: THREE.Line, a: THREE.Vector3, b: THREE.Vector3) {
  line.geometry.setFromPoints([a, b]);
  line.geometry.attributes.position.needsUpdate = true;
  line.computeLineDistances();
}

// Single segment line between two points (used while building a polyline).
function makeSegmentLine(a: THREE.Vector3, b: THREE.Vector3): THREE.Object3D {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const mat = new THREE.LineBasicMaterial({
    color: LINE_COLOR,
    linewidth: 2,
    depthTest: false,
    transparent: true,
  });
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 999;
  (line as any).userData.dimkoMeasure = "polyline-pending";
  return line;
}

// Finalized polyline measurement: vertex dots + connecting segments + one
// label at the chain's midpoint carrying the total length.
function makePolyline(
  points: THREE.Vector3[],
  total: number,
  measurementId: string,
): THREE.Object3D {
  const group = new THREE.Group();
  (group as any).userData.dimkoMeasure = "measurement";
  (group as any).userData.measurementId = measurementId;
  const dotGeo = markerGeometry();
  const dotMat = new THREE.MeshBasicMaterial({ color: ANCHOR_COLOR });
  for (const p of points) {
    const dot = new THREE.Mesh(dotGeo, dotMat);
    dot.position.copy(p);
    keepScreenSize(dot, ENDPOINT_PX);
    group.add(dot);
  }
  const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
  const lineMat = new THREE.LineBasicMaterial({
    color: LINE_COLOR,
    linewidth: 2,
    depthTest: false,
    transparent: true,
  });
  const line = new THREE.Line(lineGeo, lineMat);
  line.renderOrder = 999;
  group.add(line);

  // Label at the geometric midpoint of the chain (the vertex closest to
  // half the cumulative length).
  let half = total / 2;
  let anchor = points[0];
  for (let i = 1; i < points.length; i++) {
    const seg = points[i].distanceTo(points[i - 1]);
    if (half <= seg) {
      anchor = points[i - 1].clone().lerp(points[i], seg ? half / seg : 0);
      break;
    }
    half -= seg;
  }
  const div = document.createElement("div");
  div.textContent = formatDistance(total);
  div.style.cssText =
    "color:#fff;background:rgba(17,24,39,0.85);padding:3px 7px;border-radius:6px;font-size:11px;font-family:system-ui,sans-serif;font-weight:600;border:1px solid rgba(255,107,61,0.5);pointer-events:none;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
  const label = new CSS2DObject(div);
  label.position.copy(anchor);
  group.add(label);
  return group;
}

function makeMeasurement(
  a: THREE.Vector3,
  b: THREE.Vector3,
  measurementId: string,
): THREE.Object3D {
  const group = new THREE.Group();
  (group as any).userData.dimkoMeasure = "measurement";
  (group as any).userData.measurementId = measurementId;

  // Endpoint markers
  const matEnd = new THREE.MeshBasicMaterial({ color: ANCHOR_COLOR });
  const sphereGeo = markerGeometry();
  const sA = new THREE.Mesh(sphereGeo, matEnd);
  sA.position.copy(a);
  keepScreenSize(sA, ENDPOINT_PX);
  const sB = new THREE.Mesh(sphereGeo, matEnd);
  sB.position.copy(b);
  keepScreenSize(sB, ENDPOINT_PX);
  group.add(sA);
  group.add(sB);

  // Line
  const lineGeo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const lineMat = new THREE.LineBasicMaterial({
    color: LINE_COLOR,
    linewidth: 2,
    depthTest: false,
    transparent: true,
  });
  const line = new THREE.Line(lineGeo, lineMat);
  line.renderOrder = 999;
  group.add(line);

  // Label
  const distance = a.distanceTo(b);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const div = document.createElement("div");
  div.textContent = formatDistance(distance);
  div.style.cssText =
    "color:#fff;background:rgba(17,24,39,0.85);padding:3px 7px;border-radius:6px;font-size:11px;font-family:system-ui,sans-serif;font-weight:600;border:1px solid rgba(255,107,61,0.5);pointer-events:none;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
  const label = new CSS2DObject(div);
  label.position.copy(mid);
  group.add(label);

  return group;
}

function formatDistance(m: number): string {
  if (m >= 1) return `${m.toFixed(3)} m`;
  return `${(m * 1000).toFixed(0)} mm`;
}

function formatVolume(m3: number): string {
  if (m3 >= 0.01) return `${m3.toFixed(3)} m³`;
  // sub-litre → cm³ to avoid leading zeros looking like "0.000 m³"
  return `${(m3 * 1_000_000).toFixed(0)} cm³`;
}

// Signed-tetra volume sum over hull triangles. Geometry is non-indexed
// (ConvexGeometry produces flat triangle list), so each consecutive triple
// of position vertices is a face.
function volumeFromConvexMesh(geo: THREE.BufferGeometry): number {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  if (!pos) return 0;
  let v = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cross = new THREE.Vector3();
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    cross.copy(b).cross(c);
    v += a.dot(cross);
  }
  return Math.abs(v) / 6;
}

function centroidOf(points: THREE.Vector3[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  if (points.length) c.multiplyScalar(1 / points.length);
  return c;
}

function makeVolumeLabelVisual(
  volume: number,
  centroid: [number, number, number],
): THREE.Object3D {
  const group = new THREE.Group();
  (group as any).userData.dimkoMeasure = "measurement";
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 12, 12),
    new THREE.MeshBasicMaterial({ color: ANCHOR_COLOR }),
  );
  dot.position.set(centroid[0], centroid[1], centroid[2]);
  group.add(dot);
  const div = document.createElement("div");
  div.textContent = formatVolume(volume);
  div.style.cssText =
    "color:#fff;background:rgba(17,24,39,0.85);padding:3px 7px;border-radius:6px;font-size:11px;font-family:system-ui,sans-serif;font-weight:600;border:1px solid rgba(255,107,61,0.5);pointer-events:none;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
  const label = new CSS2DObject(div);
  label.position.set(centroid[0], centroid[1], centroid[2]);
  group.add(label);
  return group;
}

function makeVolumeMeasurement(
  points: THREE.Vector3[],
): { object: THREE.Object3D; volume: number } {
  const group = new THREE.Group();
  (group as any).userData.dimkoMeasure = "measurement";

  // Endpoint markers — small dots at each clicked corner so user sees the
  // boundary points after finalize.
  const matEnd = new THREE.MeshBasicMaterial({ color: ANCHOR_COLOR });
  const sphereGeo = new THREE.SphereGeometry(0.04, 10, 10);
  for (const p of points) {
    const s = new THREE.Mesh(sphereGeo, matEnd);
    s.position.copy(p);
    group.add(s);
  }

  // Convex hull mesh — translucent so user still sees the model behind.
  // ConvexGeometry needs ≥4 non-coplanar points; finalize gates on length≥4
  // but if user clicks 4 coplanar points the volume comes out 0 — caller
  // gets the label "0 m³" and can re-measure.
  const hull = new ConvexGeometry(points);
  const hullMat = new THREE.MeshBasicMaterial({
    color: ANCHOR_COLOR,
    opacity: 0.22,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const hullMesh = new THREE.Mesh(hull, hullMat);
  hullMesh.renderOrder = 998;
  group.add(hullMesh);

  // Hull edges — wireframe outline so the boundary reads clearly against
  // the translucent fill.
  const edges = new THREE.EdgesGeometry(hull, 1);
  const edgeMat = new THREE.LineBasicMaterial({
    color: LINE_COLOR,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  const edgeLines = new THREE.LineSegments(edges, edgeMat);
  edgeLines.renderOrder = 999;
  group.add(edgeLines);

  // Label at centroid of clicked points (cheap and stable; hull centroid
  // would require iterating hull triangles — clicked-centroid is close
  // enough for a tag position).
  const vol = volumeFromConvexMesh(hull);
  const mid = centroidOf(points);
  const div = document.createElement("div");
  div.textContent = formatVolume(vol);
  div.style.cssText =
    "color:#fff;background:rgba(17,24,39,0.85);padding:3px 7px;border-radius:6px;font-size:11px;font-family:system-ui,sans-serif;font-weight:600;border:1px solid rgba(255,107,61,0.5);pointer-events:none;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
  const label = new CSS2DObject(div);
  label.position.copy(mid);
  group.add(label);

  return { object: group, volume: vol };
}

function countMeasurements(group: THREE.Group): number {
  let n = 0;
  for (const c of group.children) {
    if ((c as any).userData?.dimkoMeasure === "measurement") n++;
  }
  return n;
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((node: any) => {
    if (node.geometry?.dispose) node.geometry.dispose();
    if (node.material) {
      if (Array.isArray(node.material)) {
        for (const m of node.material) m.dispose?.();
      } else {
        node.material.dispose?.();
      }
    }
    if (node instanceof CSS2DObject) {
      node.element?.remove?.();
    }
  });
}
