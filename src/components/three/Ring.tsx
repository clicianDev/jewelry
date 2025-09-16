import * as THREE from "three";
import { useEffect, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useHandStore } from "@/store/hands";

import ringUrl from "@/assets/diamond_ring.glb";

export default function Ring() {
  const group = useRef<THREE.Group>(null!);
  const { scene } = useGLTF(ringUrl);
  const userRotationGroup = useRef<THREE.Group>(null!);
  const landmarks = useHandStore((state) => state.landmarks);
  const { camera, size } = useThree();

  // Helper vector objects to avoid allocations
  const ndc = useRef(new THREE.Vector3());
  const dir = useRef(new THREE.Vector3());
  const pos = useRef(new THREE.Vector3());
  const baseDiameter = useRef<number | null>(null);
  const targetScale = useRef(1);
  const viewAxisAngle = useRef(0); // smoothed rotation around camera view axis
  const smoothedFingerDiameterNorm = useRef<number | null>(null); // smoothed normalized (0..1) finger diameter on screen

  // Tuning
  // ---------------- Scaling Tuning ----------------
  const BASE_DISTANCE = 30; // baseline world depth to place the ring (arbitrary scene units)
  const SCALE_DAMP = 14; // scale damping
  const WIDTH_DAMP = 22; // damping for raw finger diameter measurement
  const SCALE_MIN = 0.05; // allow a little smaller now
  const SCALE_MAX = 3.5;

  // Model calibration: estimate ratio (inner_diameter / measured_box_diameter)
  // If your model's bounding box covers outer metal thickness, inner hole is smaller.
  const MODEL_INNER_DIAMETER_RATIO = 0.78; // tweak if ring looks too big/small

  // Anatomical heuristic: proximal phalanx width ≈ 0.34–0.40 of proximal segment length (13->14)
  const FINGER_DIAMETER_TO_SEGMENT_RATIO = 0.37; // mid value; user variation expected

  // Fit factor > 1 means leave some slack so ring doesn't intersect finger mesh visually.
  const SNUG_FIT = 0.65;

  // Enable shadows and gently tune PBR materials for better metal reflections
  useEffect(() => {
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
  }, [scene]);

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
  }, [scene]);

  useFrame((_, delta) => {
    const lms = landmarks;
    if (lms && lms.length >= 21 && group.current) {
      // Midpoint between ring finger MCP (13) and PIP (14)
      const p13 = lms[13];
      const p14 = lms[14];
      const midX = (p13.x + p14.x) / 2;
      const midY = (p13.y + p14.y) / 2;
      const mirroredX = 1 - midX; // account for mirrored video
      ndc.current.set(mirroredX * 2 - 1, -(midY * 2 - 1), 0.5);
      // Unproject from NDC to world: create a ray from camera through ndc
      ndc.current.unproject(camera);
      dir.current.copy(ndc.current).sub(camera.position).normalize();
      // Place the ring at a fixed distance in front of camera along ray
      const distance = BASE_DISTANCE; // base depth in world units
      pos.current
        .copy(camera.position)
        .add(dir.current.multiplyScalar(distance));
      // Smoothly move to target position to reduce jitter
      // Instant positional update (no noticeable follow delay)
      group.current.position.copy(pos.current);

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
        const fitScale = THREE.MathUtils.clamp(
          fitScaleRaw,
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
      const angleAlpha = Math.min(1, delta * 10);
      viewAxisAngle.current = curr + diff * angleAlpha;
      group.current.rotation.z = viewAxisAngle.current;
      // Apply user base rotation offsets to child
      if (userRotationGroup.current) {
        // Fixed initial pitch (X) rotation ~1.60 radians, yaw/roll zero
        userRotationGroup.current.rotation.set(1.6, 0, 0);
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
