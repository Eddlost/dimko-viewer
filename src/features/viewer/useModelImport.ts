import { useCallback, useState } from "react";
import { useViewerContext } from "./ViewerContext";
import { detectFormat, makeModelId } from "../../lib/fileImport";

/**
 * Load a model straight from a `File` — everything stays in the browser, no
 * upload, no server. IFC is parsed by web-ifc into fragments; OBJ becomes
 * plain three.js geometry.
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
        if (format === "ifc") await loadIfcBytes(bytes, modelId, file.name);
        else if (format === "obj") await loadObjBytes(bytes, modelId, file.name);
        else await loadFragBytes(bytes, modelId, file.name);
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
