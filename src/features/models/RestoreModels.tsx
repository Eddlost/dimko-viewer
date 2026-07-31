import { useEffect, useRef, useState } from "react";
import { useViewerContext } from "../viewer/ViewerContext";
import { loadModels } from "../../lib/modelStore";
import { parseModelLinks, type LinkedModel } from "../../lib/modelLinks";

/**
 * Put the scene back the way the user left it, and load anything the link
 * named.
 *
 * Mounted once, at the top of the app: restoring from more than one place
 * would load every model twice.
 */
export function RestoreModels() {
  const { ready, loadFragBytes, loadObjBytes, loadIfcBytes, recenter } =
    useViewerContext();
  const restored = useRef(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    // The viewer has to be initialised before anything can be handed to it,
    // and StrictMode runs effects twice, hence the guard.
    if (!ready || restored.current) return;
    restored.current = true;

    let cancelled = false;

    const feed = async (bytes: Uint8Array, id: string, name: string, format: string) => {
      if (format === "obj") await loadObjBytes(bytes, id, name);
      else if (format === "ifc") await loadIfcBytes(bytes, id, name);
      else await loadFragBytes(bytes, id, name);
    };

    const loadLinked = async (model: LinkedModel) => {
      const response = await fetch(model.url);
      if (!response.ok) {
        throw new Error(`${model.name}: server odpověděl ${response.status}`);
      }
      // A wrong path does not always 404: any host with an SPA fallback hands
      // back index.html with status 200, which would then be parsed as a model
      // and fail with a baffling message about missing geometry.
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        throw new Error(
          `${model.name}: odkaz nevede na soubor modelu (server vrátil stránku)`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (cancelled) return;
      await feed(bytes, model.id, model.name, model.format);
    };

    (async () => {
      // Linked models first: they are the point of the link, and going before
      // the user's own files keeps them at the top of the models panel.
      const linked = parseModelLinks(
        window.location.search,
        document.baseURI,
      );
      for (const model of linked) {
        if (cancelled) return;
        try {
          await loadLinked(model);
        } catch (e: any) {
          // A supplier opening a broken link must see why, not an empty scene.
          console.error("[link] load failed", model.url, e);
          if (!cancelled) {
            setLinkError(e?.message ?? `Nepodařilo se načíst ${model.name}`);
          }
        }
      }

      // Linked models are re-fetched from the link every time, so they are
      // deliberately not in storage; this only brings back dropped IFCs. OBJ is
      // not stored at all, so a dropped OBJ is gone after a reload by design —
      // see modelStore.
      const stored = await loadModels();
      for (const model of stored) {
        if (cancelled) return;
        await feed(
          new Uint8Array(model.bytes),
          model.id,
          model.name,
          model.format,
        );
      }

      if (!cancelled && (linked.length || stored.length)) await recenter();
    })().catch((e) => console.error("[restore] failed", e));

    return () => {
      cancelled = true;
    };
  }, [loadFragBytes, loadIfcBytes, loadObjBytes, ready, recenter]);

  if (!linkError) return null;

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 px-3 py-2 rounded-md bg-red-900/80 backdrop-blur-sm border border-red-700 text-red-100 text-xs max-w-lg">
      <strong className="font-medium">Model z odkazu se nenačetl.</strong>{" "}
      {linkError}
      <button
        type="button"
        onClick={() => setLinkError(null)}
        className="ml-2 text-red-300 hover:text-red-100"
      >
        ✕
      </button>
    </div>
  );
}
