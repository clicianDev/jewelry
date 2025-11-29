import { useState } from "react";

type CaptureButtonProps = {
  onCapture: () => void;
  disabled?: boolean;
};

const CameraIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
    <circle cx="12" cy="13" r="4"></circle>
  </svg>
);

const CheckIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
);

export default function CaptureButton({ onCapture, disabled }: CaptureButtonProps) {
  const [captured, setCaptured] = useState(false);

  const handleCapture = () => {
    onCapture();
    setCaptured(true);
    setTimeout(() => setCaptured(false), 2000);
  };

  return (
    <button
      className="capture-button"
      onClick={handleCapture}
      disabled={disabled}
      aria-label="Capture screenshot"
      title="Capture screenshot"
    >
      {captured ? (
        <>
          <CheckIcon />
          <span>Captured!</span>
        </>
      ) : (
        <>
          <CameraIcon />
          <span>Capture</span>
        </>
      )}
    </button>
  );
}
