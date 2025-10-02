import { useState, useRef, useEffect } from "react";
import { useControls } from "leva";
import { useHandStore } from "@/store/hands";
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import type { Landmark } from "@/store/hands";
import HandOverlay from "@/components/ui/HandOverlay";
import { EmaValue, LandmarkSmoother } from "@/utils/smoothing";

const AXIS_PRESETS = {
    Responsive: { q: 0.006, r: 0.0035, maxQ: 0.15, adaptStrength: 70 },
    Balanced: { q: 0.0025, r: 0.0014, maxQ: 0.07, adaptStrength: 45 },
    Stable: { q: 0.0016, r: 0.001, maxQ: 0.04, adaptStrength: 32 },
    UltraStable: { q: 0.0011, r: 0.0008, maxQ: 0.025, adaptStrength: 22 },
} as const;

type AxisPresetName = keyof typeof AXIS_PRESETS;
const AXIS_PRESET_OPTIONS = Object.keys(AXIS_PRESETS) as AxisPresetName[];
const DEFAULT_AXIS_PRESETS: { x: AxisPresetName; y: AxisPresetName; z: AxisPresetName } = {
    x: "Responsive",
    y: "Responsive",
    z: "Stable",
};



export default function HandTracker() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [ready, setReady] = useState(false);
    const [camError, setCamError] = useState<string | null>(null);
    const landmarks = useHandStore((state) => state.landmarks);
    const setLandmarks = useHandStore((state) => state.setLandmarks);
    const landmarkBlend = useHandStore((state) => state.landmarkBlend);
    const setLandmarkBlend = useHandStore((state) => state.setLandmarkBlend);
    const setOrientation = useHandStore((state) => state.setOrientation);
    const setVideoEl = useHandStore((state) => state.setVideoEl);
    const setPalmScore = useHandStore((state) => state.setPalmScore);
    const landmarkerRef = useRef<HandLandmarker | null>(null);
    const animationRef = useRef<number | null>(null);
    const fpsTimes = useRef<number[]>([]); // For FPS calculation
    const lastLogRef = useRef<number>(0);
    const lastOrientationRef = useRef<string | null>(null);
    const lastOrientationLogTs = useRef<number>(0);
    // Smoothers
    const landmarkSmootherRef = useRef(
        new LandmarkSmoother({
            mode: "adaptiveKalman",
            q: [
                AXIS_PRESETS[DEFAULT_AXIS_PRESETS.x].q,
                AXIS_PRESETS[DEFAULT_AXIS_PRESETS.y].q,
                AXIS_PRESETS[DEFAULT_AXIS_PRESETS.z].q,
            ],
            r: [
                AXIS_PRESETS[DEFAULT_AXIS_PRESETS.x].r,
                AXIS_PRESETS[DEFAULT_AXIS_PRESETS.y].r,
                AXIS_PRESETS[DEFAULT_AXIS_PRESETS.z].r,
            ],
            adaptStrength: [
                AXIS_PRESETS[DEFAULT_AXIS_PRESETS.x].adaptStrength,
                AXIS_PRESETS[DEFAULT_AXIS_PRESETS.y].adaptStrength,
                AXIS_PRESETS[DEFAULT_AXIS_PRESETS.z].adaptStrength,
            ],
            maxQ: [
                AXIS_PRESETS[DEFAULT_AXIS_PRESETS.x].maxQ,
                AXIS_PRESETS[DEFAULT_AXIS_PRESETS.y].maxQ,
                AXIS_PRESETS[DEFAULT_AXIS_PRESETS.z].maxQ,
            ],
        })
    );
    const palmScoreEmaRef = useRef(new EmaValue(0.6));

    const trackingControls = useControls(
        "Tracking",
        () => ({
            landmarkSmoothing: {
                label: "Landmark smoothing",
                value: landmarkBlend,
                min: 0,
                max: 1,
                step: 0.05,
                onChange: setLandmarkBlend,
            },
            presetX: {
                label: "X axis preset",
                value: DEFAULT_AXIS_PRESETS.x,
                options: AXIS_PRESET_OPTIONS,
            },
            presetY: {
                label: "Y axis preset",
                value: DEFAULT_AXIS_PRESETS.y,
                options: AXIS_PRESET_OPTIONS,
            },
            presetZ: {
                label: "Z axis preset",
                value: DEFAULT_AXIS_PRESETS.z,
                options: AXIS_PRESET_OPTIONS,
            },
            adaptMultiplier: {
                label: "Adaptive gain scale",
                value: 1,
                min: 0.4,
                max: 2,
                step: 0.05,
            },
            measurementScale: {
                label: "Measurement noise scale",
                value: 1,
                min: 0.5,
                max: 2,
                step: 0.05,
            },
        }),
        [landmarkBlend]
    );

    const {
        presetX,
        presetY,
        presetZ,
        adaptMultiplier,
        measurementScale,
    } = trackingControls as unknown as {
        presetX: AxisPresetName;
        presetY: AxisPresetName;
        presetZ: AxisPresetName;
        adaptMultiplier: number;
        measurementScale: number;
    };

    useEffect(() => {
        const resolvePreset = (value: AxisPresetName | string | undefined, axis: keyof typeof DEFAULT_AXIS_PRESETS): AxisPresetName => {
            if (value && value in AXIS_PRESETS) {
                return value as AxisPresetName;
            }
            return DEFAULT_AXIS_PRESETS[axis];
        };

        const safePresetNames = [
            resolvePreset(presetX, "x"),
            resolvePreset(presetY, "y"),
            resolvePreset(presetZ, "z"),
        ] as [AxisPresetName, AxisPresetName, AxisPresetName];

        const safeMeasurement = Number.isFinite(measurementScale) ? Math.max(0.1, measurementScale) : 1;
        const safeAdapt = Number.isFinite(adaptMultiplier) ? Math.max(0, adaptMultiplier) : 1;

        const qVec = safePresetNames.map((name) => AXIS_PRESETS[name].q) as [number, number, number];
        const rVec = safePresetNames.map((name) => AXIS_PRESETS[name].r * safeMeasurement) as [number, number, number];
        const adaptVec = safePresetNames.map((name) => AXIS_PRESETS[name].adaptStrength * safeAdapt) as [number, number, number];
        const maxQVec = safePresetNames.map((name) => AXIS_PRESETS[name].maxQ) as [number, number, number];
        const minQVec = qVec.map((q) => q * 0.2) as [number, number, number];

        landmarkSmootherRef.current.configure({
            mode: "adaptiveKalman",
            q: qVec,
            r: rVec,
            adaptStrength: adaptVec,
            maxQ: maxQVec,
            minQ: minQVec,
        });
    }, [presetX, presetY, presetZ, adaptMultiplier, measurementScale]);

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
                if(!navigator.mediaDevices?.getUserMedia){
                    setCamError("unavailable");
                    return;
                }
                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: { facingMode: "user" },
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
                                    const color = handed === "Left" ? "green" : handed === "Right" ? "purple" : "white";
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
                        // Smooth landmarks
                        const raw = first.map((p) => ({ x: p.x, y: p.y, z: p.z })) as Landmark[];
                        const smoothed = landmarkSmootherRef.current.apply(raw);
                        setLandmarks(smoothed, handed, raw);

                        // Orientation detection (palm vs back) & log when it changes (rate-limited)
                        const orientation = detectHandOrientation(smoothed as unknown as Landmark[], lastOrientationRef.current, handed);
                        if (orientation && orientation !== lastOrientationRef.current) {
                            const now = performance.now();
                            if (now - lastOrientationLogTs.current > 250) { // debounce window
                                lastOrientationRef.current = orientation;
                                lastOrientationLogTs.current = now;
                                console.log(`[HandTracker] Hand showing: ${orientation}`);
                                setOrientation(orientation as 'palm' | 'back');
                            }
                        }

                        // Compute and smooth continuous palm score for subtle effects like ring tilt
                        const scoreRaw = computePalmScore(smoothed as unknown as Landmark[], handed);
                        const score = palmScoreEmaRef.current.update(scoreRaw);
                        setPalmScore(score);
                    } else {
                        setLandmarks(null, null, null);
                        setPalmScore(null);
                        if (lastOrientationRef.current !== null) {
                            lastOrientationRef.current = null;
                            setOrientation(null);
                        }
                        // Reset smoothers when no hand
                        landmarkSmootherRef.current.reset();
                        palmScoreEmaRef.current.reset();
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
    }, [setLandmarks, setVideoEl, setOrientation, setPalmScore]);

    // Fallback UI if camera not accessible
    if (camError) {
        const msg = camError === "denied" ? "Camera permission denied" :
                    camError === "not-found" ? "No camera found" :
                    camError === "unavailable" ? "Camera API unavailable" :
                    camError === "init-failed" ? "Initialization failed" : "Camera error";
        return (
            <div style={{ position: "absolute", inset: 0, zIndex: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.75)', color: '#ddd', textAlign: 'center', gap: '1rem', padding: '1rem' }}>
                <img src="/camera-error.png" alt="Camera error" style={{ maxWidth: '200px', opacity: 0.85 }} />
                <div style={{ fontSize: '0.95rem', lineHeight: 1.4 }}>
                    <strong>{msg}</strong><br/>
                    {camError === 'denied' && 'Allow camera access in your browser settings and reload.'}
                    {camError === 'not-found' && 'Connect a camera device and reload.'}
                </div>
            </div>
        );
    }

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
    const PALM_THRESHOLD = 0.4; // enter palm if score > this
    const BACK_THRESHOLD = -0.4; // enter back if score < this
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