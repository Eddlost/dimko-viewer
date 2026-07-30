import { useCallback, useState } from "react";
import { useViewerContext } from "./ViewerContext";
import { detectFormat, makeModelId } from "../../lib/fileImport";
import { requestPersistence, saveModel } from "../../lib/modelStore";

/**
 * Load a model straight from a `File` — everything stays in the browser, no
 * upload, no server. IFC is parsed by web-ifc into fragments; OBJ becomes
 * plain three.js geometry.
 *
 * Loaded models are also written to IndexedDB so a reload does not throw the
 * user's work away. IFC is kept in its *parsed* fragments form, which is what
 * makes reopening the page fast — re-running web-ifc on a large model is the
 * slow part, not reading the bytes.
 */
export function useModelImport() {
  const { loadIfcBytes, loadFragBytes, loadObjBytes, recenter } =
    useViewerContext();
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const importFile = useCallback(
    async (file: File) => {
      const format = detectFormat(file.name);
      if (!format) {
        setImportError(`Unsupported file type: ${file.name}`);
        return;
      }
      setImporting(true);
      setImportError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const modelId = makeModelId(file.name);

        if (format === "ifc") {
          const fragBytes = await loadIfcBytes(bytes, modelId, file.name);
          // No fragments buffer means the parse failed; nothing worth keeping.
          if (fragBytes) {
            await persist(modelId, file.name, "frag", fragBytes);
          }
        } else if (format === "obj") {
          await loadObjBytes(bytes, modelId, file.name);
          await persist(modelId, file.name, "obj", bytes);
        } else {
          await loadFragBytes(bytes, modelId, file.name);
          await persist(modelId, file.name, "frag", bytes);
        }
        await recenter();
      } catch (e: any) {
        setImportError(e?.message ?? String(e));
        console.error(e);
      } finally {
        setImporting(false);
      }
    },
    [loadFragBytes, loadIfcBytes, loadObjBytes, recenter],
  );

  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) await importFile(file);
    },
    [importFile],
  );

  return { importFile, importFiles, importing, importError, setImportError };
}

async function persist(
  id: string,
  name: string,
  format: "frag" | "obj",
  bytes: Uint8Array,
) {
  // Ask once we actually have something worth keeping, so the browser's
  // permission prompt (where it shows one) has obvious context.
  await requestPersistence();
  const copy = bytes.slice().buffer as ArrayBuffer;
  await saveModel({ id, name, format, bytes: copy, addedAt: Date.now() });
}
