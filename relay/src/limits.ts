import type { Tier } from "./store.js";

export interface TierLimits {
  connections: number;
  monthlyBytes: number;
}

const MB = 1024 * 1024;

export const TIERS: Record<Tier, TierLimits> = {
  free: { connections: 1, monthlyBytes: 200 * MB },
  standard: { connections: 3, monthlyBytes: 10 * 1024 * MB },
  premium: { connections: 20, monthlyBytes: 100 * 1024 * MB },
};

export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
export const monthStart = (t: number) => `${new Date(t).toISOString().slice(0, 7)}-01`;

/**
 * Per-install request rate limit. In memory: fine for one relay instance;
 * move to Redis when running several.
 */
export class TokenBucket {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {}

  /** Returns 0 if allowed, otherwise milliseconds until a token is available. */
  take(key: string, now = Date.now()): number {
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * this.refillPerMs);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return 0;
    }
    this.buckets.set(key, b);
    return Math.ceil((1 - b.tokens) / this.refillPerMs);
  }
}
