// Stabilization utilities for hand landmarks.
// Unlike smoothing (which filters/averages over time causing delay), stabilization aims to:
// 1. Use raw data directly for minimal latency
// 2. Apply smart filtering only when micro-jitter is detected
// 3. Use velocity-based prediction for seamless motion
// 4. Implement dead-zone filtering for stable poses

import type { Landmark } from "@/store/hands";

type Vec3 = { x: number; y: number; z: number };

const EPSILON = 1e-9;

// Helper: lerp between two values
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Helper: clamp value between min and max
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * OneEuroFilter - Low-latency smoothing filter that adapts to motion speed
 * Fast movements pass through with minimal lag; slow movements get stronger filtering
 * Reference: http://www.lifl.fr/~casiez/1euro/
 */
class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private lastTime = 0;
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  
  constructor(
    minCutoff = 1.0,    // Minimum cutoff frequency (Hz) - lower = more smoothing
    beta = 0.007,        // Speed coefficient - how much to respond to velocity
    dCutoff = 1.0        // Cutoff for derivative
  ) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.lastTime = 0;
  }

  update(value: number, timestamp: number): number {
    if (this.x === null) {
      this.x = value;
      this.lastTime = timestamp;
      return value;
    }

    const dt = timestamp - this.lastTime;
    if (dt <= 0) return this.x;

    // Estimate velocity
    const edx = (value - this.x) / dt;
    const edxFiltered = this.exponentialSmoothing(edx, this.dx, this.alpha(dt, this.dCutoff));
    this.dx = edxFiltered;

    // Adapt cutoff based on velocity
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const alpha = this.alpha(dt, cutoff);
    const xFiltered = this.exponentialSmoothing(value, this.x, alpha);

    this.x = xFiltered;
    this.lastTime = timestamp;
    return xFiltered;
  }

  private alpha(dt: number, cutoff: number): number {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  private exponentialSmoothing(value: number, prev: number, alpha: number): number {
    return alpha * value + (1 - alpha) * prev;
  }

  configure(minCutoff?: number, beta?: number, dCutoff?: number) {
    if (minCutoff !== undefined) this.minCutoff = minCutoff;
    if (beta !== undefined) this.beta = beta;
    if (dCutoff !== undefined) this.dCutoff = dCutoff;
  }
}

/**
 * StabilizationFilter - Combines multiple techniques for low-latency, jitter-free tracking
 */
export class StabilizationFilter {
  private prev: Vec3 | null = null;
  private velocity: Vec3 = { x: 0, y: 0, z: 0 };
  private oneEuroX: OneEuroFilter;
  private oneEuroY: OneEuroFilter;
  private oneEuroZ: OneEuroFilter;
  private lastTimestamp = 0;
  private stableFrames = 0; // Count frames where hand is stable
  private deadZone: number;
  private velocitySmoothing: number;
  private jitterThreshold: number;
  private predictionStrength: number;

  constructor(
    deadZone = 0.0008,           // Ignore movements smaller than this (normalized coords)
    velocitySmoothing = 0.3,     // How much to smooth velocity (0=none, 1=full)
    jitterThreshold = 0.002,     // Threshold to detect jitter vs real movement
    predictionStrength = 0.15,   // How much to predict ahead (0=none, 1=full frame)
    oneEuroMinCutoff = 1.5,             // One Euro Filter params
    oneEuroBeta = 0.007,
    oneEuroDCutoff = 1.0
  ) {
    this.deadZone = deadZone;
    this.velocitySmoothing = velocitySmoothing;
    this.jitterThreshold = jitterThreshold;
    this.predictionStrength = predictionStrength;
    this.oneEuroX = new OneEuroFilter(oneEuroMinCutoff, oneEuroBeta, oneEuroDCutoff);
    this.oneEuroY = new OneEuroFilter(oneEuroMinCutoff, oneEuroBeta, oneEuroDCutoff);
    this.oneEuroZ = new OneEuroFilter(oneEuroMinCutoff, oneEuroBeta, oneEuroDCutoff);
  }

  reset() {
    this.prev = null;
    this.velocity = { x: 0, y: 0, z: 0 };
    this.oneEuroX.reset();
    this.oneEuroY.reset();
    this.oneEuroZ.reset();
    this.lastTimestamp = 0;
    this.stableFrames = 0;
  }

