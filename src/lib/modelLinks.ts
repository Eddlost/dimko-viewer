// ────────────────────────────────────────────────────────────────────────────
// Models named in the URL.
//
// A supplier who has to find a file, download it and drag it in will lose
// people at every step. `?model=…` makes the link itself carry the scope of
// the enquiry: open it and the right geometry is already on screen.
// ────────────────────────────────────────────────────────────────────────────

import { detectFormat, type ModelFormat } from "./fileImport";

export type LinkedModel = {
  /** Absolute URL to fetch. */
  url: string;
  /** File name shown in the models panel. */
  name: string;
  /** Stable across reloads, so the same link never loads twice. */
  id: string;
  format: ModelFormat;
};

/** `?model=` may repeat; order is preserved so the enquiry decides layering. */
const PARAM = "model";

function fileNameOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : url;
  } catch {
    return url;
  }
}

/** Ids double as IndexedDB keys, so keep them to a predictable alphabet. */
function idFor(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = (hash * 31 + url.charCodeAt(i)) | 0;
  }
  const stem = fileNameOf(url)
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 40);
  return `link-${stem || "model"}-${(hash >>> 0).toString(36)}`;
}

/**
 * Read `?model=` entries. Relative URLs resolve against `baseUrl`, which lets
 * a link read `?model=models/kv1.obj` and still work from a GitHub Pages
 * subpath.
 *
 * Anything unparseable or of an unknown type is dropped rather than thrown:
 * one bad entry in a link must not stop the rest from loading.
 */
export function parseModelLinks(search: string, baseUrl: string): LinkedModel[] {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return [];
  }

  const out: LinkedModel[] = [];
  const seen = new Set<string>();
  for (const raw of params.getAll(PARAM)) {
    const value = raw.trim();
    if (!value) continue;

    let url: string;
    try {
      url = new URL(value, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;

    const name = fileNameOf(url);
    const format = detectFormat(name);
    if (!format) continue;

    seen.add(url);
    out.push({ url, name, id: idFor(url), format });
  }
  return out;
}
