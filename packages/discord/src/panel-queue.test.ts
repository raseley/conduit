import { describe, it, expect } from "vitest";

import { PanelQueue } from "./panel-queue.js";

/** A promise the test settles by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-queued promise continuation run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("PanelQueue", () => {
  it("runs the tasks for one key one at a time, in the order they were queued", async () => {
    const queue = new PanelQueue();
    const events: string[] = [];
    const first = deferred();
    const second = deferred();

    const a = queue.run("chan", async () => {
      events.push("a start");
      await first.promise;
      events.push("a end");
    });
    const b = queue.run("chan", async () => {
      events.push("b start");
      await second.promise;
      events.push("b end");
    });
    const c = queue.run("chan", async () => {
      events.push("c");
    });

    await flush();
    expect(events).toEqual(["a start"]);

    first.resolve();
    await flush();
    expect(events).toEqual(["a start", "a end", "b start"]);

    second.resolve();
    await Promise.all([a, b, c]);
    expect(events).toEqual(["a start", "a end", "b start", "b end", "c"]);
  });

  it("does not hold up tasks for a different key", async () => {
    const queue = new PanelQueue();
    const blocker = deferred();
    const events: string[] = [];

    void queue.run("one", async () => {
      await blocker.promise;
      events.push("one");
    });
    await queue.run("two", async () => {
      events.push("two");
    });

    expect(events).toEqual(["two"]);
    blocker.resolve();
  });

  it("resolves with the task's result", async () => {
    const queue = new PanelQueue();
    await expect(queue.run("chan", async () => 42)).resolves.toBe(42);
  });

  it("rejects only the failing task's promise; the next task still runs", async () => {
    const queue = new PanelQueue();
    const err = new Error("discord said no");

    const failed = queue.run("chan", async () => {
      throw err;
    });
    const next = queue.run("chan", async () => "ran");

    await expect(failed).rejects.toBe(err);
    await expect(next).resolves.toBe("ran");
  });

  it("reports a key busy while a task is queued or running, and idle afterwards", async () => {
    const queue = new PanelQueue();
    const gate = deferred();
    expect(queue.busy("chan")).toBe(false);

    const running = queue.run("chan", () => gate.promise);
    expect(queue.busy("chan")).toBe(true);
    expect(queue.busy("other")).toBe(false);

    gate.resolve();
    await running;
    await flush();
    expect(queue.busy("chan")).toBe(false);
  });
});
