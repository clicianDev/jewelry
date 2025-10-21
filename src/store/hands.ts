import { create } from "zustand";

export type Landmark = {
    x: number;
    y: number;
    z: number;
};

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
    // The live webcam video element for reuse (env background, etc.)
    videoEl: HTMLVideoElement | null;
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
    videoEl: null,
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
}));