  update(point: Vec3, timestamp: number): Vec3 {
    // First frame - return as-is
    if (this.prev === null) {
      this.prev = { ...point };
      this.lastTimestamp = timestamp;
      return { ...point };
    }

    const dt = timestamp - this.lastTimestamp;
    if (dt <= EPSILON) return { ...this.prev };

    // Calculate raw movement
    const rawDelta = {
      x: point.x - this.prev.x,
      y: point.y - this.prev.y,
      z: point.z - this.prev.z,
    };
    const movementMagnitude = Math.sqrt(
      rawDelta.x * rawDelta.x + rawDelta.y * rawDelta.y + rawDelta.z * rawDelta.z
    );

    // Dead zone - if movement is tiny, assume it's noise and return previous
    if (movementMagnitude < this.deadZone) {
      this.stableFrames++;
      this.lastTimestamp = timestamp;
      return { ...this.prev };
    }

    // Reset stable frame counter on significant movement
    this.stableFrames = 0;

    // Update velocity with smoothing
    const currentVelocity = {
      x: rawDelta.x / dt,
      y: rawDelta.y / dt,
      z: rawDelta.z / dt,
    };
    
    this.velocity = {
      x: lerp(this.velocity.x, currentVelocity.x, this.velocitySmoothing),
      y: lerp(this.velocity.y, currentVelocity.y, this.velocitySmoothing),
      z: lerp(this.velocity.z, currentVelocity.z, this.velocitySmoothing),
    };

    // Detect jitter vs intentional movement
    const velocityMagnitude = Math.sqrt(
      this.velocity.x * this.velocity.x +
      this.velocity.y * this.velocity.y +
      this.velocity.z * this.velocity.z
    );

    let result: Vec3;

    // If movement is small but above dead zone, it might be jitter
    // Use One Euro Filter for adaptive smoothing
    if (movementMagnitude < this.jitterThreshold) {
      result = {
        x: this.oneEuroX.update(point.x, timestamp),
        y: this.oneEuroY.update(point.y, timestamp),
        z: this.oneEuroZ.update(point.z, timestamp),
      };
    } else {
      // Fast movement - use raw data with optional prediction
      if (this.predictionStrength > 0 && velocityMagnitude > 0.001) {
        // Predict position based on velocity
        const prediction = {
          x: point.x + this.velocity.x * dt * this.predictionStrength,
          y: point.y + this.velocity.y * dt * this.predictionStrength,
          z: point.z + this.velocity.z * dt * this.predictionStrength,
        };
        
        // Blend between raw and predicted
        result = {
          x: clamp(prediction.x, 0, 1),
          y: clamp(prediction.y, 0, 1),
          z: clamp(prediction.z, -1, 1),
        };
        
        // Still apply light One Euro filtering even on fast movements
        result = {
          x: this.oneEuroX.update(result.x, timestamp),
          y: this.oneEuroY.update(result.y, timestamp),
          z: this.oneEuroZ.update(result.z, timestamp),
        };
      } else {
        // Use raw data with light One Euro filtering
        result = {
          x: this.oneEuroX.update(point.x, timestamp),
          y: this.oneEuroY.update(point.y, timestamp),
          z: this.oneEuroZ.update(point.z, timestamp),
        };
      }
    }

    this.prev = result;
    this.lastTimestamp = timestamp;
    return result;
  }

  configure(params: {
    deadZone?: number;
    velocitySmoothing?: number;
    jitterThreshold?: number;
    predictionStrength?: number;
    oneEuroMinCutoff?: number;
    oneEuroBeta?: number;
    oneEuroDCutoff?: number;
  }) {
    if (params.deadZone !== undefined) this.deadZone = params.deadZone;
    if (params.velocitySmoothing !== undefined) this.velocitySmoothing = params.velocitySmoothing;
    if (params.jitterThreshold !== undefined) this.jitterThreshold = params.jitterThreshold;
    if (params.predictionStrength !== undefined) this.predictionStrength = params.predictionStrength;
    
    if (params.oneEuroMinCutoff !== undefined || 
        params.oneEuroBeta !== undefined || 
        params.oneEuroDCutoff !== undefined) {
      this.oneEuroX.configure(params.oneEuroMinCutoff, params.oneEuroBeta, params.oneEuroDCutoff);
      this.oneEuroY.configure(params.oneEuroMinCutoff, params.oneEuroBeta, params.oneEuroDCutoff);
      this.oneEuroZ.configure(params.oneEuroMinCutoff, params.oneEuroBeta, params.oneEuroDCutoff);
    }
  }
}

