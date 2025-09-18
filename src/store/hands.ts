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
    // Orientation of the detected hand relative to camera: 'palm' | 'back'
    orientation: 'palm' | 'back' | null;
    // Continuous orientation score (>0 palm toward camera, <0 back toward camera)
    palmScore: number | null;
    // The live webcam video element for reuse (env background, etc.)
    videoEl: HTMLVideoElement | null;
    setLandmarks: (landmarks: Landmark[] | null, handedness?: string | null) => void;
    setVideoEl: (el: HTMLVideoElement | null) => void;
    setOrientation: (orientation: 'palm' | 'back' | null) => void;
    setPalmScore: (score: number | null) => void;
}

export const useHandStore = create<HandState>((set) => ({
    landmarks: null,
    handedness: null,
    orientation: null,
    palmScore: null,
    videoEl: null,
    setLandmarks: (landmarks, handedness = null) => set(() => ({ landmarks, handedness })),
    setVideoEl: (videoEl) => set({ videoEl }),
    setOrientation: (orientation) => set({ orientation }),
    setPalmScore: (palmScore) => set({ palmScore }),
}));