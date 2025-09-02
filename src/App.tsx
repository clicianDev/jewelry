import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment } from "@react-three/drei";
import Ring from "./components/Ring";

export default function App() {
  return (
    <div style={{ height: "100vh" }}>
      <Canvas camera={{ position: [5, 5, 5], fov: 50 }}>
        {/* Global lighting */}
        <ambientLight intensity={0.3} />
        <hemisphereLight args={[0xffffff, 0x222222, 0.4]} />
        <directionalLight position={[5, 5, 5]} intensity={1.2} />
        <Environment preset="city" />
        <Ring />
        <OrbitControls />
      </Canvas>
    </div>   
  );         
}

