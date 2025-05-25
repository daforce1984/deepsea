// fragment-shader.glsl
precision mediump float;

uniform vec2 u_resolution; // Canvas resolution (width, height)
uniform float u_depth;     // Current depth (normalized, e.g., 0.0 at surface to 1.0 at max_depth)

void main() {
    // Define surface color and deep sea color
    vec3 surfaceColor = vec3(0.2, 0.5, 0.8); // A bright-ish blue/cyan
    vec3 deepSeaColor = vec3(0.0, 0.0, 0.1); // Very dark blue, almost black

    // Clamp depth to be between 0 and 1 to avoid issues with extreme values
    float normalizedDepth = clamp(u_depth, 0.0, 1.0);

    // Interpolate color based on normalized depth
    // As depth increases, mix more of deepSeaColor
    vec3 color = mix(surfaceColor, deepSeaColor, normalizedDepth);

    gl_FragColor = vec4(color, 1.0);
}
