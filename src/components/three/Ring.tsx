import * as THREE from "three";
import { useEffect, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useControls } from "leva";
import { useFrame, useThree } from "@react-three/fiber";
import { useHandStore } from "@/store/hands";

import ringUrl from "@/assets/diamond_ring.glb";
import classicRingUrl from "@/assets/ring.glb";

type RingProps = {
  modelUrl?: string;
};

type Vec3Like = { x: number; y: number; z: number };

const FINGER_CHAINS = [
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
] as const;

const DEFAULT_MODEL_INNER_DIAMETER_RATIO = 0.78;
const MODEL_INNER_DIAMETER_RATIO_MAP: Record<string, number> = {
  [ringUrl]: 0.78,
  [classicRingUrl]: 0.92,
};

const MICRO_JITTER_CONFIG = {
  position: { threshold: 0.0025, strength: 0.45 },
  scale: { threshold: 0.003, strength: 0.4 },
  rotation: { threshold: 0.002, strength: 0.35 },
} as const;

const MIN_ADAPTIVE_ALPHA = 0.001;
const SMOOTH_EPS = 1e-3;

// Helper functions
function distance3(a: Vec3Like, b: Vec3Like) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function applyMicroJitterDamping(
  alpha: number,
  motion: number,
  threshold: number,
  strength: number
) {
  if (!Number.isFinite(alpha)) return alpha;
  if (motion <= 0 || motion >= threshold) return Math.min(alpha, 1);
  
  const normalized = 1 - motion / threshold;
  const damping = 1 - strength * normalized * normalized;
  const damped = alpha * damping;
  return THREE.MathUtils.clamp(damped, MIN_ADAPTIVE_ALPHA, 1);
}

function computeSmoothingAlpha(
  response: number,
  delta: number,
  smoothingStrength: number,
  baseStrength = 0,
  attenuation = 1
) {
  const sliderStrength = THREE.MathUtils.clamp(smoothingStrength ?? 0, 0, 1);
  const combinedStrength = Math.max(baseStrength, sliderStrength);
  
  if (combinedStrength <= SMOOTH_EPS) return 1;

  const clampedStrength = THREE.MathUtils.clamp(combinedStrength, SMOOTH_EPS, 1);
  const baseAlpha = 1 - Math.exp(-response * clampedStrength * delta);

  const attenuationBoost = THREE.MathUtils.clamp(1 - attenuation, 0, 1);
  if (attenuationBoost <= SMOOTH_EPS) return baseAlpha;

  return THREE.MathUtils.lerp(baseAlpha, 1, attenuationBoost * 0.8);
}

function calculateHandClosure(landmarks: Array<{ x: number; y: number; z: number }>) {
  let closureTotal = 0;
  let closureCount = 0;
  
  for (const chain of FINGER_CHAINS) {
    const [mcpIdx, pipIdx, dipIdx, tipIdx] = chain;
    const mcp = landmarks[mcpIdx];
    const pip = landmarks[pipIdx];
    const dip = landmarks[dipIdx];
    const tip = landmarks[tipIdx];
    
    if (!mcp || !pip || !dip || !tip) continue;
    
    const fingerLength = distance3(mcp, pip) + distance3(pip, dip) + distance3(dip, tip);
    if (fingerLength <= 1e-4) continue;
    
    const spread = distance3(mcp, tip) / fingerLength;
    const curl = THREE.MathUtils.clamp(1 - spread, 0, 1);
    closureTotal += curl;
    closureCount++;
  }
  
  return closureCount > 0 ? closureTotal / closureCount : 0;
}

function calculateAnchorPoint(
  p13: Vec3Like,
  p14: Vec3Like,
  bias13: number,
  alongFinger: number
) {
  const bias14 = 1 - bias13;
  let x = p13.x * bias13 + p14.x * bias14;
  let y = p13.y * bias13 + p14.y * bias14;
  
  if (alongFinger !== 0) {
    x += (p14.x - p13.x) * alongFinger;
    y += (p14.y - p13.y) * alongFinger;
  }
  
  return { x, y };
}

function calculateMotionAttenuation(
  rawDelta: number,
  threshold: number,
  power: number,
  min: number
) {
  if (rawDelta <= 0) return 1;
  
  const motionFactorNorm = THREE.MathUtils.clamp(rawDelta / threshold, 0, 1);
  const motionIntensity = Math.pow(motionFactorNorm, 0.9);
  return Math.max(min, 1 - motionIntensity * power);
}

function applyDeadzone(
  anchorX: number,
  anchorY: number,
  prevX: number,
  prevY: number,
  deadzone: number
): { x: number; y: number } {
  if (deadzone <= 0) return { x: anchorX, y: anchorY };
  
  const deltaX = anchorX - prevX;
  const deltaY = anchorY - prevY;
  const diff = Math.hypot(deltaX, deltaY);
  
  if (diff < deadzone) {
    const softness = THREE.MathUtils.clamp(diff / Math.max(deadzone, 1e-6), 0, 1);
    const eased = softness * softness * (3 - 2 * softness);
    return {
      x: prevX + deltaX * eased,
      y: prevY + deltaY * eased
    };
  }
  
  if (diff < deadzone * 3) {
    const t = (diff - deadzone) / (deadzone * 2);
    const eased = THREE.MathUtils.clamp(t, 0, 1);
    return {
      x: THREE.MathUtils.lerp(prevX, anchorX, eased),
      y: THREE.MathUtils.lerp(prevY, anchorY, eased)
    };
  }
  
  return { x: anchorX, y: anchorY };
}

