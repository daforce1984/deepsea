precision mediump float;

uniform float u_actualDepthMeters; // Actual current depth in meters

// Function to smoothly interpolate between values over a range
float smoothInterpolate(float value, float V0, float V1) {
    // Ensure V0 is not equal to V1 to prevent division by zero if called directly by user.
    // For predefined zones below, V0 will always be less than V1.
    if (V0 == V1) return (value >= V0) ? 1.0 : 0.0;
    return smoothstep(0.0, 1.0, (value - V0) / (V1 - V0));
}

void main() {
    vec3 finalColor;
    float depth = u_actualDepthMeters;

    // Define new color palette based on user feedback
    vec3 sunlightWhite     = vec3(1.0, 1.0, 1.0);
    vec3 coolBlueTint    = vec3(0.502, 0.784, 0.863); // 10m
    vec3 deepCyanBlue    = vec3(0.118, 0.392, 0.706); // 30m
    vec3 darkBlue        = vec3(0.0, 0.118, 0.392);   // 100m
    vec3 almostBlack     = vec3(0.0, 0.020, 0.078);   // 200m+

    if (depth <= 0.0) { // Surface
        finalColor = sunlightWhite;
    } else if (depth <= 10.0) { // 0m to 10m
        float factor = smoothInterpolate(depth, 0.0, 10.0);
        finalColor = mix(sunlightWhite, coolBlueTint, factor);
    } else if (depth <= 30.0) { // 10m to 30m
        float factor = smoothInterpolate(depth, 10.0, 30.0);
        finalColor = mix(coolBlueTint, deepCyanBlue, factor);
    } else if (depth <= 100.0) { // 30m to 100m
        float factor = smoothInterpolate(depth, 30.0, 100.0);
        finalColor = mix(deepCyanBlue, darkBlue, factor);
    } else if (depth <= 200.0) { // 100m to 200m
        float factor = smoothInterpolate(depth, 100.0, 200.0);
        finalColor = mix(darkBlue, almostBlack, factor);
    } else { // Deeper than 200m
        finalColor = almostBlack;
    }

    gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
}
