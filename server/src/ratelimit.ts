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

  /**
   * Give back the attempt `check` just took.
   *
   * For an outcome that says nothing about whether the credentials were right.
   * ihasmail runs in its own container, usually on its own host, so an upstream
   * that never answered is an ordinary Tuesday rather than an attack -- and the
   * limiter exists to slow down password guessing, which a server that refused
   * the connection has not told us anything about. Without this, retrying
   * through a thirty-second outage spends the window and locks somebody out
   * until well after the cause has gone (#239).
   *
   * Refunds one attempt rather than clearing the key, so a run of real failures
   * with an outage in the middle still adds up.
   */
  refund(key: string): void {
    const arr = this.hits.get(key);
    if (!arr?.length) return;
    arr.pop();
    if (arr.length) this.hits.set(key, arr);
    else this.hits.delete(key);
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
