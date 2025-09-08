import { useState, useRef, useEffect } from "react";
import { useHandStore } from "@/store/hands";
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import HandOverlay from "@/components/ui/HandOverlay";



export default function HandTracker() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [ready, setReady] = useState(false);
    const landmarks = useHandStore((state) => state.landmarks);
    const setLandmarks = useHandStore((state) => state.setLandmarks);
    const setVideoEl = useHandStore((state) => state.setVideoEl);
    const landmarkerRef = useRef<HandLandmarker | null>(null);
    const animationRef = useRef<number | null>(null);
    // const fpsTimes = useRef<number[]>([]); // For FPS calculation
    // const lastLogRef = useRef<number>(0);

    useEffect(() => {
        let stream: MediaStream | null = null;
        let cancelled = false;

        async function init() {
            try {
                // Load wasm assets from CDN
                const fileset = await FilesetResolver.forVisionTasks(
                    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
                );
                if (cancelled) return;

                const landmarker = await HandLandmarker.createFromOptions(fileset, {
                    baseOptions: {
                        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
                    },
                    runningMode: "VIDEO",
                    numHands: 1,
                });
                landmarkerRef.current = landmarker;

                // Access webcam with user-facing camera preference
                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: { facingMode: "user" },
                        audio: false,
                    });
                } catch (err) {
                    if (cancelled) return;
                    const e = err as DOMException & { name?: string; message?: string };
                    if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError" || e?.name === "NotReadableError") {
                        // logging only for now
                        alert("No camera device found or it is not accessible.");
                    } else if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
                        alert("Camera access was denied. Please allow permission.");
                    } else {
                        alert(`Unable to access camera: ${e?.message ?? String(e)}`);
                    }
                    return;
                }

                if(!videoRef.current) return;
                videoRef.current.srcObject = stream;
                await videoRef.current.play();

                // Match canvas size to the actual video frame size
                if(canvasRef.current){
                    const vw = videoRef.current.videoWidth || 640;
                    const vh = videoRef.current.videoHeight || 480;
                    canvasRef.current.width = vw;
                    canvasRef.current.height = vh;
                }
                // Store video element for reuse (env background, etc.)
                setVideoEl(videoRef.current);

                setReady(true);

                // Start processing loop
                const loop = () => {
                    if(!videoRef.current || !landmarkerRef.current) return;
                    const nowMs = performance.now();
                    const res: HandLandmarkerResult = landmarkerRef.current.detectForVideo(
                        videoRef.current,
                        nowMs
                    );
                
                
                    if(canvasRef.current){
                        const ctx = canvasRef.current.getContext("2d");
                        if(ctx) {
                            const w = canvasRef.current.width;
                            const h = canvasRef.current.height;
                            // Mirror for user-facing camera feel
                            ctx.save();
                            ctx.clearRect(0, 0, w, h);
                            ctx.scale(-1, 1);
                            ctx.translate(-w, 0); // Flip horizontally 
                            ctx.drawImage(videoRef.current, 0, 0, w, h);
                            ctx.restore();

                            if(res?.landmarks?.length){
                                res.landmarks.forEach((hand, i) => {
                                    const handed = res.handedness?.[i]?.[0]?.categoryName || "unknown";
                                    const color = handed === "Left" ? "red" : handed === "Right" ? "blue" : "white";
                                    ctx.fillStyle = color;
                                    hand.forEach((p) => {
                                        const x = (1 - p.x) * w; // flip x because of mirrored
                                        const y = p.y * h;
                                        ctx.beginPath();
                                        ctx.arc(x, y, 4, 0, Math.PI * 2);
                                        ctx.fill();
                                    });
                                });
                            }

                            //Custom FPS calculation and logging for accuracy

                            // const fps = computeAndLogFps(nowMs, fpsTimes.current, lastLogRef);
                            // ctx.fillStyle = "white";
                            // ctx.font = "20px Arial";
                            // ctx.fillText(`FPS: ${fps.toFixed(1)}`, 10, 30);
                        }
                    }

                    // Update global state with landmarks
                    if(res?.landmarks?.length){
                        const first = res.landmarks[0];
                        const handed = res.handedness?.[0]?.[0]?.categoryName ?? null;
                        setLandmarks(first.map((p) => ({ x: p.x, y: p.y, z: p.z })), handed);
                    } else {
                        setLandmarks(null, null);
                    }

                    animationRef.current = requestAnimationFrame(loop);
                };
                animationRef.current = requestAnimationFrame(loop);

            } catch (e) {
                console.error("Error initializing HandTracker:", e);
            }
        }
        init();

        return () => {
            cancelled = true;
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
            }
            const lm = landmarkerRef.current;
            if (lm) {
                lm.close();
                landmarkerRef.current = null;
            }
            if (stream) {
                stream.getTracks().forEach((t) => t.stop());
            }
        }
    }, [setLandmarks, setVideoEl]);

    return (
        <div style={{ position: "absolute", inset: 0, zIndex: 0, pointerEvents: "none" }}>
            <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: ready ? "block" : "none" }}/>
            {/* Keep video mounted for Safari autoplay policy */}
            <video ref={videoRef} playsInline muted style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />
            {/* Display guidance overlay if no hand detected (after camera ready) */}
            {ready && !landmarks && (
               <HandOverlay/>
            )}
        </div>
    )
}

// Custom FPS calculation and logging

// function computeAndLogFps(nowMs: number, buffer: number[], lastLog: { current: number }) {
//     buffer.push(nowMs);
//     const windowMs = 2000;
//     const cutoff = nowMs - windowMs;
//     while (buffer.length && buffer[0] < cutoff) buffer.shift();
//     let fps = 0;
//     if (buffer.length > 1) {
//         const duration = buffer[buffer.length - 1] - buffer[0];
//         fps = (buffer.length - 1) / (duration / 1000);
//     }
//     if (!lastLog.current || nowMs - lastLog.current > 2000) {
//         lastLog.current = nowMs;
//         // Average FPS over this window
//         console.log(`[HandTracker] avg FPS: ${fps.toFixed(1)}`);
//     }
//     return fps;
// }