import { useHandStore } from "@/store/hands";

export default function CameraSwitchButton() {
  const facingMode = useHandStore((state) => state.facingMode);
  const toggleFacingMode = useHandStore((state) => state.toggleFacingMode);

  return (
    <button
      className="camera-switch-button"
      onClick={toggleFacingMode}
      aria-label={`Switch to ${facingMode === 'user' ? 'back' : 'front'} camera`}
      title={`Switch to ${facingMode === 'user' ? 'back' : 'front'} camera`}
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Camera body */}
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
        {/* Camera lens */}
        <circle cx="12" cy="13" r="4" />
        {/* Switch arrows */}
        <path d="M17 8l1.5 1.5L17 11" strokeWidth="1.5" />
        <path d="M7 16l-1.5-1.5L7 13" strokeWidth="1.5" />
      </svg>
    </button>
  );
}
