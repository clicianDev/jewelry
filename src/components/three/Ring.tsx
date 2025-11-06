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

const DEFAULT_MODEL_INNER_DIAMETER_RATIO = 0.78; // baseline calibration for solitaire ring model
const MODEL_INNER_DIAMETER_RATIO_MAP: Record<string, number> = {
  [ringUrl]: 0.78,
  [classicRingUrl]: 0.92,
};

function distance3(a: Vec3Like, b: Vec3Like) {
  return Math.sqrt(
    (a.x - b.x) * (a.x - b.x) +
      (a.y - b.y) * (a.y - b.y) +
      (a.z - b.z) * (a.z - b.z)
  );
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
  const prevRawAnchorNorm = useRef({ x: 0, y: 0 });
  const prevFilteredAnchorNorm = useRef({ x: 0, y: 0 });
  const rawAnchorInitialized = useRef(false);
  const filteredAnchorInitialized = useRef(false);
  const microAnchorNorm = useRef(new THREE.Vector2());
  const microAnchorInitialized = useRef(false);
  const smoothedHandClosure = useRef(0);

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
  // fitAdjust: global scale multiplier. anchorToward14: 0 keeps original bias (toward 13), 1 moves fully to joint 14.
  // alongFinger: pushes further along the 13->14 segment (positive toward 14, negative back toward 13).
  const { fitAdjust, anchorToward14, alongFinger, positionSmoothing, motionLookaheadMs, jitterBlend, jitterVelocityCutoff, jitterDeadzone } = useControls('Ring Fit', {
    fitAdjust: { value: 1.30, min: 0.5, max: 1.6, step: 0.01 },
    anchorToward14: { value: 0.30, min: 0, max: 1, step: 0.01 },
    alongFinger: { value: 0.05, min: -0.3, max: 0.6, step: 0.005 },
    positionSmoothing: { label: "Smoothing Amount", value: 0, min: 0, max: 1, step: 0.05 },
    motionLookaheadMs: { label: "Lookahead (ms)", value: 16, min: 0, max: 150, step: 1 }, // Increased default for better prediction
    jitterBlend: { label: "Stabilized Blend", value: 0.15, min: 0, max: 1, step: 0.05 }, // Reduced for more raw data
    jitterVelocityCutoff: { label: "Blend Cutoff", value: 0.01, min: 0.001, max: 0.1, step: 0.001 }, // Lower for faster blend-out
    jitterDeadzone: { label: "Jitter Deadzone", value: 0.0008, min: 0, max: 0.015, step: 0.0001 }, // Smaller for more responsiveness
  });
  const { rotationOffsetX, rotationOffsetY, rotationOffsetZ, closureOffsetZ, positionOffsetZ, closureOffsetPositionZ } = useControls('Ring Orientation', {
    rotationOffsetX: { label: "Offset X (°)", value: 0, min: -180, max: 180, step: 0.5 },
    rotationOffsetY: { label: "Offset Y (°)", value: 0, min: -180, max: 180, step: 0.5 },
    rotationOffsetZ: { label: "Offset Z (°)", value: 0, min: -180, max: 180, step: 0.5 },
    closureOffsetZ: { label: "Close Adjust Z (°)", value: 80, min: 0, max: 90, step: 0.5 },
    positionOffsetZ: { label: "Base Pos Z", value: -5.4, min: -20, max: 20, step: 0.05 },
    closureOffsetPositionZ: { label: "Close Adjust Pos", value: 1.5, min: 0, max: 10, step: 0.05 },
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
      const SMOOTH_EPS = 1e-3;
      const computeAlpha = (
        response: number,
        baseStrength = 0,
        attenuation = 1
      ) => {
        const sliderStrength = THREE.MathUtils.clamp(smoothingStrength ?? 0, 0, 1);
        const combinedStrength = Math.max(baseStrength, sliderStrength);
        
        // For instant response, bypass smoothing when strength is low
        if (combinedStrength <= SMOOTH_EPS) {
          return 1; // Instant update
        }

        const clampedStrength = THREE.MathUtils.clamp(combinedStrength, SMOOTH_EPS, 1);
        const baseAlpha = 1 - Math.exp(-response * clampedStrength * delta);

        const attenuationBoost = THREE.MathUtils.clamp(1 - attenuation, 0, 1);
        if (attenuationBoost <= SMOOTH_EPS) {
          return baseAlpha;
        }

        // Blend towards instant response when motion detected
        return THREE.MathUtils.lerp(baseAlpha, 1, attenuationBoost * 0.8); // More aggressive blend to instant
      };
  const nowTs = typeof performance !== "undefined" ? performance.now() : Date.now();
  const dataAgeMs = landmarksTimestamp != null ? Math.max(0, nowTs - landmarksTimestamp) : 0;
      const lookaheadMs = Math.max(0, motionLookaheadMs ?? 0) + dataAgeMs;
      const lookaheadSeconds = Math.min(0.25, lookaheadMs / 1000);

      // Weighted midpoint between ring finger MCP (13) and PIP (14) with bias toward 13 (base of finger)
      const bias13 = THREE.MathUtils.lerp(DEFAULT_BIAS_TOWARD_13, 0, anchorToward14);
      const bias14 = 1 - bias13;
      let rawAnchorX = p13.x * bias13 + p14.x * bias14;
      let rawAnchorY = p13.y * bias13 + p14.y * bias14;
      if (alongFinger !== 0) {
        const segX = p14.x - p13.x;
        const segY = p14.y - p13.y;
        rawAnchorX += segX * alongFinger;
        rawAnchorY += segY * alongFinger;
      }

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
      prevRawAnchorNorm.current.x = rawAnchorX;
      prevRawAnchorNorm.current.y = rawAnchorY;

      if (rawDelta > 0) {
        const motionFactorNorm = THREE.MathUtils.clamp(
          rawDelta / MOTION_ATTENUATION_THRESHOLD,
          0,
          1
        );
        const motionIntensity = Math.pow(motionFactorNorm, 0.9);
        smoothingAttenuation = Math.max(
          MOTION_ATTENUATION_MIN,
          1 - motionIntensity * MOTION_ATTENUATION_POWER
        );
      }

      let anchorX = rawAnchorX;
      let anchorY = rawAnchorY;

      if (jitterBlend > 0 && landmarksStabilized && landmarksStabilized.length >= 21) {
        const s13 = landmarksStabilized[13];
        const s14 = landmarksStabilized[14];
        if (s13 && s14) {
          let stableX = s13.x * bias13 + s14.x * bias14;
          let stableY = s13.y * bias13 + s14.y * bias14;
          if (alongFinger !== 0) {
            const segXs = s14.x - s13.x;
            const segYs = s14.y - s13.y;
            stableX += segXs * alongFinger;
            stableY += segYs * alongFinger;
          }

          const velocityCut = Math.max(0.0005, jitterVelocityCutoff);
          const velocityRatio = THREE.MathUtils.clamp(rawDelta / velocityCut, 0, 1);
          const blendWeight = jitterBlend * (1 - velocityRatio);
          anchorX = THREE.MathUtils.lerp(anchorX, stableX, blendWeight);
          anchorY = THREE.MathUtils.lerp(anchorY, stableY, blendWeight);
        }
      }

      const deadzone = Math.max(0, jitterDeadzone);
      let filteredX = anchorX;
      let filteredY = anchorY;
      if (!filteredAnchorInitialized.current) {
        filteredAnchorInitialized.current = true;
      } else {
        const deltaX = anchorX - prevFilteredAnchorNorm.current.x;
        const deltaY = anchorY - prevFilteredAnchorNorm.current.y;
        const diff = Math.hypot(deltaX, deltaY);
        if (deadzone > 0) {
          if (diff < deadzone) {
            const softness = THREE.MathUtils.clamp(diff / Math.max(deadzone, 1e-6), 0, 1);
            const eased = softness * softness * (3 - 2 * softness);
            filteredX = prevFilteredAnchorNorm.current.x + deltaX * eased;
            filteredY = prevFilteredAnchorNorm.current.y + deltaY * eased;
          } else if (diff < deadzone * 3) {
            const t = (diff - deadzone) / (deadzone * 2);
            const eased = THREE.MathUtils.clamp(t, 0, 1);
            filteredX = THREE.MathUtils.lerp(prevFilteredAnchorNorm.current.x, anchorX, eased);
            filteredY = THREE.MathUtils.lerp(prevFilteredAnchorNorm.current.y, anchorY, eased);
          }
        }
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

      const mirroredX = 1 - anchorNormX; // account for mirrored video
      ndc.current.set(mirroredX * 2 - 1, -(anchorNormY * 2 - 1), 0.5);
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

  const posAlpha = computeAlpha(POSITION_DAMP, 0.05, smoothingAttenuation); // Much lower base strength (was 0.26)
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
  const widthAlpha = computeAlpha(WIDTH_RESPONSE, 0.05, smoothingAttenuation); // Much lower base strength (was 0.22)
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

      if (baseDiameter.current) {
        const modelInnerDiameter = baseDiameter.current * modelInnerDiameterRatio;
        const fitScaleRaw =
          (desiredWorldDiameter * SNUG_FIT) / modelInnerDiameter;
        const fitScale = THREE.MathUtils.clamp(
          fitScaleRaw * fitAdjust,
          SCALE_MIN,
          SCALE_MAX
        );
  const scaleAlpha = computeAlpha(SCALE_RESPONSE, 0.04, smoothingAttenuation); // Much lower base strength (was 0.24)
        targetScale.current = THREE.MathUtils.lerp(
          targetScale.current,
          fitScale,
          scaleAlpha
        );
        group.current.scale.setScalar(targetScale.current);
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
  const angleAlpha = computeAlpha(ORIENTATION_RESPONSE, 0.03, smoothingAttenuation); // Much lower base strength (was 0.22)
      viewAxisAngle.current = curr + diff * angleAlpha;
      group.current.rotation.z = viewAxisAngle.current;

      if (userRotationGroup.current) {
        const offsetXRad = THREE.MathUtils.degToRad(rotationOffsetX);
        const offsetYRad = THREE.MathUtils.degToRad(rotationOffsetY);
        const offsetZRad = THREE.MathUtils.degToRad(rotationOffsetZ);
        const closureOffsetZRad = THREE.MathUtils.degToRad(closureOffsetZ);
        let closureTotal = 0;
        let closureCount = 0;
        for (const chain of FINGER_CHAINS) {
          const [mcpIdx, pipIdx, dipIdx, tipIdx] = chain;
          const mcp = lms[mcpIdx];
          const pip = lms[pipIdx];
          const dip = lms[dipIdx];
          const tip = lms[tipIdx];
          if (!mcp || !pip || !dip || !tip) continue;
          const fingerLength =
            distance3(mcp, pip) + distance3(pip, dip) + distance3(dip, tip);
          if (fingerLength <= 1e-4) continue;
          const spread = distance3(mcp, tip) / fingerLength;
          const curl = THREE.MathUtils.clamp(1 - spread, 0, 1);
          closureTotal += curl;
          closureCount++;
        }
        const closureRaw = closureCount > 0 ? closureTotal / closureCount : 0;
        const closureAlpha = computeAlpha(CLOSURE_RESPONSE, 0.05, smoothingAttenuation); // Much lower base strength (was 0.18)
        smoothedHandClosure.current = THREE.MathUtils.lerp(
          smoothedHandClosure.current,
          closureRaw,
          closureAlpha
        );
        const closureZ =
          orientation === "back"
            ? closureOffsetZRad * smoothedHandClosure.current
            : 0;
        const basePosZ = positionOffsetZ;
        const closurePosZ =
          orientation === "back"
            ? -closureOffsetPositionZ * smoothedHandClosure.current
            : 0;
        userRotationGroup.current.position.z = basePosZ + closurePosZ;
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
  const tiltAlpha = computeAlpha(TILT_RESPONSE, 0.06, smoothingAttenuation); // Much lower base strength (was 0.2)
        if (orientation === "back") {
          tiltX.current = THREE.MathUtils.lerp(tiltX.current, targetTilt, tiltAlpha);
          const rx =
            THREE.MathUtils.degToRad(
              handedness?.toLowerCase() === "left" ? -65.0 : -128.0
            ) + tiltX.current * 10 + offsetXRad;
          const ry = offsetYRad;
          const rz = offsetZRad - closureZ;
          userRotationGroup.current.rotation.set(rx, ry, rz);
        } else {
          userRotationGroup.current.rotation.set(
            1 + offsetXRad,
            offsetYRad,
            offsetZRad
          );
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
        // If palm is facing camera we invert to hide head instead (so shank shows)
        const finalNormal = orientation === 'palm' ? planeNormal.clone().negate() : planeNormal;
        clipPlane.current.setFromNormalAndCoplanarPoint(
          finalNormal,
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
      // Idle rotation when no hand
      group.current.rotation.x += delta * 0.8;
      group.current.rotation.y += delta * 0.6;
      if (userRotationGroup.current) {
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
