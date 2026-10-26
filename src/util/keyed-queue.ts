/**
 * Runs tasks one at a time per key, and concurrently across keys.
 *
 * Production equivalent: a partitioned queue (SQS FIFO message group, Kafka
 * key) with key = socialAccountId + followerId. Every event that can touch a
 * follower's run (their comment, their DMs, lifecycle changes to their run) is
 * routed through the same key, so two events for one follower never race.
 */
export class KeyedSerialQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    // Keep the chain alive even if this task fails, and drop the key when idle.
    const settled = next.catch(() => undefined);
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return next;
  }
}

export function followerKey(socialAccountId: string, followerId: string): string {
  return `${socialAccountId}:${followerId}`;
}