function calculateOrientationTransition(
  orientation: 'palm' | 'back' | null,
  palmScore: number | null,
  scoreEps: number
) {
  const normalizedPalmScore = palmScore != null
    ? THREE.MathUtils.clamp(palmScore, -1, 1)
    : orientation === "back"
    ? -1
    : orientation === "palm"
    ? 1
    : 0;

  const scoreTransition = THREE.MathUtils.clamp(0.5 - 0.5 * normalizedPalmScore, 0, 1);
  let targetTransition = orientation === "back" ? 1 : orientation === "palm" ? 0 : scoreTransition;
  
  const scoreWeight = palmScore != null
    ? THREE.MathUtils.clamp((Math.abs(normalizedPalmScore) - scoreEps) / Math.max(1 - scoreEps, 1e-5), 0, 1)
    : 0;
    
  if (scoreWeight > 0) {
    const blendedScoreTarget = THREE.MathUtils.lerp(targetTransition, scoreTransition, scoreWeight);
    if (orientation === "back") {
      targetTransition = Math.min(targetTransition, blendedScoreTarget);
    } else if (orientation === "palm") {
      targetTransition = Math.max(targetTransition, blendedScoreTarget);
    } else {
      targetTransition = blendedScoreTarget;
    }
  }
  
  return { targetTransition, normalizedPalmScore };
}

function blendRotations(
  palmRotation: { x: number; y: number; z: number },
  backRotation: { x: number; y: number; z: number },
  transition: number
) {
  return {
    x: THREE.MathUtils.lerp(palmRotation.x, backRotation.x, transition),
    y: THREE.MathUtils.lerp(palmRotation.y, backRotation.y, transition),
    z: THREE.MathUtils.lerp(palmRotation.z, backRotation.z, transition),
  };
}

