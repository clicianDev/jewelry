// Lightweight smoothing utilities for hand landmarks.
// Provides EMA plus adaptive Kalman filtering per coordinate for stronger stabilization.

import type { Landmark } from "@/store/hands";

type Vec3 = [number, number, number];
type AxisValue = number | Vec3;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const toVec3 = (value: AxisValue | undefined, fallback: Vec3): Vec3 => {
  if (Array.isArray(value) && value.length === 3) {
    return [value[0], value[1], value[2]];
  }
  if (typeof value === "number") {
    return [value, value, value];
  }
  return [fallback[0], fallback[1], fallback[2]];
};

const vecEquals = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

const mapVec = (
  vec: Vec3,
  fn: (value: number, index: number) => number
): Vec3 => [fn(vec[0], 0), fn(vec[1], 1), fn(vec[2], 2)] as Vec3;

export type SmoothingMode = "ema" | "kalman" | "adaptiveKalman";

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

// Adaptive Kalman variant that increases process noise when large frame-to-frame jumps occur.
// Helps follow rapid motion without sacrificing steadiness when the hand is stable.
export class AdaptiveKalmanFilter1D {
  private x: number | null = null;
  private p = 1;
  private baseQ: number;
  private r: number;
  private adaptStrength: number;
  private qMin: number;
  private qMax: number;
  private prevMeasurement: number | null = null;

  constructor(baseQ = 2e-3, r = 1e-3, adaptStrength = 35, qMin = baseQ * 0.2, qMax = baseQ * 20) {
    this.baseQ = baseQ;
    this.r = r;
    this.adaptStrength = adaptStrength;
    this.qMin = qMin;
    this.qMax = qMax;
  }

  reset() {
    this.x = null;
    this.p = 1;
    this.prevMeasurement = null;
  }

  update(z: number): number {
    if (this.x == null) {
      this.x = z;
      this.prevMeasurement = z;
      this.p = 1;
      return z;
    }

    const delta = this.prevMeasurement == null ? 0 : Math.abs(z - this.prevMeasurement);
    // Scale process noise by how much the measurement moved this frame.
    const dynamicQ = clamp(
      this.baseQ * (1 + this.adaptStrength * delta),
      this.qMin,
      this.qMax
    );

    this.p = this.p + dynamicQ;
    const k = this.p / (this.p + this.r);
    this.x = this.x + k * (z - this.x);
    this.p = (1 - k) * this.p;
    this.prevMeasurement = z;
    return this.x;
  }

  setParams(params: { baseQ?: number; r?: number; adaptStrength?: number; qMin?: number; qMax?: number }) {
    if (params.baseQ !== undefined) this.baseQ = params.baseQ;
    if (params.r !== undefined) this.r = params.r;
    if (params.adaptStrength !== undefined) this.adaptStrength = params.adaptStrength;
    if (params.qMin !== undefined) this.qMin = params.qMin;
    if (params.qMax !== undefined) this.qMax = params.qMax;
  }
}

// Smoother for a set of 21 hand landmarks
export type LandmarkSmootherOptions = {
  mode?: SmoothingMode;
  alpha?: number; // for EMA
  q?: AxisValue;
  r?: AxisValue;
  adaptStrength?: AxisValue;
  minQ?: AxisValue;
  maxQ?: AxisValue;
};

type ScalarFilter = ExponentialSmoother | KalmanFilter1D | AdaptiveKalmanFilter1D;
type AxisFilter = { x: ScalarFilter; y: ScalarFilter; z: ScalarFilter };

export class LandmarkSmoother {
  private mode: SmoothingMode;
  private alpha: number;
  private qVec: Vec3;
  private rVec: Vec3;
  private adaptStrengthVec: Vec3;
  private minQVec: Vec3;
  private maxQVec: Vec3;
  private filters: Array<AxisFilter | null> = new Array(21).fill(null);

