interface CameraErrorProps {
  errorType: "denied" | "not-found" | "unavailable" | "other";
  onRetry: () => void;
}

export default function CameraError({ errorType, onRetry }: CameraErrorProps) {
  const getErrorContent = () => {
    switch (errorType) {
      case "denied":
        return {
          title: "Camera Access Denied",
          message: "We need camera access to show you how rings look on your hand.",
          instructions: [
            "Click the camera icon in your browser's address bar",
            "Select 'Allow' for camera access",
            "Click the 'Try Again' button below"
          ],
          icon: "🚫"
        };
      case "not-found":
        return {
          title: "No Camera Found",
          message: "We couldn't detect a camera on your device.",
          instructions: [
            "Make sure your camera is connected",
            "Check if another app is using the camera",
            "Refresh your browser after connecting a camera"
          ],
          icon: "📷"
        };
      case "unavailable":
        return {
          title: "Camera Not Available",
          message: "Your browser doesn't support camera access.",
          instructions: [
            "Try using a modern browser like Chrome, Firefox, or Safari",
            "Make sure you're using HTTPS or localhost",
            "Update your browser to the latest version"
          ],
          icon: "⚠️"
        };
      default:
        return {
          title: "Camera Error",
          message: "Something went wrong with the camera.",
          instructions: [
            "Refresh the page and try again",
            "Check your camera permissions",
            "Make sure no other app is using the camera"
          ],
          icon: "❌"
        };
    }
  };

  const content = getErrorContent();

  return (
    <div className="camera-error-overlay">
      <div className="camera-error-content">
        <div className="camera-error-icon">{content.icon}</div>
        <h3 className="camera-error-title">{content.title}</h3>
        <p className="camera-error-message">{content.message}</p>
        
        <div className="camera-error-instructions">
          <p className="camera-error-instructions-title">How to fix:</p>
          <ol className="camera-error-list">
            {content.instructions.map((instruction, index) => (
              <li key={index}>{instruction}</li>
            ))}
          </ol>
        </div>

        <button className="camera-error-retry-button" onClick={onRetry}>
          Try Again
        </button>
      </div>
    </div>
  );
}
