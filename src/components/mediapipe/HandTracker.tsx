import { useState, useRef, useEffect } from "react";
import { useControls } from "leva";
import { useHandStore } from "@/store/hands";
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import type { Landmark } from "@/store/hands";
import HandOverlay from "@/components/ui/HandOverlay";
import CameraError from "@/components/ui/CameraError";
import { EmaValue, LandmarkStabilizer } from "@/utils/stabilization";

type StabilizationMode = 'responsive' | 'balanced' | 'stable';
const STABILIZATION_MODE_OPTIONS: StabilizationMode[] = ['responsive', 'balanced', 'stable'];
const DEFAULT_STABILIZATION_MODE: StabilizationMode = 'responsive';



export default function HandTracker() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [ready, setReady] = useState(false);
    const [camError, setCamError] = useState<string | null>(null);
    const [retryKey, setRetryKey] = useState(0);
    const landmarks = useHandStore((state) => state.landmarks);
    const setLandmarks = useHandStore((state) => state.setLandmarks);
    const landmarkBlend = useHandStore((state) => state.landmarkBlend);
    const setLandmarkBlend = useHandStore((state) => state.setLandmarkBlend);
    const setOrientation = useHandStore((state) => state.setOrientation);
    const setVideoEl = useHandStore((state) => state.setVideoEl);
    const setPalmScore = useHandStore((state) => state.setPalmScore);
    const landmarkerRef = useRef<HandLandmarker | null>(null);
    const animationRef = useRef<number | null>(null);
    const lastFrameTimeRef = useRef<number | null>(null);
    const prevRawLandmarksRef = useRef<Landmark[] | null>(null);
    const fpsTimes = useRef<number[]>([]); // For FPS calculation
    const lastLogRef = useRef<number>(0);
    const lastOrientationRef = useRef<string | null>(null);
    const lastOrientationLogTs = useRef<number>(0);
    // Stabilizers
    const landmarkStabilizerRef = useRef(
        new LandmarkStabilizer(DEFAULT_STABILIZATION_MODE)
    );
    const palmScoreEmaRef = useRef(new EmaValue(0.8)); // Increased from 0.6 for smoother orientation transitions

    const trackingControls = useControls(
        "Tracking",
        () => ({
            stabilizationMode: {
                label: "Stabilization Mode",
                value: DEFAULT_STABILIZATION_MODE,
                options: STABILIZATION_MODE_OPTIONS,
            },
            landmarkBlending: {
                label: "Raw/Stabilized Blend",
                value: landmarkBlend,
                min: 0,
                max: 1.00,
                step: 0.05,
                onChange: setLandmarkBlend,
            },
            deadZone: {
                label: "Dead Zone (jitter filter)",
                value: 0.0002,  // Lower default for more responsiveness (was 0)
                min: 0,
                max: 0.003,
                step: 0.0001,
            },
            jitterThreshold: {
                label: "Jitter Threshold",
                value: 0.0015,  // Lower default (was 0.005)
                min: 0.0005,
                max: 0.005,
                step: 0.0001,
            },
            predictionStrength: {
                label: "Prediction Strength",
                value: 0.4,  // Higher default for better motion compensation (was 0.5)
                min: 0,
                max: 0.5,
                step: 0.05,
            },
            oneEuroMinCutoff: {
                label: "One Euro Min Cutoff",
                value: 4.0,  // Higher default for instant response (was 5)
                min: 0.5,
                max: 5,
                step: 0.1,
            },
            oneEuroBeta: {
                label: "One Euro Beta",
                value: 0.03,  // Higher default for better velocity tracking (was 0.02)
                min: 0.001,
                max: 0.05,
                step: 0.001,
            },
        }),
        [landmarkBlend]
    );

    const {
        stabilizationMode,
        deadZone,
        jitterThreshold,
        predictionStrength,
        oneEuroMinCutoff,
        oneEuroBeta,
    } = trackingControls as unknown as {
        stabilizationMode: StabilizationMode;
        deadZone: number;
        jitterThreshold: number;
        predictionStrength: number;
        oneEuroMinCutoff: number;
        oneEuroBeta: number;
    };

    useEffect(() => {
        landmarkStabilizerRef.current.configure(
            stabilizationMode,
            {
                deadZone,
                jitterThreshold,
                predictionStrength,
                oneEuroMinCutoff,
                oneEuroBeta,
            }
        );
    }, [stabilizationMode, deadZone, jitterThreshold, predictionStrength, oneEuroMinCutoff, oneEuroBeta]);

    const handleRetry = () => {
        setCamError(null);
        setReady(false);
        setRetryKey(prev => prev + 1);
    };

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
                        delegate: "GPU",
                    },
                    runningMode: "VIDEO",
                    numHands: 1,
                });
                landmarkerRef.current = landmarker;

                // Access webcam with user-facing camera preference
                if(!navigator.mediaDevices?.getUserMedia){
                    setCamError("unavailable");
                    return;
                }
                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: {
                            facingMode: "user",
                            width: { ideal: 640 },
                            height: { ideal: 480 },
                            frameRate: { ideal: 60, max: 60 },
                        },
                        audio: false,
                    });
                } catch (err) {
                    if (cancelled) return;
                    const e = err as DOMException & { name?: string; message?: string };
                    if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError" || e?.name === "NotReadableError") {
                        setCamError("not-found");
                    } else if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
                        setCamError("denied");
                    } else {
                        setCamError("other");
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
                    lastFrameTimeRef.current = nowMs;
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

                            //Custom FPS calculation and logging for accuracy

                            computeAndLogFps(nowMs, fpsTimes.current, lastLogRef);
                            // ctx.fillStyle = "white";
                            // ctx.font = "20px Arial";
                            // ctx.fillText(`FPS: ${fps.toFixed(1)}`, 10, 30);
                        }
                    }

                    // Update global state with landmarks
                    if(res?.landmarks?.length){
                        const first = res.landmarks[0];
                        const handed = res.handedness?.[0]?.[0]?.categoryName ?? null;
                        // Stabilize landmarks (no lag compensation needed - stabilization is low-latency by design)
                        const raw = first.map((p) => ({ x: p.x, y: p.y, z: p.z })) as Landmark[];
                        const stabilized = landmarkStabilizerRef.current.apply(raw, nowMs);

                        setLandmarks(stabilized, handed, raw, nowMs);
                        prevRawLandmarksRef.current = cloneLandmarks(raw);

                        // Orientation detection (palm vs back) & log when it changes (rate-limited)
                        // Use raw landmarks so hand flipping updates without stabilization delay.
                        const orientation = detectHandOrientation(raw, lastOrientationRef.current, handed);
                        if (orientation && orientation !== lastOrientationRef.current) {
                            const now = performance.now();
                            // Longer debounce window to prevent jitter during rotation (was 250ms)
                            if (now - lastOrientationLogTs.current > 500) {
                                lastOrientationRef.current = orientation;
                                lastOrientationLogTs.current = now;
                                setOrientation(orientation as 'palm' | 'back');
                            }
                        }

                        // Compute and smooth continuous palm score for subtle effects like ring tilt
                        const scoreRaw = computePalmScore(raw, handed);
                        const score = palmScoreEmaRef.current.update(scoreRaw);
                        setPalmScore(score);
                        
                        // Log palm score periodically (every 2 seconds)
                    } else {
                        setLandmarks(null, null, null, nowMs);
                        setPalmScore(null);
                        if (lastOrientationRef.current !== null) {
                            lastOrientationRef.current = null;
                            setOrientation(null);
                        }
                        // Reset stabilizers when no hand
                        landmarkStabilizerRef.current.reset();
                        palmScoreEmaRef.current.reset();
                        prevRawLandmarksRef.current = null;
                        lastFrameTimeRef.current = null;
                    }

                    animationRef.current = requestAnimationFrame(loop);
                };
                animationRef.current = requestAnimationFrame(loop);

            } catch (e) {
                console.error("Error initializing HandTracker:", e);
                setCamError("init-failed");
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
    }, [setLandmarks, setVideoEl, setOrientation, setPalmScore, retryKey]);

    // Fallback UI if camera not accessible
    if (camError) {
        const errorType = camError === "denied" ? "denied" :
                         camError === "not-found" ? "not-found" :
                         camError === "unavailable" ? "unavailable" : "other";
        return <CameraError errorType={errorType as "denied" | "not-found" | "unavailable" | "other"} onRetry={handleRetry} />;
    }

    return (
        <div style={{ position: "absolute", inset: 0, zIndex: 0, pointerEvents: "none" }}>
            <canvas ref={canvasRef} style={{ width: "100%", height: "100%", objectFit: "cover", display: ready ? "block" : "none" }}/>
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

function computeAndLogFps(nowMs: number, buffer: number[], lastLog: { current: number }) {
    buffer.push(nowMs);
    const windowMs = 2000;
    const cutoff = nowMs - windowMs;
    while (buffer.length && buffer[0] < cutoff) buffer.shift();
    let fps = 0;
    if (buffer.length > 1) {
        const duration = buffer[buffer.length - 1] - buffer[0];
        fps = (buffer.length - 1) / (duration / 1000);
    }
    if (!lastLog.current || nowMs - lastLog.current > 2000) {
        lastLog.current = nowMs;
        // Average FPS over this window
        console.log(`[HandTracker] avg FPS: ${fps.toFixed(1)}`);
    }
    return fps;
}

// Heuristic orientation detection using a subset of landmarks.
// Returns 'palm' if palm (camera-facing) or 'back' if back of hand likely showing.
// Approach: Compute normal from triangle (wrist(0), index MCP(5), pinky MCP(17)).
// For a Palm facing the camera (and image already mirrored), z of landmarks tends to:
// - MediaPipe z: more negative values are closer to camera.
// So if average z of finger MCPs (5,9,13,17) is closer (more negative) than wrist significantly and
// the normal points toward camera (negative z), we consider palm.
function detectHandOrientation(lms: Landmark[] | undefined, prev: string | null, handedness?: string | null): string | null {
    if (!lms || lms.length < 21) return null;
    // Landmark indices for orientation cues
    const WRIST = 0;
    const INDEX_MCP = 5; // base of index
    const PINKY_MCP = 17; // base of pinky

    const wrist = lms[WRIST];
    const indexMcp = lms[INDEX_MCP];
    const pinkyMcp = lms[PINKY_MCP];
    if (!wrist || !indexMcp || !pinkyMcp) return null;

    // Construct vectors on the palm plane
    const vIndex = {
        x: indexMcp.x - wrist.x,
        y: indexMcp.y - wrist.y,
        z: indexMcp.z - wrist.z,
    };
    const vPinky = {
        x: pinkyMcp.x - wrist.x,
        y: pinkyMcp.y - wrist.y,
        z: pinkyMcp.z - wrist.z,
    };
    // Palm normal via cross product (right-hand rule). The sign of z component alone was noisy; use full vector.
    const nx = vIndex.y * vPinky.z - vIndex.z * vPinky.y;
    const ny = vIndex.z * vPinky.x - vIndex.x * vPinky.z;
    const nz = vIndex.x * vPinky.y - vIndex.y * vPinky.x;

    // Normalize normal
    const nLen = Math.hypot(nx, ny, nz) || 1;
    const n = { x: nx / nLen, y: ny / nLen, z: nz / nLen };

    // Depth statistics: compare palm center-ish joints vs finger tips to detect facing.
    const baseZs = [lms[5].z, lms[9].z, lms[13].z, lms[17].z]; // MCP joints
    const tipZs = [lms[8].z, lms[12].z, lms[16].z, lms[20].z]; // finger tips
    const avgBaseZ = baseZs.reduce((a, b) => a + b, 0) / baseZs.length;
    const avgTipZ = tipZs.reduce((a, b) => a + b, 0) / tipZs.length;
    const wristZ = wrist.z;

    // MediaPipe: more negative z = closer to camera.
    // Palm facing camera: bases & wrist generally nearer than tips (tips curl away slightly) OR
    // the palm normal points toward camera (negative z after mirroring) depending on coordinate mirroring.
    // We'll combine several signals into a score.

    const depthBasesCloser = (avgBaseZ - wristZ); // negative => bases closer
    const depthTipsRelative = (avgTipZ - avgBaseZ); // positive => tips farther

    // Score components (tunable weights)
    const normalTowardCamera = -n.z; // if camera forward is -Z in normalized space
    const baseCloserScore = -depthBasesCloser; // larger if bases closer
    const tipsFartherScore = depthTipsRelative; // larger if tips farther than bases

    // Weighted sum
    let palmScore = normalTowardCamera * 0.5 + baseCloserScore * 0.3 + tipsFartherScore * 0.2;

    // ring.set.rotation.x.setScore( current rotation + or - palmScore * factor )

    // If the detected hand is the Left hand, invert score because the mirrored camera view flips facing logic.
    if (handedness === 'Left') {
        palmScore = -palmScore;
    }

    // Hysteresis to avoid flicker: require stronger evidence to switch states
    // Increased thresholds to prevent jittering during rotation
    const PALM_THRESHOLD = 0.6; // enter palm if score > this (was 0.4)
    const BACK_THRESHOLD = -0.6; // enter back if score < this (was -0.4)
    
    let result: 'palm' | 'back';
    
    if (prev === 'palm') {
        result = palmScore < BACK_THRESHOLD ? 'back' : 'palm';
    } else if (prev === 'back') {
        result = palmScore > PALM_THRESHOLD ? 'palm' : 'back';
    } else {
        // Initial classification
        result = palmScore >= 0 ? 'palm' : 'back';
    }

    return result;
}

function cloneLandmarks(list: Landmark[]): Landmark[] {
    return list.map((p) => ({ x: p.x, y: p.y, z: p.z }));
}

// Continuous palm score in range roughly [-1, 1]:
// >0 means palm toward camera; <0 means back of hand toward camera.
// Uses same underlying cues as detectHandOrientation but returns the weighted sum directly.
function computePalmScore(lms: Landmark[] | undefined, handedness?: string | null): number {
    if (!lms || lms.length < 21) return 0;

    const WRIST = 0;
    const INDEX_MCP = 5;
    const PINKY_MCP = 17;
    const wrist = lms[WRIST];
    const indexMcp = lms[INDEX_MCP];
    const pinkyMcp = lms[PINKY_MCP];
    if (!wrist || !indexMcp || !pinkyMcp) return 0;

    const vIndex = {
        x: indexMcp.x - wrist.x,
        y: indexMcp.y - wrist.y,
        z: indexMcp.z - wrist.z,
    };
    const vPinky = {
        x: pinkyMcp.x - wrist.x,
        y: pinkyMcp.y - wrist.y,
        z: pinkyMcp.z - wrist.z,
    };
    const nx = vIndex.y * vPinky.z - vIndex.z * vPinky.y;
    const ny = vIndex.z * vPinky.x - vIndex.x * vPinky.z;
    const nz = vIndex.x * vPinky.y - vIndex.y * vPinky.x;
    const len = Math.hypot(nx, ny, nz) || 1;
    const n = { x: nx / len, y: ny / len, z: nz / len };

    const baseZs = [lms[5].z, lms[9].z, lms[13].z, lms[17].z];
    const tipZs = [lms[8].z, lms[12].z, lms[16].z, lms[20].z];
    const avgBaseZ = baseZs.reduce((a, b) => a + b, 0) / baseZs.length;
    const avgTipZ = tipZs.reduce((a, b) => a + b, 0) / tipZs.length;
    const wristZ = wrist.z;

    // Components
    const normalTowardCamera = -n.z; // [-1..1]
    const baseCloserScore = -(avgBaseZ - wristZ); // larger if bases closer than wrist
    const tipsFartherScore = (avgTipZ - avgBaseZ); // larger if tips farther than bases

    // Weighted sum; tune weights to keep magnitude around [-1,1]
    let score = normalTowardCamera * 0.5 + baseCloserScore * 0.3 + tipsFartherScore * 0.2;

    // Normalize with tanh to keep in [-1, 1]
    score = Math.tanh(score);

    if (handedness === 'Left') score = -score;
    return score;
}