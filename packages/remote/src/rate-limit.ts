export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

const MAX_TRACKED_KEYS = 50_000;

/**
 * Fixed-window request counter per key, held in this process only. Limits
 * shared across several hosts would need a common store such as Redis.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): RateDecision {
    const current = this.now();
    let window = this.windows.get(key);
    if (!window || current - window.start >= this.windowMs) {
      if (this.windows.size >= MAX_TRACKED_KEYS) this.prune(current);
      window = { start: current, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    if (window.count <= this.limit) return { allowed: true, retryAfterSeconds: 0 };
    const retryAfterSeconds = Math.max(1, Math.ceil((window.start + this.windowMs - current) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  private prune(current: number): void {
    for (const [key, window] of this.windows) {
      if (current - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}
