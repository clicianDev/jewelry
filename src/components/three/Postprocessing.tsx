import { EffectComposer, Bloom, SMAA, Vignette, ToneMapping } from "@react-three/postprocessing";
import { HalfFloatType } from "three";

export default function Postprocessing() {
	return (
		<EffectComposer
			autoClear={false}
 			multisampling={4}
			frameBufferType={HalfFloatType}
		>
			{/* Edge anti-aliasing that's fast and good for thin details */}
			<SMAA />
			{/* Subtle highlight bloom to make metals pop */}
			<Bloom
				mipmapBlur
				intensity={0.3}
				luminanceThreshold={0.7}
				luminanceSmoothing={0.15}
			/>
			{/* Gentle vignette to focus attention */}
			<Vignette eskil={false} offset={0.1} darkness={0.7} />
			{/* Tonemapping to keep highlights controlled */}
			<ToneMapping />
		</EffectComposer>
	);
}
