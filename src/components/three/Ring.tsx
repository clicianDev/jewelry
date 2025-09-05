import * as THREE from "three";
import { useEffect, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";

import ringUrl from "@/assets/ring.glb";

export default function Ring() {
  const group = useRef<THREE.Group>(null!);
  const { scene } = useGLTF(ringUrl);
  
  // Enable shadows and gently tune PBR materials for better metal reflections
  useEffect(() => {
    scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        const material = mesh.material as THREE.Material | THREE.Material[];
        const mats = (Array.isArray(material) ? material : [material]) as THREE.Material[];
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

  // Slow, continuous rotation for a dynamic view (Temporary, for presentation purposes)
  useFrame((_, delta) => {
    if (group.current) {
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
