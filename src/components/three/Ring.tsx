import * as THREE from "three";
import { useEffect, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useHandStore } from "@/store/hands";

import ringUrl from "@/assets/ring.glb";

export default function Ring() {
  const group = useRef<THREE.Group>(null!);
  const { scene } = useGLTF(ringUrl);
  const landmarks = useHandStore((state) => state.landmarks);
  const { camera, size } = useThree();

  // Helper vector objects to avoid allocations
  const ndc = useRef(new THREE.Vector3());
  const dir = useRef(new THREE.Vector3());
  const pos = useRef(new THREE.Vector3());
  const baseDiameter = useRef<number | null>(null);
  const targetScale = useRef(1);

  // Tuning
  const BASE_DISTANCE = 50; // Meters in front of the camera
  const POS_DAMP = 12;
  const SCALE_DAMP = 12;
  const SCALE_MIN = 0.1;
  const SCALE_MAX = 3.0;

  const SNUG = 0.2; // How tightly the ring fits around the finger (in meters)

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
      // Use ring finger pip (index 14). MediaPipe normalized coords: x in [0,1] left->right, y in [0,1] top->bottom
      const tip = lms[14];
      // Convert to NDC (-1..1). Our video is mirrored, so flip X.
      const mirroredX = 1 - tip.x;
      ndc.current.set(mirroredX * 2 - 1, -(tip.y * 2 - 1), 0.5);
      // Unproject from NDC to world: create a ray from camera through ndc
      ndc.current.unproject(camera);
      dir.current.copy(ndc.current).sub(camera.position).normalize();
      // Place the ring at a fixed distance in front of camera along ray
      const distance = BASE_DISTANCE; // base depth in world units
      pos.current
        .copy(camera.position)
        .add(dir.current.multiplyScalar(distance));
      // Smoothly move to target position to reduce jitter
      const posAlpha = 1 - Math.exp(-POS_DAMP * delta);
      group.current.position.lerp(pos.current, posAlpha);

      // Estimate finger width on screen (normalized units) using landmarks 13 and 15 around PIP
      const a = lms[13];
      const b = lms[15];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const widthNorm = Math.sqrt(dx * dx + dy * dy); // ~finger diameter in normalized image space

      // Convert normalized width on screen to desired world diameter at this depth
      const aspect = size.width / size.height;
      const fovRad = THREE.MathUtils.degToRad(
        (camera as THREE.PerspectiveCamera).fov
      );
      const viewWidthAtZ = 2 * distance * Math.tan(fovRad / 2) * aspect; // world units across NDC -1..1
      const desiredWorldDiameter = widthNorm * viewWidthAtZ; // widthNorm fraction of the view width

      if (baseDiameter.current) {
        // Compute target uniform scale so model outer diameter matches desired diameter
        const fitScaleRaw =
          (desiredWorldDiameter / baseDiameter.current) * SNUG;
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
      // Face camera a bit and add subtle rotation
      group.current.lookAt(camera.position);
      group.current.rotateX(delta * 0.5);
      group.current.rotateY(delta * 0.3);
    } else if (group.current) {
      // Idle rotation when no hand
      group.current.rotation.x += delta * 0.8;
      group.current.rotation.y += delta * 0.6;
    }
  });
  return (
    <group ref={group}>
      <primitive object={scene} />
    </group>
  );
}

useGLTF.preload(ringUrl);
