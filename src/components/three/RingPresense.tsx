import { useFrame } from "@react-three/fiber";
import { useRef, useState, useEffect } from "react";
import * as THREE from "three";
import Ring from "@/components/three/Ring";

export default function RingPresence({ show, assetUrl }: { show: boolean; assetUrl?: string }) {
    const group = useRef<THREE.Group>(null);
    const [mounted, setMounted] = useState(false);
    const MIN_SCALE = 0.0001;

    // Mount when show becomes true
    useEffect(() => {
        if (show) setMounted(true);
    }, [show]);

    useFrame((_, delta) => {
        if (!group.current) return;
        const target = show ? 1 : MIN_SCALE;
        const current = group.current.scale.x;
        const next = THREE.MathUtils.lerp(current, target, 1 - Math.pow(0.0001, delta)); // frame-rate independent
        group.current.scale.setScalar(next);

        // Fade materials (opacity follows normalized scale)
        const t = THREE.MathUtils.clamp((next - MIN_SCALE) / (1 - MIN_SCALE), 0, 1);
        group.current.traverse((obj) => {
            if ((obj as THREE.Mesh).isMesh) {
                const mesh = obj as THREE.Mesh;
                const mat = mesh.material as THREE.Material | THREE.Material[];
                if (Array.isArray(mat)) {
                    mat.forEach((m) => {
                        if ("opacity" in m) {
                            if (!m.transparent) m.transparent = true;
                            m.opacity = t;
                            m.depthWrite = t > 0.01;
                        }
                    });
                } else if (mat && "opacity" in mat) {
                    if (!mat.transparent) mat.transparent = true;
                    mat.opacity = t;
                    mat.depthWrite = t > 0.01;
                }
            }
        });

        // After shrinking, unmount
        if(!show && next <= MIN_SCALE * 1.5){
            setMounted(false);
        }
    });

    if (!mounted) return null;
    return (
        <group ref={group} scale={show ? 0.8 : MIN_SCALE}>
            <Ring modelUrl={assetUrl} />
        </group>
    );
}