  constructor(opts: LandmarkSmootherOptions = {}) {
    this.mode = opts.mode ?? "kalman";
    this.alpha = opts.alpha ?? 0.6;

    const defaultQ: Vec3 = [0.002, 0.002, 0.003];
    const defaultR: Vec3 = [0.0012, 0.0012, 0.0018];
    const defaultAdapt: Vec3 = [35, 35, 45];
    const defaultMaxQ: Vec3 = [0.05, 0.05, 0.07];

    this.qVec = toVec3(opts.q, defaultQ);
    this.rVec = toVec3(opts.r, defaultR);
    this.adaptStrengthVec = toVec3(opts.adaptStrength, defaultAdapt);
    this.minQVec = toVec3(opts.minQ, mapVec(this.qVec, (q) => q * 0.2));
    this.maxQVec = toVec3(opts.maxQ, defaultMaxQ);
    this.reconcileProcessBounds();
  }

  private reconcileProcessBounds() {
    this.maxQVec = mapVec(this.maxQVec, (max, i) => Math.max(max, this.qVec[i], this.minQVec[i]));
    this.minQVec = mapVec(this.minQVec, (min, i) => {
      const upper = this.maxQVec[i];
      return Math.max(0, Math.min(min, upper));
    });
  }

  reset() {
    this.filters = new Array(21).fill(null);
  }

  configure(opts: Partial<LandmarkSmootherOptions>) {
    let shouldReset = false;
    if (opts.mode && opts.mode !== this.mode) {
      this.mode = opts.mode;
      shouldReset = true;
    }
    if (opts.alpha !== undefined && opts.alpha !== this.alpha) {
      this.alpha = opts.alpha;
      shouldReset = true;
    }
    if (opts.q !== undefined) {
      const nextQ = toVec3(opts.q, this.qVec);
      if (!vecEquals(nextQ, this.qVec)) {
        this.qVec = nextQ;
        shouldReset = true;
      }
      if (opts.minQ === undefined) {
        const derivedMin = mapVec(this.qVec, (q) => q * 0.2);
        if (!vecEquals(derivedMin, this.minQVec)) {
          this.minQVec = derivedMin;
          shouldReset = true;
        }
      }
    }
    if (opts.r !== undefined) {
      const nextR = toVec3(opts.r, this.rVec);
      if (!vecEquals(nextR, this.rVec)) {
        this.rVec = nextR;
        shouldReset = true;
      }
    }
    if (opts.adaptStrength !== undefined) {
      const nextAdapt = toVec3(opts.adaptStrength, this.adaptStrengthVec);
      if (!vecEquals(nextAdapt, this.adaptStrengthVec)) {
        this.adaptStrengthVec = nextAdapt;
        shouldReset = true;
      }
    }
    if (opts.minQ !== undefined) {
      const nextMin = toVec3(opts.minQ, this.minQVec);
      if (!vecEquals(nextMin, this.minQVec)) {
        this.minQVec = nextMin;
        shouldReset = true;
      }
    }
    if (opts.maxQ !== undefined) {
      const nextMax = toVec3(opts.maxQ, this.maxQVec);
      if (!vecEquals(nextMax, this.maxQVec)) {
        this.maxQVec = nextMax;
        shouldReset = true;
      }
    }
    this.reconcileProcessBounds();
    if (shouldReset) {
      this.reset();
    }
  }

  private makeFilter(): AxisFilter {
    if (this.mode === "ema") {
      return {
        x: new ExponentialSmoother(this.alpha),
        y: new ExponentialSmoother(this.alpha),
        z: new ExponentialSmoother(this.alpha),
      };
    }
    if (this.mode === "kalman") {
      return {
        x: new KalmanFilter1D(this.qVec[0], this.rVec[0]),
        y: new KalmanFilter1D(this.qVec[1], this.rVec[1]),
        z: new KalmanFilter1D(this.qVec[2], this.rVec[2]),
      };
    }
    return {
      x: new AdaptiveKalmanFilter1D(
        this.qVec[0],
        this.rVec[0],
        this.adaptStrengthVec[0],
        this.minQVec[0],
        this.maxQVec[0]
      ),
      y: new AdaptiveKalmanFilter1D(
        this.qVec[1],
        this.rVec[1],
        this.adaptStrengthVec[1],
        this.minQVec[1],
        this.maxQVec[1]
      ),
      z: new AdaptiveKalmanFilter1D(
        this.qVec[2],
        this.rVec[2],
        this.adaptStrengthVec[2],
        this.minQVec[2],
        this.maxQVec[2]
      ),
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
