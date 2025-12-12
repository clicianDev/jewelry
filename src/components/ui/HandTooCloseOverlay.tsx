import { useHandStore } from "@/store/hands";

export default function HandTooCloseOverlay() {
  const isHandTooClose = useHandStore((state) => state.isHandTooClose);

  if (!isHandTooClose) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        zIndex: 100,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          backgroundColor: "rgba(0, 0, 0, 0.8)",
          color: "white",
          padding: "20px 40px",
          borderRadius: "12px",
          fontSize: "18px",
          fontWeight: 500,
          textAlign: "center",
          boxShadow: "0 4px 20px rgba(0, 0, 0, 0.3)",
        }}
      >
        Please move your hand away from the camera
      </div>
    </div>
  );
}
