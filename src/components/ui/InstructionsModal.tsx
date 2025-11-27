interface InstructionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onReady: () => void;
}

export default function InstructionsModal({ isOpen, onClose, onReady }: InstructionsModalProps) {
  if (!isOpen) return null;

  const handleReady = () => {
    onClose();
    onReady();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close modal">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <h2 className="modal-title">Get Ready to Try-on!</h2>
        
        <div className="modal-instructions">
          <div className="instruction-item">
            <div className="instruction-icon">
              <div style={{ width: '80px', height: '80px', borderRadius: '50%', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'black' }}>
                <img src="/hand.png" alt="Hand gesture" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              </div>
            </div>
            <p className="instruction-text">Show your right or left back of the hand</p>
          </div>
          
          <div className="instruction-item">
            <div className="instruction-icon">
              <div style={{ width: '80px', height: '80px', borderRadius: '50%', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'black' }}>
                <img src="/hand-ring-remove.png" alt="Hand gesture" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
            </div>
            <p className="instruction-text">Remove all finger accessories</p>
          </div>
        </div>
        
        <button className="ready-button" onClick={handleReady}>
          I&apos;M READY!
        </button>
      </div>
    </div>
  );
}
