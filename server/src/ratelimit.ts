/** Simple sliding-window rate limiter keyed by arbitrary string (ip, ip+user). */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {
    const t = setInterval(() => this.prune(), windowMs);
    t.unref();
  }

  /** Returns true if the action is allowed, false if the caller should back off. */
  check(key: string): boolean {
    const now = Date.now();
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
