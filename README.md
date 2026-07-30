# DIMKO Viewer

Free, open-source 3D viewer for **IFC** and **OBJ** models — with measurement
tools that are precise enough to actually use.

Everything runs in your browser. Models are parsed locally and never uploaded,
so you can open a client's model without shipping it to someone's server.

> Status: early. The viewer, the structure tree, properties and the distance /
> polyline measurement tools work. See [Roadmap](#roadmap) for what is missing.

## Why another viewer

There are good free viewers already. What they are weak at is **measuring**.
Clicking "somewhere near a corner" gives you a number that is close but wrong,
which is useless when you are checking a dimension against a drawing.

This viewer snaps clicks to real geometry:

- **IFC** — vertex snapping runs inside the fragments worker, so it stays fast
  on large models.
- **OBJ** — snap candidates are derived from the hit triangle (its three
  corners and three edge midpoints) and chosen by *screen-space* distance, so
  snapping feels identical whether you are zoomed in or out.

The result is exact: measure a 2 m box edge and you get `2.000 m`, not
`1.987 m`.

## Features

- Load `.ifc`, `.obj` and `.frag` by drag-and-drop or file picker
- Orbit / pan / zoom, orientation gizmo, fit-to-model
- Perspective or orthographic camera, with an adjustable field of view
- Orbits around whatever you selected, not the scene centre
- Structure tree — storeys and categories for IFC, parts for OBJ
- Per-model and per-group visibility, isolate, hide, zoom-to
- Element properties including IFC property sets
- **Distance** and **polyline** measurement with vertex/edge snapping
- Section planes cut from any clicked face
- Models, measurements and camera settings survive a reload

## Where your files go

Nowhere. There is no account, no upload and no server — the model is parsed by
WebAssembly in your own browser.

To save you re-opening files after every reload, loaded models are kept in the
browser's IndexedDB on your machine (IFC in its parsed form, so reopening is
fast). Measurements and camera preferences go to `localStorage`. **Reset** in
the toolbar clears all of it, and removing a single model deletes its copy too.
Nothing is written until you actually open a model.

## Run it

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm dev        # http://localhost:5173
```

Other scripts:

```bash
pnpm build      # typecheck + production build into dist/
pnpm test       # unit tests (vitest)
pnpm typecheck  # tsc --noEmit
```

The build in `dist/` is fully static — drop it on GitHub Pages, Cloudflare
Pages, Netlify or any web server. `vite.config.ts` sets `base: "./"` so a
subpath deployment works without extra configuration.

## How it is put together

```
src/features/viewer/
  useViewer.ts     scene, picking, snapping, measurement, clipping, visibility
  meshSnap.ts      screen-space snap maths for OBJ geometry (unit-tested)
  screenScale.ts   constant-size markers + clipping planes (unit-tested)
  objModel.ts      OBJ parsing into three.js meshes with stable part ids
  visibility.ts    visibility snapshot logic (unit-tested)
  CameraPanel.tsx  projection + field-of-view controls
src/features/models/        structure tree, restore on startup
src/features/properties/    property panel + property index
src/features/measurements/  measurement list, localStorage persistence
src/lib/modelStore.ts       IndexedDB store for loaded models
src/lib/cameraSettings.ts   remembered projection + field of view
```

Two rendering paths coexist. IFC goes through
[@thatopen/components](https://github.com/ThatOpen/engine_components), whose
geometry lives on a **worker thread** — a main-thread `THREE.Raycaster` cannot
touch it, so all picking uses the async per-model API. OBJ is plain
main-thread three.js geometry. `useViewer` normalises hits from both into one
shape, then sorts by distance, which is what lets an OBJ and an IFC model be
measured against each other in the same scene.

## Roadmap

- More formats (STL, glTF, 3DS, PLY)
- Area and angle measurement
- Editable measurements (drag endpoints, re-snap)
- Measurement export (CSV / XLSX)
- Multiple section planes with per-plane delete
- MTL / texture support for OBJ

Issues and pull requests are welcome.

## Licence

MIT — see [LICENSE](LICENSE).

Third-party components keep their own licences. Notably
[web-ifc](https://github.com/ThatOpen/engine_web-ifc) is **MPL-2.0**: you can
ship it inside an MIT project, but modifications to web-ifc's own files must be
published under MPL-2.0. `three` and `@thatopen/components` are MIT.
