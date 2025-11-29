import { useMemo, useState, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { Environment, Loader, Preload, Stats } from "@react-three/drei";
import { Suspense } from "react";
import * as THREE from "three";
import Postprocessing from "@/components/three/Postprocessing";
import HandTracker from "@/components/mediapipe/HandTracker";
import { useHandStore } from "@/store/hands";
import RingPresence from "@/components/three/RingPresense";
import RingMenu, { type RingOption } from "@/components/ui/RingMenu";
import InstructionsModal from "@/components/ui/InstructionsModal";
import CaptureButton from "@/components/ui/CaptureButton";
import classicRingUrl from "@/assets/ring.glb";
import diamondRingUrl from "@/assets/diamond_ring.glb";
import diamondRingImg from "@/assets/images/diamond_ring.png";
import classicRingImg from "@/assets/images/ring.png";
import "./App.css";

export default function App() {
  const [showModal, setShowModal] = useState(false);
  const [trackingStarted, setTrackingStarted] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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

  const handleCapture = () => {
    if (!canvasRef.current || !videoEl) return;
    
    try {
      // Create a temporary canvas to composite video + 3D ring
      const compositeCanvas = document.createElement('canvas');
      const ctx = compositeCanvas.getContext('2d');
      if (!ctx) return;
      
      // Set canvas size to match the scene canvas
      const sceneCanvas = canvasRef.current;
      compositeCanvas.width = sceneCanvas.width;
      compositeCanvas.height = sceneCanvas.height;
      
      // Calculate video scaling to maintain aspect ratio (cover mode)
      const videoAspect = videoEl.videoWidth / videoEl.videoHeight;
      const canvasAspect = compositeCanvas.width / compositeCanvas.height;
      
      let drawWidth, drawHeight, drawX, drawY;
      
      if (videoAspect > canvasAspect) {
        // Video is wider - fit height and crop sides
        drawHeight = compositeCanvas.height;
        drawWidth = drawHeight * videoAspect;
        drawX = (compositeCanvas.width - drawWidth) / 2;
        drawY = 0;
      } else {
        // Video is taller - fit width and crop top/bottom
        drawWidth = compositeCanvas.width;
        drawHeight = drawWidth / videoAspect;
        drawX = 0;
        drawY = (compositeCanvas.height - drawHeight) / 2;
      }
      
      // Draw video frame first (background) - mirrored horizontally like the live view
      ctx.save();
      ctx.scale(-1, 1);
      ctx.translate(-compositeCanvas.width, 0);
      ctx.drawImage(videoEl, drawX, drawY, drawWidth, drawHeight);
      ctx.restore();
      
      // Draw 3D ring canvas on top (foreground)
      ctx.drawImage(sceneCanvas, 0, 0);
      
      // Convert composite canvas to blob and download
      compositeCanvas.toBlob((blob) => {
        if (!blob) return;
        
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        link.download = `ring-fitment-${timestamp}.png`;
        link.href = url;
        link.click();
        
        // Clean up
        setTimeout(() => URL.revokeObjectURL(url), 100);
      }, 'image/png');
    } catch (error) {
      console.error('Failed to capture screenshot:', error);
    }
  };

  return (
    <div className="app-shell">
      <section className="scene-panel" aria-label="Virtual ring preview">
        <div className="scene-panel__frame">
          {!trackingStarted ? (
            <div className="try-on-overlay">
              <button 
                className="try-on-button" 
                onClick={() => setShowModal(true)}
              >
                Try On
              </button>
            </div>
          ) : (
            <div className="scene-panel__canvas">
              <HandTracker />
              <Canvas
                ref={canvasRef}
                dpr={[1, 2]}
                shadows={{ type: THREE.PCFSoftShadowMap }}
                gl={{ antialias: true, preserveDrawingBuffer: true }}
                camera={{ position: [129, 82.1, 129], fov: 45 }}
              >
                <Suspense fallback={null}>
                  {/* Use Video as Environment (uncomment to enable) */}
                  {/* <VideoEnvironment /> */}

                  {/* Environment for realistic reflections */}
                  <Environment files="/studio_small_08_1k.hdr" resolution={1080} />
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
          )}
        </div>
        {/* Basic loading overlay with progress bar */}
        <Loader />
        
        {/* Capture Button - only show when tracking is active and ring is visible */}
        {trackingStarted && showRing && (
          <CaptureButton onCapture={handleCapture} />
        )}
      </section>
      
      {/* Instructions Modal */}
      <InstructionsModal 
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        onReady={() => setTrackingStarted(true)}
      />
      
      <RingMenu
        options={ringOptions}
        selectedId={selectedRingId}
        onSelect={setSelectedRingId}
      />
    </div>
  );         
}

