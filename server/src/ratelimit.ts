/** Simple sliding-window rate limiter keyed by arbitrary string (ip, ip+user). */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  /** When the map was last swept; see `check`. */
  private prunedAt = Date.now();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Returns true if the action is allowed, false if the caller should back off.
   *
   * Sweeping happens here, on a window boundary, rather than on a timer. Each
   * key already discards its own stale hits as it is read, so the sweep only
   * reclaims keys nobody asks about any more -- work with no deadline, which
   * makes an interval the wrong tool for it twice over. The right one is
   * amortising it onto the next caller: a limiter that nobody consults has
   * nothing to reclaim, and a runtime that forbids a timer in global scope --
   * Workers does -- can construct this at module scope like any other object.
   */
  check(key: string): boolean {
    const now = Date.now();
    if (now - this.prunedAt >= this.windowMs) {
      this.prune();
      this.prunedAt = now;
    }
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  retryAfterSeconds(key: string): number {
    const arr = this.hits.get(key);
    if (!arr || !arr.length) return 0;
    const oldest = arr[0]!;
    return Math.max(1, Math.ceil((this.windowMs - (Date.now() - oldest)) / 1000));
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, arr] of this.hits) {
      const kept = arr.filter((t) => now - t < this.windowMs);
      if (kept.length) this.hits.set(k, kept);
      else this.hits.delete(k);
    }
  }
}
