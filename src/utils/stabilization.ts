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
 * 
 * Enhanced for Perfect Corp-level responsiveness:
 * - Higher minCutoff for faster response to changes
 * - Higher beta for better velocity tracking
 * - Optimized for near-zero latency on fast movements
 */
class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private lastTime = 0;
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  
  constructor(
    minCutoff = 3.0,    // Higher = more responsive (was 1.0, now 3.0)
    beta = 0.02,        // Higher = better velocity response (was 0.007, now 0.02)
    dCutoff = 2.0       // Higher derivative cutoff for better motion tracking
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
 * Enhanced with velocity prediction for Perfect Corp-level instant response
 */
export class StabilizationFilter {
  private prev: Vec3 | null = null;
  private velocity: Vec3 = { x: 0, y: 0, z: 0 };
  private acceleration: Vec3 = { x: 0, y: 0, z: 0 }; // Track acceleration for better prediction
  private velocityHistory: Vec3[] = []; // Multi-frame velocity history
  private oneEuroX: OneEuroFilter;
  private oneEuroY: OneEuroFilter;
  private oneEuroZ: OneEuroFilter;
  private lastTimestamp = 0;
  private stableFrames = 0; // Count frames where hand is stable
  private deadZone: number;
  private velocitySmoothing: number;
  private jitterThreshold: number;
  private predictionStrength: number;
  private readonly VELOCITY_HISTORY_SIZE = 5; // Track last 5 frames for better prediction

  constructor(
    deadZone = 0.0003,           // Smaller deadzone for faster response (was 0.0008)
    velocitySmoothing = 0.15,    // Less smoothing for instant tracking (was 0.3)
    jitterThreshold = 0.0015,    // Lower threshold for jitter detection (was 0.002)
    predictionStrength = 0.35,   // Stronger prediction for motion compensation (was 0.15)
    oneEuroMinCutoff = 3.0,      // Higher for instant response (was 1.5)
    oneEuroBeta = 0.02,          // Higher for better velocity tracking (was 0.007)
    oneEuroDCutoff = 2.0         // Higher derivative cutoff (was 1.0)
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
    this.acceleration = { x: 0, y: 0, z: 0 };
    this.velocityHistory = [];
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

    // Dead zone - if movement is tiny, assume it's noise
    // But use much smaller deadzone for faster response
    if (movementMagnitude < this.deadZone) {
      this.stableFrames++;
      this.lastTimestamp = timestamp;
      // Still apply light filtering even in deadzone to reduce micro-jitter
      return {
        x: this.oneEuroX.update(point.x, timestamp),
        y: this.oneEuroY.update(point.y, timestamp),
        z: this.oneEuroZ.update(point.z, timestamp),
      };
    }

    // Reset stable frame counter on significant movement
    this.stableFrames = 0;

    // Calculate instantaneous velocity
    const currentVelocity = {
      x: rawDelta.x / dt,
      y: rawDelta.y / dt,
      z: rawDelta.z / dt,
    };
    
    // Track velocity history for better prediction
    this.velocityHistory.push({ ...currentVelocity });
    if (this.velocityHistory.length > this.VELOCITY_HISTORY_SIZE) {
      this.velocityHistory.shift();
    }

    // Calculate average velocity from history for more stable prediction
    const avgVelocity = this.velocityHistory.reduce(
      (acc, v) => ({ x: acc.x + v.x, y: acc.y + v.y, z: acc.z + v.z }),
      { x: 0, y: 0, z: 0 }
    );
    const historySize = this.velocityHistory.length;
    avgVelocity.x /= historySize;
    avgVelocity.y /= historySize;
    avgVelocity.z /= historySize;

    // Update acceleration for trajectory prediction
    const prevVelocity = this.velocity;
    this.acceleration = {
      x: (currentVelocity.x - prevVelocity.x) / dt,
      y: (currentVelocity.y - prevVelocity.y) / dt,
      z: (currentVelocity.z - prevVelocity.z) / dt,
    };
    
    // Update velocity with minimal smoothing for instant response
    this.velocity = {
      x: lerp(this.velocity.x, currentVelocity.x, this.velocitySmoothing),
      y: lerp(this.velocity.y, currentVelocity.y, this.velocitySmoothing),
      z: lerp(this.velocity.z, currentVelocity.z, this.velocitySmoothing),
    };

    // Detect velocity magnitude
    const velocityMagnitude = Math.sqrt(
      this.velocity.x * this.velocity.x +
      this.velocity.y * this.velocity.y +
      this.velocity.z * this.velocity.z
    );

    let result: Vec3;

    // For small movements, use One Euro Filter to reduce jitter
    if (movementMagnitude < this.jitterThreshold) {
      result = {
        x: this.oneEuroX.update(point.x, timestamp),
        y: this.oneEuroY.update(point.y, timestamp),
        z: this.oneEuroZ.update(point.z, timestamp),
      };
    } else {
      // Fast movement - use aggressive prediction for zero-latency tracking
      // This is key to matching Perfect Corp's instant response
      if (this.predictionStrength > 0 && velocityMagnitude > 0.001) {
        // Use average velocity from history for more stable prediction
        const predictionTime = dt * this.predictionStrength;
        
        // Enhanced prediction with acceleration compensation
        const prediction = {
          x: point.x + avgVelocity.x * predictionTime + 0.5 * this.acceleration.x * predictionTime * predictionTime,
          y: point.y + avgVelocity.y * predictionTime + 0.5 * this.acceleration.y * predictionTime * predictionTime,
          z: point.z + avgVelocity.z * predictionTime + 0.5 * this.acceleration.z * predictionTime * predictionTime,
        };
        
        // Clamp to valid ranges
        result = {
          x: clamp(prediction.x, 0, 1),
          y: clamp(prediction.y, 0, 1),
          z: clamp(prediction.z, -1, 1),
        };
        
        // Apply minimal One Euro filtering to predicted position
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
        deadZone: 0.0002,           // Ultra-low deadzone for instant response
        velocitySmoothing: 0.1,     // Minimal smoothing
        jitterThreshold: 0.001,     // Lower jitter threshold
        predictionStrength: 0.4,    // Strong prediction
        oneEuroMinCutoff: 4.0,      // Very high for instant tracking
        oneEuroBeta: 0.03,          // High velocity response
        oneEuroDCutoff: 2.0,
      },
      balanced: {
        deadZone: 0.0003,
        velocitySmoothing: 0.15,
        jitterThreshold: 0.0015,
        predictionStrength: 0.35,
        oneEuroMinCutoff: 3.0,
        oneEuroBeta: 0.02,
        oneEuroDCutoff: 2.0,
      },
      stable: {
        deadZone: 0.0006,
        velocitySmoothing: 0.25,
        jitterThreshold: 0.002,
        predictionStrength: 0.25,
        oneEuroMinCutoff: 2.0,
        oneEuroBeta: 0.015,
        oneEuroDCutoff: 1.5,
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
