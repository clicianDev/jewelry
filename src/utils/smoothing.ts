// Lightweight smoothing utilities for hand landmarks.
// Provides EMA and simple 1D Kalman filtering per coordinate.

import type { Landmark } from "@/store/hands";

export type SmoothingMode = "ema" | "kalman";

// Exponential moving average for a scalar value
export class ExponentialSmoother {
  private alpha: number;
  private y: number | null = null;
  constructor(alpha: number) {
    this.alpha = Math.min(1, Math.max(0, alpha));
  }
  reset() {
    this.y = null;
  }
  update(x: number): number {
    if (this.y == null) {
      this.y = x;
    } else {
      this.y = this.alpha * x + (1 - this.alpha) * this.y;
    }
    return this.y;
  }
}

// Minimal 1D Kalman filter for smoothing noisy measurements.
// Model: x_k = x_{k-1} (random walk), z_k = x_k + v, v~N(0,R)
// Process noise Q controls responsiveness; measurement noise R controls trust.
export class KalmanFilter1D {
  private x: number | null = null; // state estimate
  private p = 1; // estimate covariance
  private q: number; // process noise
  private r: number; // measurement noise
  constructor(q = 1e-3, r = 5e-3) {
    this.q = q;
    this.r = r;
  }
  reset() {
    this.x = null;
    this.p = 1;
  }
  update(z: number): number {
    if (this.x == null) {
      this.x = z;
      this.p = 1;
      return z;
    }
    // Predict
    this.p = this.p + this.q;
    // Update
    const k = this.p / (this.p + this.r); // Kalman gain
    this.x = this.x + k * (z - this.x);
    this.p = (1 - k) * this.p;
    return this.x;
  }
}

// Smoother for a set of 21 hand landmarks
export type LandmarkSmootherOptions = {
  mode?: SmoothingMode;
  alpha?: number; // for EMA
  q?: number; // for Kalman
  r?: number; // for Kalman
};

export class LandmarkSmoother {
  private mode: SmoothingMode;
  private alpha: number;
  private q: number;
  private r: number;
  private filters: Array<{ x: ExponentialSmoother | KalmanFilter1D; y: ExponentialSmoother | KalmanFilter1D; z: ExponentialSmoother | KalmanFilter1D } | null> = new Array(21).fill(null);

  constructor(opts: LandmarkSmootherOptions = {}) {
    this.mode = opts.mode ?? "kalman";
    this.alpha = opts.alpha ?? 0.35; // fairly responsive EMA by default
    this.q = opts.q ?? 1e-3;
    this.r = opts.r ?? 5e-3;
  }

  reset() {
    this.filters = new Array(21).fill(null);
  }

  private makeFilter() {
    if (this.mode === "ema") {
      return {
        x: new ExponentialSmoother(this.alpha),
        y: new ExponentialSmoother(this.alpha),
        z: new ExponentialSmoother(this.alpha),
      };
    }
    return {
      x: new KalmanFilter1D(this.q, this.r),
      y: new KalmanFilter1D(this.q, this.r),
      z: new KalmanFilter1D(this.q, this.r),
    };
  }

  apply(landmarks: Landmark[]): Landmark[] {
    if (!landmarks || landmarks.length < 21) return landmarks;
    const out: Landmark[] = new Array(21) as unknown as Landmark[];
    for (let i = 0; i < 21; i++) {
      const lm = landmarks[i];
      if (!lm) continue;
      if (!this.filters[i]) this.filters[i] = this.makeFilter();
      const f = this.filters[i]!;
      out[i] = {
        x: f.x.update(lm.x),
        y: f.y.update(lm.y),
        z: f.z.update(lm.z),
      };
    }
    return out;
  }
}

// Utility: one-liner to compute EMA of a time series value with alpha in (0,1]
export class EmaValue {
  private s: number | null = null;
  private a: number;
  constructor(alpha: number) { this.a = Math.min(1, Math.max(0, alpha)); }
  reset() { this.s = null; }
  update(x: number): number { this.s = this.s == null ? x : this.a * x + (1 - this.a) * this.s; return this.s; }
}
