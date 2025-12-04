import { EffectComposer, Bloom, SMAA, Vignette, ToneMapping } from "@react-three/postprocessing";
import { HalfFloatType } from "three";
import { BlendFunction } from "postprocessing";

export default function Postprocessing() {
	return (
		<EffectComposer
			autoClear={false}
 			multisampling={4}
			frameBufferType={HalfFloatType}
		>
			{/* Edge anti-aliasing that's fast and good for thin details */}
			<SMAA />
			{/* Enhanced bloom for sparkle/glint effects */}
			<Bloom
				mipmapBlur
				intensity={0.2}
				luminanceThreshold={0.6}
				luminanceSmoothing={0.2}
				radius={0.85}
				blendFunction={BlendFunction.SCREEN}
			/>
			{/* Gentle vignette to focus attention */}
			<Vignette eskil={false} offset={0.1} darkness={0.7} />
			{/* Tonemapping to keep highlights controlled while preserving sparkles */}
			<ToneMapping mode={0} />
		</EffectComposer>
	);
}
