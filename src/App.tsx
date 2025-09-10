import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, Loader, Preload, Stats } from "@react-three/drei";
import { Suspense } from "react";
import * as THREE from "three";
import Postprocessing from "@/components/three/Postprocessing";
import HandTracker from "@/components/mediapipe/HandTracker";
import { useHandStore } from "@/store/hands";
import RingPresence from "@/components/three/RingPresense";


export default function App() {
  const landmarks = useHandStore((state) => state.landmarks);
  const videoEl = useHandStore((state) => state.videoEl);
  const showRing = !!(landmarks?.length && videoEl);

  return (
    <div style={{ position: "fixed", inset: 0, background: "linear-gradient(135deg, #111214 0%, #080809 55%, #050506 100%)" }}>
      <HandTracker/>
      <Canvas
        dpr={[1, 2]}
        shadows={{ type: THREE.PCFSoftShadowMap }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        camera={{ position: [129, 82.1, 129], fov: 45}}
      >
        <Suspense fallback={null}>
          {/* Environment for realistic reflections */}
          <Environment preset="city" resolution={1080} />
          <Postprocessing />
          {/* Wrap ring for smooth transitions */}
          <RingPresence show={showRing} />
          {/* Preload all assets referenced in the scene */}
          <Preload all />
        </Suspense>
        {/* Camera controls tuned for product viewing */}
        <OrbitControls maxDistance={200} minDistance={50} />
        {/* R3F default stats panel(FPS) */}
        <Stats/>
      </Canvas>
      {/* Basic loading overlay with progress bar */}
      <Loader />
    </div>
  );         
}

