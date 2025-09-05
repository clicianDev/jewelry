import { create } from "zustand";

export type Landmark = {
    x: number;
    y: number;
    z: number;
};

type HandState = {
    // Landmarks for the first detected hand (21 points) in normalized image coordinates [0,1]
    landmarks: Landmark[] | null;
    // -1..1 handedness score and label if needed later
    handedness: string | null;
    // The live webcam video element for reuse (env background, etc.)
    videoEl: HTMLVideoElement | null;
    setLandmarks: (landmarks: Landmark[] | null, handedness?: string | null) => void;
    setVideoEl: (el: HTMLVideoElement | null) => void;
}

export const useHandStore = create<HandState>((set) => ({
    landmarks: null,
    handedness: null,
    videoEl: null,
    setLandmarks: (landmarks, handedness = null) => set(() => ({ landmarks, handedness })),
    setVideoEl: (videoEl) => set({ videoEl }),
}));