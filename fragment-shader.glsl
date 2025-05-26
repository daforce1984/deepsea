// fragment-shader.glsl (for 3D Sebox background with zone-based lighting)
precision mediump float;

uniform float u_actualDepthMeters; // Actual current depth in meters

// Function to smoothly interpolate between values over a range
float smoothInterpolate(float value, float V0, float V1) {
    return smoothstep(0.0, 1.0, (value - V0) / (V1 - V0));
}

void main() {
    vec3 finalColor;

    // Make surfaceSunlight slightly brighter and less yellow by default
    vec3 surfaceSunlight = vec3(0.95, 0.95, 0.92); // Brighter, more neutral sunlight

    vec3 clearWaterBlueGreen = vec3(0.2, 0.5, 0.7); 
    vec3 twilightBlue = vec3(0.05, 0.15, 0.3);      
    vec3 deepOceanAmbient = vec3(0.0, 0.005, 0.015); 

    float depth = u_actualDepthMeters;

    if (depth <= 0.05) { // Special case for very surface (e.g. first 5cm)
        finalColor = surfaceSunlight;
    } else if (depth <= 50.0) { // Zone 1: 0-50m (Epipelagic - Full Sunlight)
        // Start mixing slightly away from pure surfaceSunlight only after a tiny depth.
        // Factor now goes from 0 (at 0.05m) to 1 (at 50m) for this specific mix target.
        float factor = smoothInterpolate(depth, 0.05, 50.0); 
        finalColor = mix(surfaceSunlight, surfaceSunlight * vec3(0.90, 0.92, 0.98), factor); // Slightly more noticeable blue shift target
    } 
    else if (depth <= 200.0) { // Zone 2: 50-200m (Epipelagic - Diminished R,O,Y)
        float factor = smoothInterpolate(depth, 50.0, 200.0);
        // Color at 50m should be the result of the previous zone's calculation at 50m.
        vec3 colorAt50m = mix(surfaceSunlight, surfaceSunlight * vec3(0.90, 0.92, 0.98), 1.0); // End color of 0-50m zone
        finalColor = mix(colorAt50m, clearWaterBlueGreen, factor);
    }
    else if (depth <= 1000.0) { // Zone 3: 200-1000m (Mesopelagic - Twilight Zone)
        float factor = smoothInterpolate(depth, 200.0, 1000.0);
        finalColor = mix(clearWaterBlueGreen, twilightBlue, factor);
    }
    else { // Zone 4: 1000m+ (Bathypelagic & deeper - No Sunlight)
        float factor = smoothInterpolate(depth, 1000.0, 2000.0); 
        finalColor = mix(twilightBlue, deepOceanAmbient, factor);
    }

    gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
}
