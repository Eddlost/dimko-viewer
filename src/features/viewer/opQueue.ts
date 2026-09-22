// Serial queue for scene-visibility operations.
//
// Every visibility op is a multi-step conversation with the fragments worker:
// read the model's current state, diff it, hide one set, show another, redraw.
// Two of them in flight at once interleave those steps and the scene lands in
// neither state. Two symptoms seen in practice:
//
//   * `Hider.isolate()` fires hide-all and show-subset through `Promise.all`,
//     so on a large map the hide can settle after the show and part of the
//     isolated selection stays invisible — different elements each run.
//   * The tree re-intersects its hidden groups on an isolation-root change
//     while the isolate that caused it is still running; the re-intersect
//     diffs against a state that is about to be replaced.
//
// Nothing here is CPU-bound — it is all worker round-trips — so serialising
// costs no throughput, only the wall time the user already spends waiting.
//
// Re-entrancy is deliberately NOT supported. A composite op (restoring a
// visibility snapshot) calls the *raw* implementations of its parts rather
// than queueing them again, so a queued task can never wait on the queue and
// deadlock. Anything that calls `run()` must be a top-level entry point.

export type SerialQueue = {
  /** Runs `task` once every previously queued task has settled. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks queued but not yet settled — for tests and diagnostics. */
  readonly size: number;
};

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let size = 0;

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      size += 1;
      // Chain onto the tail's *settlement*, not its value: one failing op must
      // not poison every op queued behind it. The caller still sees its own
      // rejection through `result`.
      const result = tail.then(task, task);
      const done = () => {
        size -= 1;
      };
      tail = result.then(done, done);
      return result;
    },
    get size() {
      return size;
    },
  };
}
