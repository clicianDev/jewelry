import { create } from "zustand";

export type Landmark = {
    x: number;
    y: number;
    z: number;
};

type HandState = {
    // Landmarks for the first detected hand (21 points) in normalized image coordinates [0,1]
    landmarks: Landmark[] | null;
    // Smoothed landmarks retained separately for consumers that prefer stabilized data
    landmarksSmoothed: Landmark[] | null;
    // Unsmooothed landmarks straight from MediaPipe (useful for low-latency tracking)
    landmarksRaw: Landmark[] | null;
    // Blend factor: 0 -> raw, 1 -> fully smoothed, values in-between lerp between raw and smoothed
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
        raw?: Landmark[] | null
    ) => void;
    setLandmarkBlend: (blend: number) => void;
    setVideoEl: (el: HTMLVideoElement | null) => void;
    setOrientation: (orientation: 'palm' | 'back' | null) => void;
    setPalmScore: (score: number | null) => void;
}

export const useHandStore = create<HandState>((set) => ({
    landmarks: null,
    landmarksSmoothed: null,
    landmarksRaw: null,
    landmarkBlend: 0,
    handedness: null,
    orientation: null,
    palmScore: null,
    videoEl: null,
    setLandmarks: (landmarks, handedness = null, raw = landmarks) =>
        set((state) => {
            const smoothed = landmarks ?? null;
            const rawData = raw ?? null;
            const blend = state.landmarkBlend;
            let blended: Landmark[] | null = null;
            if (!smoothed && !rawData) {
                blended = null;
            } else if (blend <= 0 || !smoothed) {
                blended = (rawData ?? smoothed) as Landmark[] | null;
            } else if (blend >= 1 || !rawData) {
                blended = (smoothed ?? rawData) as Landmark[] | null;
            } else {
                blended = smoothed!.map((s, i) => {
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
                landmarksSmoothed: smoothed,
                landmarksRaw: rawData,
                handedness,
            };
        }),
    setLandmarkBlend: (landmarkBlend) =>
        set((state) => {
            const blend = Math.min(1, Math.max(0, landmarkBlend));
            let blended: Landmark[] | null = null;
            const raw = state.landmarksRaw;
            const smooth = state.landmarksSmoothed;
            if (!smooth && !raw) {
                blended = null;
            } else if (blend <= 0 || !smooth) {
                blended = raw ?? smooth ?? null;
            } else if (blend >= 1 || !raw) {
                blended = smooth ?? raw ?? null;
            } else {
                blended = smooth!.map((s, i) => {
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