export default function Ring({ modelUrl }: RingProps) {
  const group = useRef<THREE.Group>(null!);
  const activeModelUrl = modelUrl ?? ringUrl;
  const modelInnerDiameterRatio =
    MODEL_INNER_DIAMETER_RATIO_MAP[activeModelUrl] ?? DEFAULT_MODEL_INNER_DIAMETER_RATIO;
  const { scene } = useGLTF(activeModelUrl);
  const userRotationGroup = useRef<THREE.Group>(null!);
  // Prefer raw landmarks for zero-latency placement; fall back to blended when raw data is unavailable.
  const landmarksRaw = useHandStore((state) => state.landmarksRaw);
  const landmarksBlended = useHandStore((state) => state.landmarks);
  const landmarksStabilized = useHandStore((state) => state.landmarksStabilized);
  const landmarksTimestamp = useHandStore((state) => state.landmarksUpdatedAt);
  const orientation = useHandStore((state) => state.orientation);
  const palmScore = useHandStore((state) => state.palmScore);
  const handedness = useHandStore((state) => state.handedness);

  //  orientation === 'back' : back of hand faces camera -> user sees ring head (stone). We keep head, hide shank.
  //  orientation === 'palm' : palm faces camera -> user would see underside; show shank instead (hide head) for clarity.
  //  null/unknown          : default previous behavior (currently behaves like 'back').
  const { camera, size, gl } = useThree();
  // Dynamic clipping plane that hides the half of ring facing away from camera.
  // Why not just rely on material.side = BackSide / FrontSide? The ring is a closed mesh; we want to
  // selectively remove the *entire back half* (shank) so the stone setting stays visible and we avoid
  // visual clutter when finger occludes the far geometry. A single plane acts like a live boolean cut.
  // Alternatives considered:
  // 1. Splitting model into 'front' + 'shank' meshes and toggling visibility by comparing normal dot view.
  //    -> Needs authoring change / naming consistency in GLB.
  // 2. Custom shader discarding fragments with normal dot view < 0.
  //    -> Removes pixels but still draws back geometry cost; also removes internal metal that might still be wanted.
  // 3. Stencil / depth pre-pass.
  //    -> Overkill for simple half hide.
  // Clipping plane provides clean geometry cutoff and works with shadows (clipShadows = true).
  const clipPlane = useRef<THREE.Plane | null>(null);
  const ringMaterials = useRef<THREE.Material[]>([]);

  // Helper vector objects to avoid allocations
  const ndc = useRef(new THREE.Vector3());
  const dir = useRef(new THREE.Vector3());
  const pos = useRef(new THREE.Vector3());
  const baseDiameter = useRef<number | null>(null);
  const targetScale = useRef(1);
  const viewAxisAngle = useRef(0); // smoothed rotation around camera view axis
  const tiltX = useRef(0); // smoothed X tilt driven by palmScore
  const smoothedFingerDiameterNorm = useRef<number | null>(null); // smoothed normalized (0..1) finger diameter on screen
  const smoothedPosition = useRef(new THREE.Vector3()); // for subtle smoothing without latency
  const prevAnchor = useRef(new THREE.Vector3());
  const anchorVelocity = useRef(new THREE.Vector3());
  const anchorInitialized = useRef(false);
  const anchorMotionMagnitude = useRef(0);
  const prevRawAnchorNorm = useRef({ x: 0, y: 0 });
  const prevFilteredAnchorNorm = useRef({ x: 0, y: 0 });
  const rawAnchorInitialized = useRef(false);
  const filteredAnchorInitialized = useRef(false);
  const microAnchorNorm = useRef(new THREE.Vector2());
  const microAnchorInitialized = useRef(false);
  const smoothedHandClosure = useRef(0);
  const smoothedRotationYOffset = useRef(0);
  const rotationYOffsetInitialized = useRef(false);
  const lastTransformLogTs = useRef(0);

  // Smooth orientation transitions to prevent jitter when rotating hand
  const smoothedOrientation = useRef<'palm' | 'back' | null>(null);
  const orientationTransition = useRef(0); // 0 = palm, 1 = back
  const prevRotation = useRef({ x: 0, y: 0, z: 0 }); // Track previous rotation for smoothing
  const prevClipNormal = useRef(new THREE.Vector3(0, 0, -1)); // Track clipping plane normal for smoothing

  // Tuning
  // ---------------- Scaling Tuning ----------------
  // Optimized for Perfect Corp-level instant response with minimal jitter
  const BASE_DISTANCE = 30; // baseline world depth to place the ring (arbitrary scene units)
  const SCALE_RESPONSE = 220; // ultra-aggressive for instant scale response (was 140)
  const WIDTH_RESPONSE = 250; // ultra-aggressive for instant diameter response (was 180)
  const POSITION_DAMP = 200; // much higher for instant position tracking (was 55)
  const ORIENTATION_RESPONSE = 200; // instant rotation sync (was 120)
  const TILT_RESPONSE = 150; // fast tilt response (was 90)
  const DEPTH_RANGE = 65; // converts MediaPipe depth units into world distance
  const DEPTH_RESPONSE = 180; // much faster depth tracking (was 95)
  const SCALE_MIN = 0.05;
  const SCALE_MAX = 3.5;
  // Depth-driven scale range ensures ring grows as hand approaches camera.
  const DEPTH_SCALE_NEAR_DISTANCE = Math.max(5, BASE_DISTANCE - DEPTH_RANGE * 0.45);
  const DEPTH_SCALE_FAR_DISTANCE = BASE_DISTANCE + DEPTH_RANGE * 0.55;
  const DEPTH_SCALE_NEAR = 1.35;
  const DEPTH_SCALE_FAR = 0.75;
  const smoothedDistance = useRef(BASE_DISTANCE);
  const CLOSURE_RESPONSE = 120; // faster hand closure response (was 70)

  // Model calibration: estimate ratio (inner_diameter / measured_box_diameter)
  // If your model's bounding box covers outer metal thickness, inner hole is smaller.

  // Anatomical heuristic: proximal phalanx width ≈ 0.34–0.40 of proximal segment length (13->14)
  const FINGER_DIAMETER_TO_SEGMENT_RATIO = 0.40; // slightly larger to better approximate real finger thickness

  // Fit factor > 1 means leave some slack so ring doesn't intersect finger mesh visually.
  const SNUG_FIT = 0.72; // slightly looser so model doesn't appear too small

  // Motion-adaptive smoothing: attenuate filtering when the anchor moves quickly to keep latency low.
  const MOTION_ATTENUATION_THRESHOLD = 0.005; // higher threshold = less attenuation (was 0.003)
  const MOTION_ATTENUATION_POWER = 0.5; // less aggressive attenuation (was 0.85)
  const MOTION_ATTENUATION_MIN = 0.5; // higher floor for more damping (was 0.18)
  const WORLD_SPEED_ATTENUATION_GAIN = 0.02; // reduced for less attenuation (was 0.04)
  const WORLD_SPEED_ATTENUATION_POWER = 0.5; // less aggressive (was 0.75)

  // Exposed user tuning controls (via Leva) to fine tune size & anchor without code edits.
  // anchorToward14: 0 keeps original bias (toward 13), 1 moves fully to joint 14.
  // alongFinger: pushes further along the 13->14 segment (positive toward 14, negative back toward 13).
  // Note: fitAdjust is now dynamic based on hand orientation (2.50 horizontal, 2.0 vertical)
  const { anchorToward14, alongFinger, positionSmoothing, motionLookaheadMs, jitterBlend, jitterVelocityCutoff, jitterDeadzone } = useControls('Ring Fit', {
    anchorToward14: { value: 0.30, min: 0, max: 1, step: 0.01 },
    alongFinger: { value: 0.05, min: -0.3, max: 0.6, step: 0.005 },
    positionSmoothing: { label: "Smoothing Amount", value: 0, min: 0, max: 1, step: 0.05 },
    motionLookaheadMs: { label: "Lookahead (ms)", value: 16, min: 0, max: 150, step: 1 }, // Increased default for better prediction
    jitterBlend: { label: "Stabilized Blend", value: 0.15, min: 0, max: 1, step: 0.05 }, // Reduced for more raw data
    jitterVelocityCutoff: { label: "Blend Cutoff", value: 0.01, min: 0.001, max: 0.1, step: 0.001 }, // Lower for faster blend-out
    jitterDeadzone: { label: "Jitter Deadzone", value: 0.0008, min: 0, max: 0.015, step: 0.0001 }, // Smaller for more responsiveness
  });
  const { rotationOffsetX, rotationOffsetY, rotationOffsetZ, closureOffsetZ, positionOffsetZ, positionOffsetY, rotationOffsetPositionY, closureOffsetPositionZ, closureScaleBoost } = useControls('Ring Orientation', {
    rotationOffsetX: { label: "Offset X (°)", value: 25, min: -180, max: 180, step: 0.5 },
    rotationOffsetY: { label: "Offset Y (°)", value: 0, min: -180, max: 180, step: 0.5 },
    rotationOffsetZ: { label: "Offset Z (°)", value: 0, min: -180, max: 180, step: 0.5 },
    closureOffsetZ: { label: "Close Adjust Z (°)", value: 80, min: 0, max: 90, step: 0.5 },
    positionOffsetZ: { label: "Base Pos Z", value: -5.4, min: -20, max: 20, step: 0.05 },
    positionOffsetY: { label: "Base Pos Y", value: 0, min: -20, max: 20, step: 0.05 },
    rotationOffsetPositionY: { label: "Rotate Adjust Pos Y", value: 0.25, min: -5, max: 5, step: 0.01 },
    closureOffsetPositionZ: { label: "Close Adjust Pos", value: 1.5, min: 0, max: 10, step: 0.05 },
    closureScaleBoost: { label: "Close Scale Boost", value: 0.5, min: 0, max: 4, step: 0.01 },
  });
  // Independent base rotation controller (degrees for UX, converted to radians)
  // const { baseRotX, baseRotY, baseRotZ } = useControls('Ring Base Rotation', {
  //   baseRotX: { value: 1.6 * 57.2958, min: -180, max: 180, step: 0.1 }, // default existing 1.6 rad
  //   baseRotY: { value: 0, min: -180, max: 180, step: 0.1 },
  //   baseRotZ: { value: 0, min: -180, max: 180, step: 0.1 },
  // });
  const DEFAULT_BIAS_TOWARD_13 = 0.6; // legacy bias baseline

  // Enable shadows and gently tune PBR materials for better metal reflections
  useEffect(() => {
  // Enable local clipping on renderer once
  gl.localClippingEnabled = true;

    scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        const material = mesh.material as THREE.Material | THREE.Material[];
        const mats = (
          Array.isArray(material) ? material : [material]
        ) as THREE.Material[];
        for (const mat of mats) {
          if (mat instanceof THREE.MeshStandardMaterial) {
            mat.envMapIntensity ??= 0.5;
            mat.metalness = Math.max(0.9, mat.metalness ?? 1);
            mat.roughness = Math.max(0.05, mat.roughness ?? 0.05);
          }
        }
      }
    });
  }, [scene, gl]);

  // Compute model diameter once to scale accurately
  useEffect(() => {
    // Tweak materials for better visibility with dynamic env
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const materials: THREE.Material[] = Array.isArray(obj.material)
          ? (obj.material as THREE.Material[])
          : obj.material
          ? [obj.material as THREE.Material]
          : [];
        const updated = materials.map((m) => {
          if (
            m instanceof THREE.MeshStandardMaterial ||
            m instanceof THREE.MeshPhysicalMaterial
          ) {
            // MeshPhysicalMaterial extends MeshStandardMaterial, so this is safe
            const sm = m as THREE.MeshStandardMaterial;
            sm.envMapIntensity = 2.0;
            sm.metalness = 1.0;
            sm.roughness = 0.2;
            sm.needsUpdate = true;
            return sm;
          }
          return new THREE.MeshStandardMaterial({
            color: 0xdddddd,
            metalness: 1,
            roughness: 0.25,
            envMapIntensity: 2.0,
          });
        });
        // Reassign only if we had non-PBR materials
        if (updated.some((m, i) => m !== materials[i])) {
          obj.material = updated.length === 1 ? updated[0] : updated;
        }
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });

    const box = new THREE.Box3().setFromObject(scene);
    const s = new THREE.Vector3();
    box.getSize(s);
    const diameter = Math.max(s.x, s.y); // ring diameter mostly in X/Y
    baseDiameter.current = diameter || 1; // avoid div-by-zero

    // Collect all materials (avoid duplicates) for clipping modification
    const mats: THREE.Material[] = [];
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const m = (o as THREE.Mesh).material;
        if (Array.isArray(m)) {
          m.forEach((mm) => mm && mats.push(mm));
        } else if (m) mats.push(m as THREE.Material);
      }
    });
    // Deduplicate by id
    const unique = Array.from(new Set(mats));
    ringMaterials.current = unique;

    // Initialize plane once along camera forward axis; normal will get updated per-frame
    if (!clipPlane.current) {
      clipPlane.current = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    }
  }, [scene]);

  useFrame((_, delta) => {
    const lms = landmarksRaw ?? landmarksBlended;
    if (lms && lms.length >= 21 && group.current) {
      const p13 = lms[13];
      const p14 = lms[14];
      if (!p13 || !p14) {
        return;
      }

      const smoothingStrength = positionSmoothing ?? 0;
      const computeAlpha = (response: number, baseStrength = 0, attenuation = 1) =>
        computeSmoothingAlpha(response, delta, smoothingStrength, baseStrength, attenuation);
  const nowTs = typeof performance !== "undefined" ? performance.now() : Date.now();
  const dataAgeMs = landmarksTimestamp != null ? Math.max(0, nowTs - landmarksTimestamp) : 0;
      const lookaheadMs = Math.max(0, motionLookaheadMs ?? 0) + dataAgeMs;
      const lookaheadSeconds = Math.min(0.25, lookaheadMs / 1000);

      // Weighted midpoint between ring finger MCP (13) and PIP (14) with bias toward 13 (base of finger)
      const bias13 = THREE.MathUtils.lerp(DEFAULT_BIAS_TOWARD_13, 0, anchorToward14);
      const rawAnchor = calculateAnchorPoint(p13, p14, bias13, alongFinger);
      let rawAnchorX = rawAnchor.x;
      let rawAnchorY = rawAnchor.y;

      let rawDelta = 0;
      let smoothingAttenuation = 1;
      if (!rawAnchorInitialized.current) {
        rawAnchorInitialized.current = true;
        prevRawAnchorNorm.current.x = rawAnchorX;
        prevRawAnchorNorm.current.y = rawAnchorY;
      } else {
        rawDelta = Math.hypot(
          rawAnchorX - prevRawAnchorNorm.current.x,
          rawAnchorY - prevRawAnchorNorm.current.y
        );
      }
      anchorMotionMagnitude.current = rawDelta;
      prevRawAnchorNorm.current.x = rawAnchorX;
      prevRawAnchorNorm.current.y = rawAnchorY;

      if (rawDelta > 0) {
        smoothingAttenuation = calculateMotionAttenuation(
          rawDelta,
          MOTION_ATTENUATION_THRESHOLD,
          MOTION_ATTENUATION_POWER,
          MOTION_ATTENUATION_MIN
        );
      }

      let anchorX = rawAnchorX;
      let anchorY = rawAnchorY;

      if (jitterBlend > 0 && landmarksStabilized && landmarksStabilized.length >= 21) {
        const s13 = landmarksStabilized[13];
        const s14 = landmarksStabilized[14];
        if (s13 && s14) {
          const stableAnchor = calculateAnchorPoint(s13, s14, bias13, alongFinger);

          const velocityCut = Math.max(0.0005, jitterVelocityCutoff);
          const velocityRatio = THREE.MathUtils.clamp(rawDelta / velocityCut, 0, 1);
          const blendWeight = jitterBlend * (1 - velocityRatio);
          anchorX = THREE.MathUtils.lerp(anchorX, stableAnchor.x, blendWeight);
          anchorY = THREE.MathUtils.lerp(anchorY, stableAnchor.y, blendWeight);
        }
      }

      const deadzone = Math.max(0, jitterDeadzone);
      let filteredX = anchorX;
      let filteredY = anchorY;
      if (!filteredAnchorInitialized.current) {
        filteredAnchorInitialized.current = true;
      } else {
        const filtered = applyDeadzone(
          anchorX,
          anchorY,
          prevFilteredAnchorNorm.current.x,
          prevFilteredAnchorNorm.current.y,
          deadzone
        );
        filteredX = filtered.x;
        filteredY = filtered.y;
      }

      if (!microAnchorInitialized.current) {
        microAnchorNorm.current.set(filteredX, filteredY);
        microAnchorInitialized.current = true;
      } else {
        const microDx = filteredX - microAnchorNorm.current.x;
        const microDy = filteredY - microAnchorNorm.current.y;
        const microDist = Math.hypot(microDx, microDy);
        const microThreshold = Math.max(0.0002, deadzone * 0.2); // Much smaller threshold for instant tracking
        const ratio = microThreshold > 0 ? THREE.MathUtils.clamp(microDist / microThreshold, 0, 1) : 1;
        const speedMultiplier = microDist > microThreshold ? 1 : ratio * ratio;
        const followRate = microDist > microThreshold ? 280 : 200; // Much higher follow rates for instant response
        const alphaMicro = 1 - Math.exp(-followRate * Math.max(speedMultiplier, 0.15) * delta); // Higher minimum multiplier
        microAnchorNorm.current.x += microDx * alphaMicro;
        microAnchorNorm.current.y += microDy * alphaMicro;
      }

      const anchorNormX = microAnchorNorm.current.x;
      const anchorNormY = microAnchorNorm.current.y;
      prevFilteredAnchorNorm.current.x = anchorNormX;
      prevFilteredAnchorNorm.current.y = anchorNormY;

      // Account for object-fit: cover cropping
      // Video is 640x480 (4:3), container is 360x480 (3:4)
      // The video is cropped on left/right sides
      const videoAspect = 640 / 480; // 1.333 (4:3)
      const containerAspect = size.width / size.height;
      
      let adjustedX = anchorNormX;
      let adjustedY = anchorNormY;
      
      if (videoAspect > containerAspect) {
        // Video is wider - crops left/right (this is our case)
        const visibleWidthRatio = containerAspect / videoAspect;
        const cropOffset = (1 - visibleWidthRatio) / 2;
        adjustedX = (anchorNormX - cropOffset) / visibleWidthRatio;
        adjustedX = THREE.MathUtils.clamp(adjustedX, 0, 1);
      } else {
        // Video is taller - crops top/bottom
        const visibleHeightRatio = videoAspect / containerAspect;
        const cropOffset = (1 - visibleHeightRatio) / 2;
        adjustedY = (anchorNormY - cropOffset) / visibleHeightRatio;
        adjustedY = THREE.MathUtils.clamp(adjustedY, 0, 1);
      }

      const mirroredX = 1 - adjustedX; // account for mirrored video
      ndc.current.set(mirroredX * 2 - 1, -(adjustedY * 2 - 1), 0.5);
      // Unproject from NDC to world: create a ray from camera through ndc
      ndc.current.unproject(camera);
      dir.current.copy(ndc.current).sub(camera.position).normalize();

      // Approximate depth using MediaPipe z so the ring stays glued when the hand leans
      const depthOffset = THREE.MathUtils.clamp(p13.z, -0.6, 0.6) * DEPTH_RANGE;
      const targetDistance = BASE_DISTANCE + depthOffset;
  const depthAlpha = computeAlpha(DEPTH_RESPONSE, 0.08, smoothingAttenuation); // Much lower base strength (was 0.28)
      smoothedDistance.current = THREE.MathUtils.lerp(
        smoothedDistance.current,
        targetDistance,
        depthAlpha
      );

      pos.current.copy(camera.position).add(
        dir.current.multiplyScalar(smoothedDistance.current)
      );

      if (!anchorInitialized.current) {
        prevAnchor.current.copy(pos.current);
        anchorVelocity.current.set(0, 0, 0);
        anchorInitialized.current = true;
      } else {
        const dt = Math.max(delta, 1e-4);
        anchorVelocity.current
          .copy(pos.current)
          .sub(prevAnchor.current)
          .divideScalar(dt);
        prevAnchor.current.copy(pos.current);
        if (lookaheadSeconds > 0) {
          pos.current.addScaledVector(anchorVelocity.current, lookaheadSeconds);
        }
        const worldSpeed = anchorVelocity.current.length();
        if (worldSpeed > 0) {
          const worldFactor = THREE.MathUtils.clamp(
            worldSpeed * WORLD_SPEED_ATTENUATION_GAIN,
            0,
            1
          );
          const worldAttenuation = Math.max(
            MOTION_ATTENUATION_MIN,
            1 - worldFactor * WORLD_SPEED_ATTENUATION_POWER
          );
          smoothingAttenuation = Math.min(smoothingAttenuation, worldAttenuation);
        }
      }

      let posAlpha = computeAlpha(POSITION_DAMP, 0.05, smoothingAttenuation); // Much lower base strength (was 0.26)
      posAlpha = applyMicroJitterDamping(
        posAlpha,
        anchorMotionMagnitude.current,
        MICRO_JITTER_CONFIG.position.threshold,
        MICRO_JITTER_CONFIG.position.strength
      );
      if (smoothedPosition.current.lengthSq() === 0 || posAlpha >= 0.999) {
        smoothedPosition.current.copy(pos.current);
      } else {
        smoothedPosition.current.lerp(pos.current, posAlpha);
      }
      group.current.position.copy(smoothedPosition.current);

      // --- Finger Diameter Estimation (Normalized Screen Space) ---
      const dxSeg = p13.x - p14.x;
      const dySeg = p13.y - p14.y;
      const segmentLenNorm = Math.sqrt(dxSeg * dxSeg + dySeg * dySeg);
      const rawDiameterNorm = segmentLenNorm * FINGER_DIAMETER_TO_SEGMENT_RATIO;
      let widthAlpha = computeAlpha(WIDTH_RESPONSE, 0.05, smoothingAttenuation); // Much lower base strength (was 0.22)
      widthAlpha = applyMicroJitterDamping(
        widthAlpha,
        anchorMotionMagnitude.current,
        MICRO_JITTER_CONFIG.scale.threshold,
        MICRO_JITTER_CONFIG.scale.strength * 0.7
      );
      smoothedFingerDiameterNorm.current =
        smoothedFingerDiameterNorm.current == null
          ? rawDiameterNorm
          : THREE.MathUtils.lerp(
              smoothedFingerDiameterNorm.current,
              rawDiameterNorm,
              widthAlpha
            );

      const diameterNorm = smoothedFingerDiameterNorm.current;

      // Convert normalized diameter on screen to desired world diameter at this depth
      const aspect = size.width / size.height;
      const fovRad = THREE.MathUtils.degToRad(
        (camera as THREE.PerspectiveCamera).fov
      );
      const viewWidthAtZ =
        2 * smoothedDistance.current * Math.tan(fovRad / 2) * aspect;
      const desiredWorldDiameter = diameterNorm * viewWidthAtZ;
      const depthDistanceRange = DEPTH_SCALE_FAR_DISTANCE - DEPTH_SCALE_NEAR_DISTANCE;
      const normalizedDistance =
        depthDistanceRange > 1e-4
          ? THREE.MathUtils.clamp(
              (smoothedDistance.current - DEPTH_SCALE_NEAR_DISTANCE) /
                depthDistanceRange,
              0,
              1
            )
          : 0;
      const depthScaleFactor = THREE.MathUtils.lerp(
        DEPTH_SCALE_NEAR,
        DEPTH_SCALE_FAR,
        normalizedDistance
      );

      if (baseDiameter.current) {
        const modelInnerDiameter = baseDiameter.current * modelInnerDiameterRatio;
        const fitScaleRaw =
          ((desiredWorldDiameter * SNUG_FIT) / modelInnerDiameter) * depthScaleFactor;
        
        // Dynamic fitAdjust based on hand orientation: 2.50 for horizontal, 2.0 for vertical
        const palmScoreAbs = palmScore != null ? Math.abs(palmScore) : 1;
        const horizontalness = THREE.MathUtils.clamp(1 - palmScoreAbs, 0, 1); // 1 = horizontal, 0 = vertical
        const dynamicFitAdjust = THREE.MathUtils.lerp(2.0, 2.50, horizontalness);
        
        const fitScale = THREE.MathUtils.clamp(
          fitScaleRaw * dynamicFitAdjust,
          SCALE_MIN,
          SCALE_MAX
        );
        let scaleAlpha = computeAlpha(SCALE_RESPONSE, 0.04, smoothingAttenuation); // Much lower base strength (was 0.24)
        scaleAlpha = applyMicroJitterDamping(
          scaleAlpha,
          anchorMotionMagnitude.current,
          MICRO_JITTER_CONFIG.scale.threshold,
          MICRO_JITTER_CONFIG.scale.strength
        );
        targetScale.current = THREE.MathUtils.lerp(
          targetScale.current,
          fitScale,
          scaleAlpha
        );
      }

      group.current.lookAt(camera.position);
      const x13s = 1 - p13.x;
      const y13s = p13.y;
      const x14s = 1 - p14.x;
      const y14s = p14.y;
      const segAngle = Math.atan2(y14s - y13s, x14s - x13s);
      const targetAngle = -segAngle + 0.5;
      const curr = viewAxisAngle.current;
      const diff = ((targetAngle - curr + Math.PI) % (2 * Math.PI)) - Math.PI;
      let angleAlpha = computeAlpha(ORIENTATION_RESPONSE, 0.03, smoothingAttenuation); // Much lower base strength (was 0.22)
      angleAlpha = applyMicroJitterDamping(
        angleAlpha,
        anchorMotionMagnitude.current,
        MICRO_JITTER_CONFIG.rotation.threshold,
        MICRO_JITTER_CONFIG.rotation.strength
      );
      viewAxisAngle.current = curr + diff * angleAlpha;
      group.current.rotation.z = viewAxisAngle.current;

      let closureScaleMultiplier = 1;
      if (userRotationGroup.current) {
        const rotationOffsetXDeg =
          handedness?.toLowerCase() === "right" ? -50.0 : rotationOffsetX;
        const offsetXRad = THREE.MathUtils.degToRad(rotationOffsetXDeg);
        const offsetYRad = THREE.MathUtils.degToRad(rotationOffsetY);
        const offsetZRad = THREE.MathUtils.degToRad(rotationOffsetZ);
        const closureOffsetZRad = THREE.MathUtils.degToRad(closureOffsetZ);
        const closureRaw = calculateHandClosure(lms);
        const closureAlpha = computeAlpha(CLOSURE_RESPONSE, 0.05, smoothingAttenuation);
        smoothedHandClosure.current = THREE.MathUtils.lerp(
          smoothedHandClosure.current,
          closureRaw,
          closureAlpha
        );
        if (orientation === "back") {
          closureScaleMultiplier = Math.max(
            0.01,
            1 + closureScaleBoost * smoothedHandClosure.current
          );
        }
        const closureZ =
          orientation === "back"
            ? closureOffsetZRad * smoothedHandClosure.current
            : 0;
        const basePosZ = positionOffsetZ;
        const closurePosZ =
          orientation === "back"
            ? -closureOffsetPositionZ * smoothedHandClosure.current
            : 0;
        const TILT_MAX_RAD = THREE.MathUtils.degToRad(35);
        const SCORE_EPS = 0.12;
        const hasScore = palmScore != null && Math.abs(palmScore) > SCORE_EPS;
        const score = hasScore
          ? (palmScore as number)
          : orientation === "palm"
          ? 1
          : orientation === "back"
          ? -1
          : 0;
        const sign = handedness?.toLowerCase() === "left" ? -1 : 1;
        const targetTilt = score * TILT_MAX_RAD * sign;
        let tiltAlpha = computeAlpha(TILT_RESPONSE, 0.06, smoothingAttenuation); // Much lower base strength (was 0.2)
        tiltAlpha = applyMicroJitterDamping(
          tiltAlpha,
          anchorMotionMagnitude.current,
          MICRO_JITTER_CONFIG.rotation.threshold,
          MICRO_JITTER_CONFIG.rotation.strength * 0.8
        );
        
        // Shift ring along Y as the hand rotates so it hugs the finger.
        const approxFingerRadius = Math.max(
          0.001,
          desiredWorldDiameter > 0
            ? desiredWorldDiameter * 0.5
            : (baseDiameter.current ?? 1) * targetScale.current * 0.5
        );
        
        const palmScoreNormalized = palmScore != null
          ? THREE.MathUtils.clamp(palmScore, -1, 1)
          : orientation === "back"
          ? -1
          : orientation === "palm"
          ? 1
          : 0;
        const rotationInfluence = palmScoreNormalized;
        const targetPosY =
          positionOffsetY +
          rotationOffsetPositionY * approxFingerRadius * rotationInfluence;

        let posYAlpha = computeAlpha(POSITION_DAMP, 0.05, smoothingAttenuation);
        posYAlpha = applyMicroJitterDamping(
          posYAlpha,
          anchorMotionMagnitude.current,
          MICRO_JITTER_CONFIG.position.threshold,
          MICRO_JITTER_CONFIG.position.strength
        );

        if (
          !rotationYOffsetInitialized.current ||
          !Number.isFinite(smoothedRotationYOffset.current)
        ) {
          smoothedRotationYOffset.current = targetPosY;
          rotationYOffsetInitialized.current = true;
        } else {
          smoothedRotationYOffset.current = THREE.MathUtils.lerp(
            smoothedRotationYOffset.current,
            targetPosY,
            posYAlpha
          );
        }

        userRotationGroup.current.position.y = smoothedRotationYOffset.current;
        userRotationGroup.current.position.z = basePosZ + closurePosZ;
        
        const { targetTransition } = calculateOrientationTransition(
          orientation,
          palmScore,
          SCORE_EPS
        );
        
        const transitionAlpha = 1 - Math.exp(-12 * delta);
        orientationTransition.current = THREE.MathUtils.lerp(
          orientationTransition.current,
          targetTransition,
          transitionAlpha
        );
        
        // Update smoothed orientation once transition is mostly complete
        if (orientationTransition.current > 0.9 && orientation === "back") {
          smoothedOrientation.current = "back";
        } else if (orientationTransition.current < 0.1 && orientation === "palm") {
          smoothedOrientation.current = "palm";
        }
        
        // Calculate target rotations for both orientations
        const backRotation = {
          x: THREE.MathUtils.degToRad(
            handedness?.toLowerCase() === "left" ? -65.0 : -128.0
          ) + tiltX.current * 8 + offsetXRad,
          y: offsetYRad,
          z: offsetZRad - closureZ,
        };
        
        const palmRotation = {
          x: 1 + offsetXRad,
          y: offsetYRad,
          z: offsetZRad,
        };
        
        const blendedRotation = blendRotations(
          palmRotation,
          backRotation,
          orientationTransition.current
        );

        // Apply additional smoothing to rotation changes (X and Y axes follow instantly to avoid lag)
        const rotationSmoothAlpha = 1 - Math.exp(-15 * delta);
        prevRotation.current.x = blendedRotation.x;
        prevRotation.current.y = blendedRotation.y;
        prevRotation.current.z = THREE.MathUtils.lerp(prevRotation.current.z, blendedRotation.z, rotationSmoothAlpha);
        
        // Limit palm orientation rotation to max -150° for LEFT hand only
        // const MAX_PALM_ROTATION_LEFT = THREE.MathUtils.degToRad(-150);
        // if (orientation === "palm" && prevRotation.current.x < MAX_PALM_ROTATION_LEFT) {
        //   prevRotation.current.x = MAX_PALM_ROTATION_LEFT;
        // }
        
        
        // Only update tiltX when in back orientation
        if (orientationTransition.current > 0.5) {
          tiltX.current = THREE.MathUtils.lerp(tiltX.current, targetTilt, tiltAlpha);
        }
        
        userRotationGroup.current.rotation.set(
          prevRotation.current.x,
          prevRotation.current.y,
          prevRotation.current.z
        );

        const logNow = typeof performance !== "undefined" ? performance.now() : Date.now();

      const safeScaleMultiplier = Math.max(0.01, closureScaleMultiplier);
      group.current.scale.setScalar(targetScale.current * safeScaleMultiplier);
        if (!Number.isFinite(lastTransformLogTs.current) || logNow - lastTransformLogTs.current >= 1000) {
          const offsetRotationDeg = {
            x: rotationOffsetXDeg,
            y: rotationOffsetY,
            z: rotationOffsetZ,
          };
          const offsetTransformDeg = {
            x: THREE.MathUtils.radToDeg(userRotationGroup.current.rotation.x),
            y: THREE.MathUtils.radToDeg(userRotationGroup.current.rotation.y),
            z: THREE.MathUtils.radToDeg(userRotationGroup.current.rotation.z),
          };
          const baseRotationDeg = {
            x: THREE.MathUtils.radToDeg(group.current.rotation.x),
            y: THREE.MathUtils.radToDeg(group.current.rotation.y),
            z: THREE.MathUtils.radToDeg(group.current.rotation.z),
          };
          const basePos = group.current.position;
          const offsetPos = userRotationGroup.current.position;
          console.log(
            `[Ring Transform] offsets(deg): ctrl=(${offsetRotationDeg.x.toFixed(2)}, ${offsetRotationDeg.y.toFixed(2)}, ${offsetRotationDeg.z.toFixed(2)}) -> applied=(${offsetTransformDeg.x.toFixed(2)}, ${offsetTransformDeg.y.toFixed(2)}, ${offsetTransformDeg.z.toFixed(2)}) | baseRot(deg)=(${baseRotationDeg.x.toFixed(2)}, ${baseRotationDeg.y.toFixed(2)}, ${baseRotationDeg.z.toFixed(2)}) | offsetPos=(${offsetPos.x.toFixed(2)}, ${offsetPos.y.toFixed(2)}, ${offsetPos.z.toFixed(2)}) | basePos=(${basePos.x.toFixed(2)}, ${basePos.y.toFixed(2)}, ${basePos.z.toFixed(2)})`
          );
          lastTransformLogTs.current = logNow;
        }
        
      }

      // --- Dynamic half-ring visibility controlled by hand orientation ---
      // Requirement: when orientation === 'back' (back of hand showing to camera) -> show ring HEAD (stone) hide shank
      //              when orientation === 'palm' (palm toward camera) -> show SHANK hide head
      // We approximate by flipping clipping plane normal: plane keeps geometry on normal side.
      if (clipPlane.current) {
        // Plane normal points toward camera; plane passes through ring center (group position)
        // Determine view direction from ring center to camera
        const planeNormal = new THREE.Vector3()
          .copy(camera.position)
          .sub(group.current.position)
          .normalize();
        
        // Calculate target normal based on orientation with smooth transition
        const palmNormal = planeNormal.clone().negate();
        const backNormal = planeNormal.clone();
        
        // Blend between orientations based on transition state
        const targetNormal = new THREE.Vector3().lerpVectors(
          palmNormal, 
          backNormal, 
          orientationTransition.current
        ).normalize();
        
        // Smooth the normal change to prevent visual popping
        const normalSmoothAlpha = 1 - Math.exp(-10 * delta);
        prevClipNormal.current.lerp(targetNormal, normalSmoothAlpha).normalize();
        
        clipPlane.current.setFromNormalAndCoplanarPoint(
          prevClipNormal.current,
          group.current.position
        );  
        // Apply plane to all materials; side determines which half is kept
        for (const mat of ringMaterials.current) {
          // Augment only if material has standard material properties
            const std = mat as THREE.MeshStandardMaterial;
            (std as unknown as { clippingPlanes?: THREE.Plane[] }).clippingPlanes = [clipPlane.current];
            (std as unknown as { clipShadows?: boolean }).clipShadows = true;
        }
      }
      
    } else if (group.current) {
      anchorInitialized.current = false;
      smoothedFingerDiameterNorm.current = null;
      smoothedDistance.current = BASE_DISTANCE;
      rawAnchorInitialized.current = false;
      filteredAnchorInitialized.current = false;
      microAnchorInitialized.current = false;
      smoothedHandClosure.current = 0;
      orientationTransition.current = 0;
      smoothedOrientation.current = null;
      prevRotation.current = { x: 0, y: 0, z: 0 };
      rotationYOffsetInitialized.current = false;
      smoothedRotationYOffset.current = positionOffsetY;
      group.current.scale.setScalar(targetScale.current);
      // Idle rotation when no hand
      group.current.rotation.x += delta * 0.8;
      group.current.rotation.y += delta * 0.6;
      if (userRotationGroup.current) {
        userRotationGroup.current.position.y = positionOffsetY;
        userRotationGroup.current.position.z = positionOffsetZ;
      }
    }
  });
  return (
    <group ref={group}>
      <group ref={userRotationGroup}>
        <primitive object={scene} />
      </group>
    </group>
  );
}

useGLTF.preload(ringUrl);
useGLTF.preload(classicRingUrl);
