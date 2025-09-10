export default function HandOverlay() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        background: "rgba(0,0,0,0.35)",
        color: "white",
        fontSize: 18,
        letterSpacing: 0.5,
        textAlign: "center",
        backdropFilter: "blur(2px)",
        pointerEvents: "none",
        animation: "fadeIn 0.4s ease",
      }}
    >
      <img
        src="/hand.svg"
        alt="Hand"
        width={140}
        height={140}
        style={{
          filter:
            "brightness(0) invert(1) drop-shadow(0 2px 4px rgba(0,0,0,0.4))",
          opacity: 0.9,
        }}
      />
      <div style={{ maxWidth: 325, lineHeight: 1.3 }}>
        <strong>Show your hand</strong>
        <br />
        Position your hand to try the ring on.
      </div>
    </div>
  );
}
