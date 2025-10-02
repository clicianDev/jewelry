import * as THREE from "three";
import { useEffect, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useControls } from "leva";
import { useFrame, useThree } from "@react-three/fiber";
import { useHandStore } from "@/store/hands";

import ringUrl from "@/assets/diamond_ring.glb";

export default function Ring() {
  const group = useRef<THREE.Group>(null!);
  const { scene } = useGLTF(ringUrl);
  const userRotationGroup = useRef<THREE.Group>(null!);
  const landmarks = useHandStore((state) => state.landmarks);
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

  // Tuning
  // ---------------- Scaling Tuning ----------------
  // Depth & smoothing tuning (reduced delay):
  const BASE_DISTANCE = 30; // baseline world depth to place the ring (arbitrary scene units)
  const SCALE_DAMP = 30; // higher => reacts faster (was 14)
  const WIDTH_DAMP = 45; // higher => reacts faster (was 22)
  const POSITION_DAMP = 55; // new: smoothing for position (higher = snappy)
  const SCALE_MIN = 0.05; // allow a little smaller now
  const SCALE_MAX = 3.5;

  // Model calibration: estimate ratio (inner_diameter / measured_box_diameter)
  // If your model's bounding box covers outer metal thickness, inner hole is smaller.
  const MODEL_INNER_DIAMETER_RATIO = 0.78; // tweak if ring looks too big/small

  // Anatomical heuristic: proximal phalanx width ≈ 0.34–0.40 of proximal segment length (13->14)
  const FINGER_DIAMETER_TO_SEGMENT_RATIO = 0.40; // slightly larger to better approximate real finger thickness

  // Fit factor > 1 means leave some slack so ring doesn't intersect finger mesh visually.
  const SNUG_FIT = 0.72; // slightly looser so model doesn't appear too small

  // Exposed user tuning controls (via Leva) to fine tune size & anchor without code edits.
  // fitAdjust: global scale multiplier. anchorToward14: 0 keeps original bias (toward 13), 1 moves fully to joint 14.
  // alongFinger: pushes further along the 13->14 segment (positive toward 14, negative back toward 13).
  const { fitAdjust, anchorToward14, alongFinger, positionSmoothing } = useControls('Ring Fit', {
    fitAdjust: { value: 1.10, min: 0.5, max: 1.6, step: 0.01 },
    anchorToward14: { value: 0.30, min: 0, max: 1, step: 0.01 },
    alongFinger: { value: 0.05, min: -0.3, max: 0.6, step: 0.005 },
    positionSmoothing: { value: 0, min: 0, max: 1, step: 0.05 },
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
  const lms = landmarks;
    if (lms && lms.length >= 21 && group.current) {
  // Weighted midpoint between ring finger MCP (13) and PIP (14) with bias toward 13 (base of finger)
  const p13 = lms[13]; // ring finger MCP
  const p14 = lms[14]; // ring finger PIP
  // Interpolate bias toward joint 14: anchorToward14=0 keeps default, =1 means fully at 14
  const bias13 = THREE.MathUtils.lerp(DEFAULT_BIAS_TOWARD_13, 0, anchorToward14);
  const bias14 = 1 - bias13;
  let midX = p13.x * bias13 + p14.x * bias14;
  let midY = p13.y * bias13 + p14.y * bias14;
  if (alongFinger !== 0) {
    const segX = p14.x - p13.x;
    const segY = p14.y - p13.y;
    midX += segX * alongFinger;
    midY += segY * alongFinger;
  }
  const mirroredX = 1 - midX; // account for mirrored video
  ndc.current.set(mirroredX * 2 - 1, -(midY * 2 - 1), 0.5);
      // Unproject from NDC to world: create a ray from camera through ndc
      ndc.current.unproject(camera);
      dir.current.copy(ndc.current).sub(camera.position).normalize();
      // Place the ring at a fixed distance in front of camera along ray
      const distance = BASE_DISTANCE; // base depth in world units
      pos.current.copy(camera.position).add(dir.current.multiplyScalar(distance));

      const SMOOTH_EPS = 1e-3;
      const smoothing = positionSmoothing ?? 0;
      if (smoothing <= SMOOTH_EPS) {
        smoothedPosition.current.copy(pos.current);
      } else {
        const posAlpha = 1 - Math.exp(-POSITION_DAMP * smoothing * delta);
        if (smoothedPosition.current.lengthSq() === 0) {
          smoothedPosition.current.copy(pos.current);
        } else {
          smoothedPosition.current.lerp(pos.current, posAlpha);
        }
      }
      group.current.position.copy(smoothedPosition.current);

      // --- Finger Diameter Estimation (Normalized Screen Space) ---
      // Use length of proximal segment (13 -> 14) as a stable axis-aligned measure; multiply by anatomical ratio
      const dxSeg = p13.x - p14.x;
      const dySeg = p13.y - p14.y;
      const segmentLenNorm = Math.sqrt(dxSeg * dxSeg + dySeg * dySeg); // proximal phalanx length (normalized)
      const rawDiameterNorm = segmentLenNorm * FINGER_DIAMETER_TO_SEGMENT_RATIO;
      // Smooth the (often noisy) per-frame diameter estimate
      const widthAlpha = 1 - Math.exp(-WIDTH_DAMP * delta);
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
      const viewWidthAtZ = 2 * distance * Math.tan(fovRad / 2) * aspect; // world units across NDC -1..1
      const desiredWorldDiameter = diameterNorm * viewWidthAtZ; // diameter fraction of full width

      if (baseDiameter.current) {
        // Calibrate to inner diameter of the ring (not bounding box outer diameter)
        const modelInnerDiameter =
          baseDiameter.current * MODEL_INNER_DIAMETER_RATIO;
        // We want: scaled_model_inner_diameter ≈ desiredWorldDiameter * SNUG_FIT
        // => scale = (desiredWorldDiameter * SNUG_FIT) / modelInnerDiameter
        const fitScaleRaw =
          (desiredWorldDiameter * SNUG_FIT) / modelInnerDiameter;
        // Apply user adjustment multiplier before clamping.
        const fitScale = THREE.MathUtils.clamp(
          fitScaleRaw * fitAdjust,
          SCALE_MIN,
          SCALE_MAX
        );
        // Smooth scaling to reduce jitter
        const scaleAlpha = Math.min(1, delta * SCALE_DAMP);
        targetScale.current = THREE.MathUtils.lerp(
          targetScale.current,
          fitScale,
          scaleAlpha
        );
        group.current.scale.setScalar(targetScale.current);
      }
      // Face camera and orient perpendicular to 13->14 segment in screen space
      group.current.lookAt(camera.position);
      const x13s = 1 - p13.x; // mirrored
      const y13s = p13.y;
      const x14s = 1 - p14.x;
      const y14s = p14.y;
      const segAngle = Math.atan2(y14s - y13s, x14s - x13s);
      const targetAngle = -segAngle + 0.5;
      const curr = viewAxisAngle.current;
      const diff = ((targetAngle - curr + Math.PI) % (2 * Math.PI)) - Math.PI; // shortest path
      const angleAlpha = Math.min(1, delta * 22); // faster orientation catch-up
      viewAxisAngle.current = curr + diff * angleAlpha;
      group.current.rotation.z = viewAxisAngle.current;
      // Apply user base rotation offsets to child, plus palmScore-driven tilt on X
      if (userRotationGroup.current) {
        // Map palmScore [-1..1] to an additive tilt range in radians
      const TILT_MAX_RAD = THREE.MathUtils.degToRad(35);
      // Use palmScore when confident; otherwise fallback to orientation so tilt is always visible
      const EPS = 0.12; // confidence threshold
      const hasScore = palmScore != null && Math.abs(palmScore) > EPS;
      const score = hasScore ? (palmScore as number) : (orientation === 'palm' ? 1 : orientation === 'back' ? -1 : 0);
      const sign = handedness?.toLowerCase() === 'left' ? -1 : 1;
      const targetTilt = score * TILT_MAX_RAD * sign;
        // Smoothly approach target tilt
        const tiltAlpha = 1 - Math.exp(-20 * delta); // damping
        if(orientation == 'back'){
        tiltX.current = THREE.MathUtils.lerp(tiltX.current, targetTilt, tiltAlpha);
        const rx = THREE.MathUtils.degToRad(handedness?.toLowerCase() === 'left' ? -65.0 : -128.0) + (tiltX.current * 10);
        const ry = THREE.MathUtils.degToRad(0);
        const rz = THREE.MathUtils.degToRad(0);
        userRotationGroup.current.rotation.set(rx, ry, rz);
        } else {
          // Set a default tilt when showing palm (for now, hardcoded)
        userRotationGroup.current.rotation.set(1, 0, 0);
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
      // Idle rotation when no hand
      group.current.rotation.x += delta * 0.8;
      group.current.rotation.y += delta * 0.6;
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
