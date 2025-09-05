import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, Loader, Preload } from "@react-three/drei";
import { Suspense } from "react";
import * as THREE from "three";
import Ring from "@/components/three/Ring";
import Postprocessing from "@/components/three/Postprocessing";

export default function App() {
  return (
    <div style={{ height: "100vh", background: "#0c0c0c" }}>
      <Canvas
        dpr={[1, 2]}
        shadows={{ type: THREE.PCFSoftShadowMap }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        camera={{ position: [2.2, 1.4, 2.2], fov: 45}}
      >
        <Suspense fallback={null}>
          {/* Environment for realistic reflections */}
          <Environment preset="city" resolution={1080} />
          <Postprocessing />
          <Ring />
          {/* Preload all assets referenced in the scene */}
          <Preload all />
        </Suspense>
        {/* Camera controls tuned for product viewing */}
        <OrbitControls maxDistance={200} minDistance={50} />
      </Canvas>
      {/* Basic loading overlay with progress bar */}
      <Loader />
    </div>
  );         
}

