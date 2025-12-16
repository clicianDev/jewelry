import { create } from "zustand";

export type Landmark = {
    x: number;
    y: number;
    z: number;
};

// Detect if device is mobile (touch device without hover)
const isMobileDevice = (): boolean => {
    if (typeof window === 'undefined') return false;
    return (
        'ontouchstart' in window ||
        navigator.maxTouchPoints > 0 ||
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    );
};

// Finger landmark index pairs for ring positioning
// Each pair represents [MCP, PIP] joint indices for each finger
export const FINGER_POSITIONS = [
    { indices: [13, 14], label: 'Ring' },    // Ring finger (default)
    { indices: [9, 10], label: 'Middle' },   // Middle finger
    { indices: [5, 6], label: 'Index' },     // Index finger
    { indices: [2, 3], label: 'Thumb' },     // Thumb
    { indices: [17, 18], label: 'Pinky' },   // Pinky finger
] as const;

type HandState = {
    // Landmarks for the first detected hand (21 points) in normalized image coordinates [0,1]
    landmarks: Landmark[] | null;
    // Stabilized landmarks retained separately for consumers that prefer filtered data
    landmarksStabilized: Landmark[] | null;
    // Unprocessed landmarks straight from MediaPipe (useful for lowest latency tracking)
    landmarksRaw: Landmark[] | null;
    // Timestamp (performance.now) of the last landmark update; null if no landmarks
    landmarksUpdatedAt: number | null;
    // Blend factor: 0 -> raw, 1 -> fully stabilized, values in-between lerp between raw and stabilized
    landmarkBlend: number;
    // -1..1 handedness score and label if needed later
    handedness: string | null;
    // Orientation of the detected hand relative to camera: 'palm' | 'back'
    orientation: 'palm' | 'back' | null;
    // Continuous orientation score (>0 palm toward camera, <0 back toward camera)
    palmScore: number | null;
    // Current finger position index (0-4, cycles through FINGER_POSITIONS)
    fingerPositionIndex: number;
    // Whether the hand is too close to the camera
    isHandTooClose: boolean;
    // The live webcam video element for reuse (env background, etc.)
    videoEl: HTMLVideoElement | null;
    // Camera facing mode: 'user' (front) or 'environment' (back)
    facingMode: 'user' | 'environment';
    setLandmarks: (
        landmarks: Landmark[] | null,
        handedness?: string | null,
        raw?: Landmark[] | null,
        timestampMs?: number | null
    ) => void;
    setLandmarkBlend: (blend: number) => void;
    setVideoEl: (el: HTMLVideoElement | null) => void;
    setOrientation: (orientation: 'palm' | 'back' | null) => void;
    setPalmScore: (score: number | null) => void;
    cycleFingerPosition: () => void;
    setIsHandTooClose: (isClose: boolean) => void;
    setFacingMode: (mode: 'user' | 'environment') => void;
    toggleFacingMode: () => void;
}

export const useHandStore = create<HandState>((set) => ({
    landmarks: null,
    landmarksStabilized: null,
    landmarksRaw: null,
    landmarksUpdatedAt: null,
    landmarkBlend: 0,
    handedness: null,
    orientation: null,
    palmScore: null,
    fingerPositionIndex: 0,
    isHandTooClose: false,
    videoEl: null,
    facingMode: isMobileDevice() ? 'environment' : 'user', // Back camera on mobile, front on desktop
    setLandmarks: (landmarks, handedness = null, raw = landmarks, timestampMs = typeof performance !== "undefined" ? performance.now() : Date.now()) =>
        set((state) => {
            const stabilized = landmarks ?? null;
            const rawData = raw ?? null;
            const blend = state.landmarkBlend;
            let blended: Landmark[] | null = null;
            if (!stabilized && !rawData) {
                blended = null;
            } else if (blend <= 0 || !stabilized) {
                blended = rawData ?? stabilized ?? null;
            } else if (blend >= 1 || !rawData) {
                blended = stabilized ?? rawData ?? null;
            } else {
                blended = stabilized!.map((s, i) => {
                    const r = rawData![i] ?? s;
                    return {
                        x: r.x + (s.x - r.x) * blend,
                        y: r.y + (s.y - r.y) * blend,
                        z: r.z + (s.z - r.z) * blend,
                    };
                });
            }
            return {
                landmarks: blended,
                landmarksStabilized: stabilized,
                landmarksRaw: rawData,
                landmarksUpdatedAt: stabilized || rawData ? timestampMs ?? (typeof performance !== "undefined" ? performance.now() : Date.now()) : null,
                handedness,
            };
        }),
    setLandmarkBlend: (landmarkBlend) =>
        set((state) => {
            const blend = Math.min(1, Math.max(0, landmarkBlend));
            let blended: Landmark[] | null = null;
            const raw = state.landmarksRaw;
            const stabilized = state.landmarksStabilized;
            if (!stabilized && !raw) {
                blended = null;
            } else if (blend <= 0 || !stabilized) {
                blended = raw ?? stabilized ?? null;
            } else if (blend >= 1 || !raw) {
                blended = stabilized ?? raw ?? null;
            } else {
                blended = stabilized!.map((s, i) => {
                    const r = raw![i] ?? s;
                    return {
                        x: r.x + (s.x - r.x) * blend,
                        y: r.y + (s.y - r.y) * blend,
                        z: r.z + (s.z - r.z) * blend,
                    };
                });
            }
            return {
                landmarkBlend: blend,
                landmarks: blended,
            };
        }),
    setVideoEl: (videoEl) => set({ videoEl }),
    setOrientation: (orientation) => set({ orientation }),
    setPalmScore: (palmScore) => set({ palmScore }),
    cycleFingerPosition: () => set((state) => ({
        fingerPositionIndex: (state.fingerPositionIndex + 1) % FINGER_POSITIONS.length
    })),
    setIsHandTooClose: (isHandTooClose) => set({ isHandTooClose }),
    setFacingMode: (facingMode) => set({ facingMode }),
    toggleFacingMode: () => set((state) => ({
        facingMode: state.facingMode === 'user' ? 'environment' : 'user'
    })),
}));