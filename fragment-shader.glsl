// background-fragment-shader.glsl (formerly fragment-shader.glsl, for 3D Sebox background)
precision mediump float;

uniform float u_depth;     // Current depth (normalized, 0.0 at surface to 1.0 at max_depth for full effect)

void main() {
    vec3 surfaceLightColor = vec3(0.7, 0.85, 1.0); // A brighter, slightly desaturated sky blue/cyan for surface light
    vec3 deepWaterColor = vec3(0.0, 0.02, 0.05); // Very dark blue for the deep water ambient

    float depth = clamp(u_depth, 0.0, 1.0);

    // Attenuation factors - Red attenuates fastest, Green medium, Blue slowest
    // Using pow for a non-linear falloff. Higher exponent = faster falloff.
    // Adjust these exponents to control how quickly each color fades.
    // We want blue to persist longer.
    float r_attenuation = pow(1.0 - depth, 3.0);  // Red fades relatively quickly
    float g_attenuation = pow(1.0 - depth, 2.0);  // Green fades moderately
    float b_attenuation = pow(1.0 - depth, 1.0);  // Blue fades slowest

    // Modulate the surface light color by these attenuation factors
    vec3 attenuatedLight = vec3(surfaceLightColor.r * r_attenuation,
                                surfaceLightColor.g * g_attenuation,
                                surfaceLightColor.b * b_attenuation);

    // The final color is a mix of the attenuated surface light and the deep water ambient color.
    // As depth increases, attenuatedLight becomes black, and we are left with deepWaterColor.
    // Or, more simply, the attenuated light IS the color contribution from the surface,
    // and then it blends into the ambient deepWaterColor.
    // Let's consider the attenuatedLight as the light that has penetrated to this depth.
    // The deepWaterColor can be the base color of the water itself when no light penetrates.

    // Option 1: Mix based on overall light intensity or just depth
    // float lightIntensity = (attenuatedLight.r + attenuatedLight.g + attenuatedLight.b) / 3.0;
    // vec3 finalColor = mix(deepWaterColor, attenuatedLight, 1.0 - depth); // As light fades, mix in more deepWaterColor
    
    // Option 2: Direct attenuated light, possibly adding a base deepWaterColor
    // This makes more sense: the light itself changes color and intensity.
    // The "deepSeaColor" in the old shader was the target color. Now, the target is essentially black,
    // but the path to black is colored by the differential attenuation.
    // We can add a minimal ambient deep water color that's always there.
    
    vec3 finalColor = attenuatedLight + deepWaterColor * (depth * 0.5 + 0.5); // Gradually introduce more deepWaterColor influence as ambient
                                                                            // and ensure deepWaterColor is more prominent at depth.

    // Ensure final color doesn't exceed 1.0 if surfaceLightColor components are high
    finalColor = clamp(finalColor, 0.0, 1.0);

    gl_FragColor = vec4(finalColor, 1.0);
}
