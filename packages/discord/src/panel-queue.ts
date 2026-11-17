/**
 * {@link PanelQueue} — runs panel-changing work one task at a time per key.
 *
 * Every operation that posts, deletes or re-lays out persistent panels reads the
 * stored panel message ids, talks to Discord, then writes ids back. Two of them
 * running at once both read the same ids, so both post, and the panels written
 * first are orphaned. The adapter keys this queue by control channel, so
 * each operation sees the ids the previous one stored.
 *
 * Tasks for one key run in the order they were queued; tasks for different keys
 * do not wait for each other. A task that throws rejects only its own `run`
 * promise: the next task still runs.
 *
 * The queue is **not reentrant**: a task must never `run` on its own key (it
 * would wait for itself forever). Callers split an operation into a queued entry
 * point and an unqueued body, and compose bodies inside one task.
 */
export class PanelQueue {
  /** Per key, a promise that settles once every task queued so far has settled. */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Queue `task` behind every task already queued for `key`, and resolve or
   * reject with its result once it has run.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    // Forget an idle key, so the map does not grow with every channel ever used.
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Whether a task for `key` is running or waiting to run. */
  busy(key: string): boolean {
    return this.tails.has(key);
  }
}
