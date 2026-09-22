import { describe, it, expect } from "vitest";
import { createSerialQueue } from "./opQueue";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("createSerialQueue", () => {
  it("never runs two tasks at once", async () => {
    const q = createSerialQueue();
    let running = 0;
    let maxConcurrent = 0;
    const task = async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await tick(1);
      running -= 1;
    };
    await Promise.all([q.run(task), q.run(task), q.run(task)]);
    expect(maxConcurrent).toBe(1);
  });

  // The bug this exists for: a long op enqueued first must finish its last
  // step before a short op enqueued second touches the same state.
  it("runs tasks in the order they were queued, not the order they finish", async () => {
    const q = createSerialQueue();
    const order: string[] = [];
    const slow = q.run(async () => {
      await tick(10);
      order.push("slow");
    });
    const fast = q.run(async () => {
      order.push("fast");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["slow", "fast"]);
  });

  it("passes each task's value back to its own caller", async () => {
    const q = createSerialQueue();
    const [a, b] = await Promise.all([
      q.run(async () => "a"),
      q.run(async () => 2),
    ]);
    expect(a).toBe("a");
    expect(b).toBe(2);
  });

  it("keeps draining after a task rejects", async () => {
    const q = createSerialQueue();
    const failed = q.run(async () => {
      throw new Error("worker gone");
    });
    const after = q.run(async () => "still here");
    await expect(failed).rejects.toThrow("worker gone");
    await expect(after).resolves.toBe("still here");
  });

  it("reports how much work is outstanding", async () => {
    const q = createSerialQueue();
    expect(q.size).toBe(0);
    const a = q.run(() => tick(1));
    const b = q.run(() => tick(1));
    expect(q.size).toBe(2);
    await Promise.all([a, b]);
    expect(q.size).toBe(0);
  });
});
