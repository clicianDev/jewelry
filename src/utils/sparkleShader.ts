import * as THREE from "three";

/**
 * Custom sparkle/glint shader for jewelry
 * Creates dynamic sparkles that animate based on viewing angle and time
 */

export const sparkleVertexShader = `
varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vViewPosition;
varying vec2 vUv;

void main() {
  vNormal = normalize(normalMatrix * normal);
  vPosition = position;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = -mvPosition.xyz;
  vUv = uv;
  gl_Position = projectionMatrix * mvPosition;
}
`;

export const sparkleFragmentShader = `
uniform float uTime;
uniform float uSparkleIntensity;
uniform float uSparkleSize;
uniform float uSparkleSpeed;
uniform vec3 uSparkleColor;
uniform float uFresnelPower;
uniform float uMetalness;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vViewPosition;
varying vec2 vUv;

// Noise function for sparkle generation
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Fresnel effect for edge highlights
float fresnel(vec3 viewDirection, vec3 normal, float power) {
  float fresnelFactor = abs(dot(viewDirection, normal));
  float inverseFresnelFactor = 1.0 - fresnelFactor;
  return pow(inverseFresnelFactor, power);
}

void main() {
  vec3 viewDir = normalize(vViewPosition);
  vec3 normal = normalize(vNormal);
  
  // Base fresnel for edge glow
  float fresnelEffect = fresnel(viewDir, normal, uFresnelPower);
  
  // Animated sparkle pattern
  vec2 sparkleCoord = vPosition.xy * uSparkleSize + vPosition.yz * uSparkleSize * 0.5;
  float sparkleNoise = noise(sparkleCoord + uTime * uSparkleSpeed);
  
  // Secondary sparkle layer for more variety
  vec2 sparkleCoord2 = vPosition.yz * uSparkleSize * 1.5 - vPosition.xz * uSparkleSize * 0.7;
  float sparkleNoise2 = noise(sparkleCoord2 - uTime * uSparkleSpeed * 0.7);
  
  // Combine sparkle layers with thresholding for sharp glints
  float sparkle = step(0.92, sparkleNoise) * sparkleNoise;
  sparkle += step(0.94, sparkleNoise2) * sparkleNoise2 * 0.6;
  
  // Modulate sparkle by viewing angle (more sparkles at glancing angles)
  sparkle *= fresnelEffect * 1.5;
  
  // Pulse sparkles over time
  float pulse = sin(uTime * 2.0 + sparkleNoise * 10.0) * 0.5 + 0.5;
  sparkle *= pulse;
  
  // Final sparkle color with intensity control
  vec3 sparkleContribution = uSparkleColor * sparkle * uSparkleIntensity;
  
  // Metallic base with fresnel rim light
  vec3 baseColor = vec3(0.95, 0.95, 0.98);
  vec3 fresnelColor = mix(baseColor, vec3(1.0), fresnelEffect * 0.3);
  
  // Combine base color with sparkles
  vec3 finalColor = fresnelColor + sparkleContribution;
  
  // Add subtle metallic sheen
  finalColor = mix(finalColor, finalColor * 1.2, uMetalness);
  
  gl_FragColor = vec4(finalColor, 1.0);
}
`;

export type SparkleShaderUniforms = {
  [key: string]: THREE.IUniform<any>;
  uTime: { value: number };
  uSparkleIntensity: { value: number };
  uSparkleSize: { value: number };
  uSparkleSpeed: { value: number };
  uSparkleColor: { value: THREE.Color };
  uFresnelPower: { value: number };
  uMetalness: { value: number };
}

export function createSparkleShaderMaterial(
  options: Partial<{
    sparkleIntensity: number;
    sparkleSize: number;
    sparkleSpeed: number;
    sparkleColor: THREE.Color;
    fresnelPower: number;
    metalness: number;
  }> = {}
): THREE.ShaderMaterial {
  const uniforms: SparkleShaderUniforms = {
    uTime: { value: 0 },
    uSparkleIntensity: { value: options.sparkleIntensity ?? 2.0 },
    uSparkleSize: { value: options.sparkleSize ?? 15.0 },
    uSparkleSpeed: { value: options.sparkleSpeed ?? 0.5 },
    uSparkleColor: { value: options.sparkleColor ?? new THREE.Color(0xffffff) },
    uFresnelPower: { value: options.fresnelPower ?? 3.0 },
    uMetalness: { value: options.metalness ?? 0.8 },
  };

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: sparkleVertexShader,
    fragmentShader: sparkleFragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

export function updateSparkleShaderTime(
  material: THREE.ShaderMaterial,
  time: number
): void {
  if (material.uniforms.uTime) {
    material.uniforms.uTime.value = time;
  }
}
