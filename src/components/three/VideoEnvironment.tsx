import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useHandStore } from "@/store/hands";

// Uses webcam video as scene background and environment map for reflections
export default function VideoEnvironment() {
  const { scene, gl } = useThree();
  const videoEl = useHandStore((s) => s.videoEl);
  const videoTex = useRef<THREE.VideoTexture | null>(null);
  const cubeRTRef = useRef<THREE.WebGLCubeRenderTarget | null>(null);
  const frameCount = useRef(0);
  

  // When video is available, create/update the video texture and set as background
  useEffect(() => {
    if (!videoEl) return;
    const tex = new THREE.VideoTexture(videoEl);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    // Treat as equirect-like; we'll PMREM it for PBR reflections
    tex.mapping = THREE.EquirectangularReflectionMapping;
    videoTex.current = tex;
    // Show the live video as background
    scene.background = tex;

    // Build env from equirectangular video by converting to a cubemap
    const ensureCube = () => {
      if (!cubeRTRef.current) {
        cubeRTRef.current = new THREE.WebGLCubeRenderTarget(256);
      }
      return cubeRTRef.current;
    };

    const updateEnv = () => {
      const w = videoEl.videoWidth || 0;
      const h = videoEl.videoHeight || 0;
      if (w < 16 || h < 16) return false;
      const crt = ensureCube();
      try {
        crt.fromEquirectangularTexture(gl, tex);
        scene.environment = crt.texture;
        return true;
      } catch (e) {
        // Fallback: clear env to avoid shader errors
        console.warn("Cube conversion failed; clearing scene.environment.", e);
        if (scene.environment) scene.environment = null;
        return false;
      }
    };

    // Try initial update and also on video events
    updateEnv();
    const onMeta = () => updateEnv();
    const onPlay = () => updateEnv();
    videoEl.addEventListener("loadedmetadata", onMeta);
    videoEl.addEventListener("playing", onPlay);
    return () => {
      videoEl.removeEventListener("loadedmetadata", onMeta);
      videoEl.removeEventListener("playing", onPlay);
      if (scene.background === tex) scene.background = null;
      if (cubeRTRef.current && scene.environment === cubeRTRef.current.texture) scene.environment = null;
      if (cubeRTRef.current) {
        cubeRTRef.current.dispose();
        cubeRTRef.current = null;
      }
      tex.dispose();
      videoTex.current = null;
    };
  }, [videoEl, scene, gl]);

  // Refresh env map periodically so reflections track the video without heavy per-frame cost
  useFrame(() => {
    if (!videoTex.current || !cubeRTRef.current) return;
    frameCount.current = (frameCount.current + 1) % 10; // ~6x/sec at 60fps
    if (frameCount.current !== 0) return;
    const tex = videoTex.current;
    try {
      cubeRTRef.current.fromEquirectangularTexture(gl, tex);
      scene.environment = cubeRTRef.current.texture;
    } catch {
      // Ignore transient failures
    }
  });

  return null;
}
