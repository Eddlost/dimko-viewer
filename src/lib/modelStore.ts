// ────────────────────────────────────────────────────────────────────────────
// Loaded models, kept across reloads.
//
// IndexedDB, not localStorage: an IFC runs to hundreds of megabytes and
// localStorage caps out around 5 MB (and only stores strings, so binary would
// have to be base64'd — a third bigger again).
//
// IFC is stored *parsed*, as fragments bytes, so reopening the page skips the
// expensive web-ifc pass. OBJ is small and cheap to re-parse, so it is stored
// as authored.
//
// Everything stays on the user's machine; nothing here talks to a server.
// ────────────────────────────────────────────────────────────────────────────

const DB_NAME = "dimko-viewer";
const DB_VERSION = 1;
const STORE = "models";

/** How the bytes should be fed back to the viewer on restore. */
export type StoredFormat = "frag" | "obj";

export type StoredModel = {
  id: string;
  /** File name as the user knows it, e.g. "tower.ifc" even when stored as frag. */
  name: string;
  format: StoredFormat;
  bytes: ArrayBuffer;
  addedAt: number;
};

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = action(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

/**
 * Persist a model. Failure is never fatal: a full disk or a private window
 * should cost you the reload convenience, not the model you just opened.
 * Returns whether it stuck, so the caller can tell the user.
 */
export async function saveModel(model: StoredModel): Promise<boolean> {
  try {
    await run("readwrite", (store) => store.put(model));
    return true;
  } catch (e) {
    console.warn("[model-store] save failed", e);
    return false;
  }
}

export async function loadModels(): Promise<StoredModel[]> {
  try {
    const all = await run<StoredModel[]>("readonly", (store) => store.getAll());
    return all.sort((a, b) => a.addedAt - b.addedAt);
  } catch (e) {
    console.warn("[model-store] load failed", e);
    return [];
  }
}

export async function deleteModel(id: string): Promise<void> {
  try {
    await run("readwrite", (store) => store.delete(id));
  } catch (e) {
    console.warn("[model-store] delete failed", e);
  }
}

export async function clearModels(): Promise<void> {
  try {
    await run("readwrite", (store) => store.clear());
  } catch (e) {
    console.warn("[model-store] clear failed", e);
  }
}

/**
 * Ask the browser not to evict this origin's data under storage pressure.
 * Without it, IndexedDB is "best effort" and a model can silently disappear.
 */
export async function requestPersistence(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* not supported — models are still stored, just evictable */
  }
}

/** Total bytes held, for the storage line in the models panel. */
export async function storedBytes(): Promise<number> {
  const models = await loadModels();
  return models.reduce((sum, m) => sum + m.bytes.byteLength, 0);
}
