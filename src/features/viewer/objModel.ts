// ────────────────────────────────────────────────────────────────────────────
// OBJ models.
//
// IFC goes through @thatopen/fragments (geometry lives on a worker thread).
// OBJ has no such pipeline and no element semantics, so it is loaded as plain
// three.js geometry on the main thread and kept in a parallel registry. Every
// child mesh gets a stable `localId` so selection, visibility and the
// structure tree can address parts of an OBJ exactly like IFC elements.
// ────────────────────────────────────────────────────────────────────────────

import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

export type MeshPart = {
  localId: number;
  name: string;
  mesh: THREE.Mesh;
  /** Triangle count — the only "property" an OBJ part really has. */
  triangles: number;
};

export type MeshModel = {
  id: string;
  name: string;
  object: THREE.Group;
  parts: Map<number, MeshPart>;
};

/** Neutral grey, double-sided: OBJ exporters are careless about winding. */
function defaultMaterial(): THREE.Material {
  return new THREE.MeshLambertMaterial({
    color: 0xb8c0cc,
    side: THREE.DoubleSide,
  });
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return index.count / 3;
  const position = geometry.getAttribute("position");
  return position ? position.count / 3 : 0;
}

/**
 * Parse OBJ source into a scene-ready model. Materials from a companion .mtl
 * are not resolved (a dropped .obj arrives alone), so every part gets the
 * default material unless the loader already produced a textured one.
 */
export function parseObj(
  source: string,
  modelId: string,
  displayName: string,
): MeshModel {
  const group = new OBJLoader().parse(source);
  group.name = displayName;

  const parts = new Map<number, MeshPart>();
  let nextLocalId = 1;

  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;

    const geometry = mesh.geometry as THREE.BufferGeometry;
    // OBJ files often ship without normals; without them the model renders
    // flat black under the scene lights.
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    if (!mesh.material || Array.isArray(mesh.material)) {
      mesh.material = defaultMaterial();
    } else if ((mesh.material as THREE.Material).type === "MeshPhongMaterial") {
      // OBJLoader's fallback phong has no lighting response we want; swap it.
      mesh.material = defaultMaterial();
    }

    const localId = nextLocalId++;
    mesh.userData.modelId = modelId;
    mesh.userData.localId = localId;
    parts.set(localId, {
      localId,
      name: mesh.name || `part ${localId}`,
      mesh,
      triangles: triangleCount(geometry),
    });
  });

  return { id: modelId, name: displayName, object: group, parts };
}

/** Free GPU memory for a model that is being removed from the scene. */
export function disposeMeshModel(model: MeshModel) {
  model.object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
  model.object.removeFromParent();
}

/** World-space bounds of every loaded OBJ, or null when there are none. */
export function meshModelsBounds(
  models: Iterable<MeshModel>,
): THREE.Box3 | null {
  const box = new THREE.Box3();
  let any = false;
  for (const model of models) {
    box.expandByObject(model.object);
    any = true;
  }
  return any && !box.isEmpty() ? box : null;
}
