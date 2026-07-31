import { describe, expect, it } from "vitest";
import { parseModelLinks } from "./modelLinks";

const BASE = "https://acme.github.io/dimko-viewer/";

describe("parseModelLinks", () => {
  it("resolves a relative model against the app base", () => {
    const [model] = parseModelLinks("?model=models/kv1.obj", BASE);
    expect(model.url).toBe("https://acme.github.io/dimko-viewer/models/kv1.obj");
    expect(model.name).toBe("kv1.obj");
    expect(model.format).toBe("obj");
  });

  it("accepts absolute URLs on another host", () => {
    const [model] = parseModelLinks(
      "?model=https://files.example.com/a/tower.ifc",
      BASE,
    );
    expect(model.url).toBe("https://files.example.com/a/tower.ifc");
    expect(model.format).toBe("ifc");
  });

  it("keeps several models in the order given", () => {
    const models = parseModelLinks("?model=a.obj&model=b.ifc&model=c.frag", BASE);
    expect(models.map((m) => m.name)).toEqual(["a.obj", "b.ifc", "c.frag"]);
  });

  it("gives the same id for the same URL across reloads", () => {
    const first = parseModelLinks("?model=models/kv1.obj", BASE)[0];
    const second = parseModelLinks("?model=models/kv1.obj", BASE)[0];
    expect(first.id).toBe(second.id);
    // …and a different one for a different file.
    const other = parseModelLinks("?model=models/kv2.obj", BASE)[0];
    expect(other.id).not.toBe(first.id);
  });

  it("produces ids safe to use as storage keys", () => {
    const [model] = parseModelLinks("?model=models/KV%201.2a%20(final).obj", BASE);
    expect(model.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(model.name).toBe("KV 1.2a (final).obj");
  });

  it("drops one bad entry without losing the good ones", () => {
    const models = parseModelLinks(
      "?model=notes.pdf&model=&model=models/kv1.obj",
      BASE,
    );
    expect(models.map((m) => m.name)).toEqual(["kv1.obj"]);
  });

  it("ignores a repeated URL", () => {
    const models = parseModelLinks("?model=a.obj&model=a.obj", BASE);
    expect(models).toHaveLength(1);
  });

  it("returns nothing when no model is named", () => {
    expect(parseModelLinks("", BASE)).toEqual([]);
    expect(parseModelLinks("?share=abc", BASE)).toEqual([]);
  });
});