/**
 * LandmarkStabilizer - Applies stabilization to all 21 hand landmarks
 */
export class LandmarkStabilizer {
  private filters: StabilizationFilter[] = [];
  private mode: 'responsive' | 'balanced' | 'stable';
  private customParams?: {
    deadZone?: number;
    velocitySmoothing?: number;
    jitterThreshold?: number;
    predictionStrength?: number;
    oneEuroMinCutoff?: number;
    oneEuroBeta?: number;
    oneEuroDCutoff?: number;
  };

  constructor(
    mode: 'responsive' | 'balanced' | 'stable' = 'balanced',
    customParams?: {
      deadZone?: number;
      velocitySmoothing?: number;
      jitterThreshold?: number;
      predictionStrength?: number;
      oneEuroMinCutoff?: number;
      oneEuroBeta?: number;
      oneEuroDCutoff?: number;
    }
  ) {
    this.mode = mode;
    this.customParams = customParams;
    this.initializeFilters();
  }

  private initializeFilters() {
    const presets = {
      responsive: {
        deadZone: 0.0005,
        velocitySmoothing: 0.2,
        jitterThreshold: 0.0015,
        predictionStrength: 0.2,
        oneEuroMinCutoff: 2.0,
        oneEuroBeta: 0.01,
        oneEuroDCutoff: 1.0,
      },
      balanced: {
        deadZone: 0.0008,
        velocitySmoothing: 0.3,
        jitterThreshold: 0.002,
        predictionStrength: 0.15,
        oneEuroMinCutoff: 1.5,
        oneEuroBeta: 0.007,
        oneEuroDCutoff: 1.0,
      },
      stable: {
        deadZone: 0.0012,
        velocitySmoothing: 0.4,
        jitterThreshold: 0.0025,
        predictionStrength: 0.1,
        oneEuroMinCutoff: 1.0,
        oneEuroBeta: 0.005,
        oneEuroDCutoff: 1.0,
      },
    };

    const params = { ...presets[this.mode], ...this.customParams };

    this.filters = Array.from({ length: 21 }, () => 
      new StabilizationFilter(
        params.deadZone,
        params.velocitySmoothing,
        params.jitterThreshold,
        params.predictionStrength,
        params.oneEuroMinCutoff,
        params.oneEuroBeta,
        params.oneEuroDCutoff
      )
    );
  }

  reset() {
    this.filters.forEach(f => f.reset());
  }

  apply(landmarks: Landmark[], timestamp: number): Landmark[] {
    if (landmarks.length !== 21) {
      throw new Error(`Expected 21 landmarks, got ${landmarks.length}`);
    }

    return landmarks.map((lm, i) => this.filters[i].update(lm, timestamp));
  }

  configure(
    mode?: 'responsive' | 'balanced' | 'stable',
    customParams?: {
      deadZone?: number;
      velocitySmoothing?: number;
      jitterThreshold?: number;
      predictionStrength?: number;
      oneEuroMinCutoff?: number;
      oneEuroBeta?: number;
      oneEuroDCutoff?: number;
    }
  ) {
    if (mode !== undefined && mode !== this.mode) {
      this.mode = mode;
      this.customParams = customParams;
      this.initializeFilters();
      return;
    }

    if (customParams) {
      this.customParams = { ...this.customParams, ...customParams };
      this.filters.forEach(f => f.configure(customParams));
    }
  }
}

/**
 * Simple EMA (Exponential Moving Average) for scalar values
 * Useful for smoothing derived values like palm score
 */
export class EmaValue {
  private value: number | null = null;
  private alpha: number;
  
  constructor(alpha = 0.3) {
    this.alpha = alpha;
  }

  reset() {
    this.value = null;
  }

  update(newValue: number): number {
    if (this.value === null) {
      this.value = newValue;
    } else {
      this.value = this.alpha * newValue + (1 - this.alpha) * this.value;
    }
    return this.value;
  }

  setAlpha(alpha: number) {
    this.alpha = clamp(alpha, 0, 1);
  }
}
