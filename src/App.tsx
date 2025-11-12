import { useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Environment, Loader, Preload, Stats } from "@react-three/drei";
import { Suspense } from "react";
import * as THREE from "three";
import Postprocessing from "@/components/three/Postprocessing";
import HandTracker from "@/components/mediapipe/HandTracker";
import { useHandStore } from "@/store/hands";
import RingPresence from "@/components/three/RingPresense";
import RingMenu, { type RingOption } from "@/components/ui/RingMenu";
import classicRingUrl from "@/assets/ring.glb";
import diamondRingUrl from "@/assets/diamond_ring.glb";
import diamondRingImg from "@/assets/images/diamond_ring.png";
import classicRingImg from "@/assets/images/ring.png";
import "./App.css";

export default function App() {
  const landmarks = useHandStore((state) => state.landmarks);
  const videoEl = useHandStore((state) => state.videoEl);
  const showRing = !!(landmarks?.length && videoEl);
  const ringOptions = useMemo<RingOption[]>(
    () => [
      {
        id: "diamond",
        name: "Diamond Solitaire",
        description: "Brilliant-cut centre stone with tapered band",
        assetUrl: diamondRingUrl,
        accentColor: "#60a5fa",
        thumbnail: diamondRingImg,
      },
      {
        id: "classic",
        name: "Classic Gold Band",
        description: "Minimal rounded profile for everyday wear",
        assetUrl: classicRingUrl,
        accentColor: "#fbbf24",
        thumbnail: classicRingImg,
      },
    ],
    []
  );
  const [selectedRingId, setSelectedRingId] = useState<string>(ringOptions[0].id);

  const activeRing = useMemo(
    () => ringOptions.find((option) => option.id === selectedRingId) ?? ringOptions[0],
    [ringOptions, selectedRingId]
  );

  return (
    <div className="app-shell">
      <section className="scene-panel" aria-label="Virtual ring preview">
        <div className="scene-panel__frame">
          <div className="scene-panel__canvas">
            <HandTracker />
            <Canvas
              dpr={[1, 2]}
              shadows={{ type: THREE.PCFSoftShadowMap }}
              gl={{ antialias: true, preserveDrawingBuffer: true }}
              camera={{ position: [129, 82.1, 129], fov: 45 }}
            >
              <Suspense fallback={null}>
                {/* Use Video as Environment (uncomment to enable) */}
                {/* <VideoEnvironment /> */}

                {/* Environment for realistic reflections */}
                <Environment preset="city" resolution={1080} />
                <Postprocessing />
                {/* Wrap ring for smooth transitions */}
                <RingPresence show={showRing} assetUrl={activeRing.assetUrl} />
                {/* Preload all assets referenced in the scene */}
                <Preload all />
              </Suspense>
              {/* Camera controls tuned for product viewing */}
              {/* <OrbitControls maxDistance={200} minDistance={50} /> */}
              {/* R3F default stats panel(FPS) */}
              <Stats />
            </Canvas>
          </div>
        </div>
        {/* Basic loading overlay with progress bar */}
        <Loader />
      </section>
      <RingMenu
        options={ringOptions}
        selectedId={selectedRingId}
        onSelect={setSelectedRingId}
      />
    </div>
  );         
}

