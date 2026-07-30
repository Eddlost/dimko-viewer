import { useEffect, useRef } from "react";
import { useViewerContext } from "../viewer/ViewerContext";
import { loadModels } from "../../lib/modelStore";

/**
 * Reload the models the user had open. Renders nothing — the viewport's
 * existing "loading model…" badge covers the wait.
 *
 * Mounted once, at the top of the app: restoring from more than one place
 * would load every model twice.
 */
export function RestoreModels() {
  const { ready, loadFragBytes, loadObjBytes, recenter } = useViewerContext();
  const restored = useRef(false);

  useEffect(() => {
    // The viewer has to be initialised before anything can be handed to it,
    // and StrictMode runs effects twice, hence the guard.
    if (!ready || restored.current) return;
    restored.current = true;

    let cancelled = false;
    (async () => {
      const models = await loadModels();
      if (cancelled || !models.length) return;
      for (const model of models) {
        if (cancelled) return;
        const bytes = new Uint8Array(model.bytes);
        if (model.format === "obj") {
          await loadObjBytes(bytes, model.id, model.name);
        } else {
          await loadFragBytes(bytes, model.id, model.name);
        }
      }
      if (!cancelled) await recenter();
    })().catch((e) => console.error("[restore] failed", e));

    return () => {
      cancelled = true;
    };
  }, [loadFragBytes, loadObjBytes, ready, recenter]);

  return null;
}
