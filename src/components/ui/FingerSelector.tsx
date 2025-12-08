import { useHandStore, FINGER_POSITIONS } from "@/store/hands";

export default function FingerSelector() {
  const fingerPositionIndex = useHandStore((state) => state.fingerPositionIndex);
  const cycleFingerPosition = useHandStore((state) => state.cycleFingerPosition);
  
  const currentFinger = FINGER_POSITIONS[fingerPositionIndex];

  return (
    <button
      className="finger-selector-button"
      onClick={cycleFingerPosition}
      aria-label={`Current finger: ${currentFinger.label}. Click to switch finger.`}
    >
      <img src="/selector.svg" alt="Switch finger" className="finger-selector-image" />
    </button>
  );
}
