/** File-type routing for dropped/opened models. */

export type ModelFormat = "ifc" | "obj" | "frag";

export const ACCEPTED_EXTENSIONS = [".ifc", ".obj", ".frag"] as const;

export function detectFormat(fileName: string): ModelFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".ifc")) return "ifc";
  if (lower.endsWith(".obj")) return "obj";
  if (lower.endsWith(".frag")) return "frag";
  return null;
}

/**
 * Model ids must be unique per session; the file name alone collides as soon
 * as someone loads two revisions called `model.ifc`.
 */
export function makeModelId(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "").slice(0, 40) || "model";
  return `${stem}-${Math.random().toString(36).slice(2, 8)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
