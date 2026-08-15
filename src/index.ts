/**
 * Public API of dimko-viewer as a library.
 *
 * This is the whole contract an embedder (DIMKO) may rely on — anything not
 * re-exported here is an implementation detail and can move without notice.
 * The package ships TypeScript sources; the consumer's bundler compiles them,
 * which is why react / three / @thatopen are peer dependencies (two copies of
 * three in one scene breaks instanceof checks and the raycasters with it).
 *
 * App-level pieces (Viewport, panels, model persistence, URL loading) are
 * deliberately NOT exported: they carry this app's layout and English UI.
 * Embedders build their own chrome on top of the hook.
 */

export {
  useViewer,
  type ViewerApi,
  type ViewerOptions,
  type ViewerGroupProvider,
  type ModelGroups,
  type LoadedModel,
  type SelectionTarget,
  type SnapResult,
  type SavedViewClip,
  type VisibilityMap,
  type VisibilitySnapshotEntry,
  type Projection,
} from "./features/viewer/useViewer";

export {
  ViewerProvider,
  ViewerApiProvider,
  useViewerContext,
  type ViewerContextValue,
} from "./features/viewer/ViewerContext";
export { OrientationGizmo } from "./features/viewer/OrientationGizmo";

export {
  computeVisibleIds,
  chooseSnapshotMode,
  filterSelectionBySnapshot,
  type Group,
  type Groups,
  type IdList,
  type ModelIdMap,
  type VisibilityMode,
} from "./features/viewer/visibility";

export {
  buildPropertyCatalog,
  mergeCatalogs,
  serializeCatalog,
  deserializeCatalog,
  buildPropertyIndex,
  mergeIndexes,
  type PropertyCatalog,
  type MergedCatalog,
  type PropertyIndex,
  type MergedPropertyIndex,
  type BuildOptions,
  type BuildProgress,
  type ValueEntry,
} from "./features/properties/propertyIndex";

export {
  ContextMenuProvider,
  useContextMenu,
  type ContextMenuItem,
} from "./components/ContextMenu";

export {
  localStorageCameraStore,
  DEFAULT_CAMERA_SETTINGS,
  MIN_FOV,
  MAX_FOV,
  type CameraSettings,
  type CameraSettingsStore,
} from "./lib/cameraSettings";
