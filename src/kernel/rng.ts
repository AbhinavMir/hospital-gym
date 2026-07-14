/**
 * Seeded RNG. Every stochastic draw in the simulation goes through here.
 *
 * Determinism is a benchmark requirement, not a convenience: the same
 * (scenario, seed, action sequence) must produce the same episode on every
 * machine, or scores are not comparable. Never call Math.random() anywhere
 * else in this codebase.
 */

/** sfc32 — small, fast, 128-bit state, good statistical properties. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number | string) {
    const s = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
    // Splitmix-style expansion of a single seed into 128 bits of state.
    let x = s >>> 0;
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Raw uniform in [0, 1). */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Fork an independent stream. Used to give each subsystem its own RNG so
   *  that adding a draw in one module does not shift another module's draws. */
  fork(label: string): Rng {
    return new Rng((hashString(label) ^ (this.next() * 0xffffffff)) >>> 0);
  }

  uniform(lo = 0, hi = 1): number {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** Box-Muller. */
  normal(mean = 0, sd = 1): number {
    const u1 = Math.max(this.next(), Number.MIN_VALUE);
    const u2 = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Normal truncated to [lo, hi] by resampling (bounded attempts, then clamp). */
  truncNormal(mean: number, sd: number, lo: number, hi: number): number {
    for (let i = 0; i < 16; i++) {
      const v = this.normal(mean, sd);
      if (v >= lo && v <= hi) return v;
    }
    return Math.min(hi, Math.max(lo, mean));
  }

  exponential(mean: number): number {
    return -mean * Math.log(1 - this.next());
  }

  /** Lognormal parameterised by the mean/sd of the underlying normal. */
  lognormal(mu: number, sigma: number): number {
    return Math.exp(this.normal(mu, sigma));
  }

  /**
   * Lognormal parameterised by the median and a geometric spread factor.
   * Convenient for service times: `logSpread(30, 1.6)` is "median 30 min, ~68%
   * of draws within 30/1.6 .. 30*1.6".
   */
  logSpread(median: number, spread: number): number {
    return this.lognormal(Math.log(median), Math.log(spread));
  }

  gamma(shape: number, scale: number): number {
    // Marsaglia-Tsang.
    if (shape < 1) {
      const u = this.next();
      return this.gamma(1 + shape, scale) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.next();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
    }
  }

  poisson(lambda: number): number {
    if (lambda > 30) return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))));
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > l);
    return k - 1;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Weighted choice. Weights need not be normalised; must be non-negative. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of entries) {
      if (w < 0) throw new Error('Rng.weighted: negative weight');
      total += w;
    }
    if (total <= 0) throw new Error('Rng.weighted: weights sum to zero');
    let r = this.next() * total;
    for (const [item, w] of entries) {
      r -= w;
      if (r <= 0) return item;
    }
    return entries[entries.length - 1]![0];
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }
}

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
