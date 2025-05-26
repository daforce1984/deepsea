// fragment-shader.glsl (for 3D Sebox background with zone-based lighting)
precision mediump float;

uniform float u_actualDepthMeters; // Actual current depth in meters

// Function to smoothly interpolate between values over a range
float smoothInterpolate(float value, float V0, float V1) {
    return smoothstep(0.0, 1.0, (value - V0) / (V1 - V0));
}

void main() {
    vec3 finalColor;

    // Define base colors
    vec3 surfaceSunlight = vec3(0.9, 0.9, 0.85);    // Bright, slightly yellowish sunlight at surface
    vec3 clearWaterBlueGreen = vec3(0.2, 0.5, 0.7); // Color when R,O,Y are mostly gone
    vec3 twilightBlue = vec3(0.05, 0.15, 0.3);      // Faint blue for twilight zone
    vec3 deepOceanAmbient = vec3(0.0, 0.005, 0.015); // Very dark blue/black for no sunlight zones

    float depth = u_actualDepthMeters;

    if (depth <= 50.0) { // Zone 1: 0-50m (Epipelagic - Full Sunlight)
        // Full sunlight, perhaps very slight blue cast with minimal depth increase
        float factor = depth / 50.0; // 0 to 1 over this zone
        finalColor = mix(surfaceSunlight, surfaceSunlight * vec3(0.95, 0.98, 1.0), factor);
    } 
    else if (depth <= 200.0) { // Zone 2: 50-200m (Epipelagic - Diminished R,O,Y)
        // Transition from surfaceSunlight (at 50m) to clearWaterBlueGreen (at 200m)
        // Red, orange, yellow fade out. Green and blue dominate.
        float factor = smoothInterpolate(depth, 50.0, 200.0); // 0 to 1 over this zone
        
        // At 50m (factor=0), effectively surfaceSunlight * vec3(0.95,0.98,1.0)
        vec3 startColor = surfaceSunlight * vec3(0.95, 0.98, 1.0); 
        // At 200m (factor=1), target clearWaterBlueGreen
        
        // More aggressive attenuation for red and green initially
        vec3 attenuatedSunlight = vec3(
            startColor.r * (1.0 - factor * 0.8), // Red diminishes significantly
            startColor.g * (1.0 - factor * 0.5), // Green diminishes moderately
            startColor.b * (1.0 - factor * 0.2)  // Blue diminishes least
        );
        finalColor = mix(attenuatedSunlight, clearWaterBlueGreen, factor); // Mix towards the target blue/green
        finalColor = mix(startColor, clearWaterBlueGreen, factor); // Simpler: direct mix to target color
    }
    else if (depth <= 1000.0) { // Zone 3: 200-1000m (Mesopelagic - Twilight Zone)
        // Transition from clearWaterBlueGreen (at 200m) to very faint twilightBlue (at 1000m)
        float factor = smoothInterpolate(depth, 200.0, 1000.0); // 0 to 1 over this zone
        finalColor = mix(clearWaterBlueGreen, twilightBlue, factor);
    }
    else { // Zone 4: 1000m+ (Bathypelagic & deeper - No Sunlight)
        // Transition from twilightBlue (at 1000m) to deepOceanAmbient (e.g. by 2000m, then stays dark)
        float factor = smoothInterpolate(depth, 1000.0, 2000.0); // 0 to 1 over 1000m-2000m
                                                                // Beyond 2000m, factor will be > 1, clamped by smoothstep to 1.
        finalColor = mix(twilightBlue, deepOceanAmbient, factor);
    }

    gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
}
