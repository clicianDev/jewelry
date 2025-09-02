import * as THREE from "three";
import {  useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";

import ringUrl from "@/assets/ring.glb";

export default function Ring() {
  const group = useRef<THREE.Group>(null!);
  const { scene } = useGLTF(ringUrl);
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
