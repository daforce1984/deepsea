// creature-vertex-shader.glsl
attribute vec2 a_creature_position; // Vertex positions for the creature model

uniform vec2 u_resolution;    // Canvas resolution
uniform vec2 u_translation;   // Translation for the creature (world X, world Y spawn depth)
uniform float u_scale;        // Scale for the creature
uniform float u_current_depth;// Current view depth (camera position, e.g. currentAltitude)

void main() {
    vec2 scaledVertexPosition = a_creature_position * u_scale;

    // Calculate the creature's y position relative to the camera's current depth.
    // u_translation.y is the world depth where the creature is (e.g., -500m).
    // u_current_depth is the camera's world depth (e.g., -1000m).
    // The difference (e.g. -500 - (-1000) = +500) is how far "above" (positive y)
    // or "below" (negative y) the center of the screen the creature's origin should be.
    float y_relative_to_camera = u_translation.y - u_current_depth;

    // Combine the creature's horizontal world position (u_translation.x)
    // with its calculated y position relative to the camera.
    // Then add the scaled model vertex position.
    vec2 positionInView = vec2(u_translation.x, y_relative_to_camera) + scaledVertexPosition;

    // Convert to clip space
    // Assumes u_resolution is vec2(canvas.width, canvas.height)
    // (0,0) in positionInView corresponds to center of screen if objects are placed relative to camera.
    // To map to full screen where (0,0) is center: divide by (width/2, height/2)
    // So, if u_resolution is (width, height), then divide by (u_resolution.x / 2.0, u_resolution.y / 2.0)
    // This means: vec2 clipSpace = positionInView / (u_resolution / 2.0);
    // This is equivalent to: vec2 clipSpace = (positionInView * 2.0) / u_resolution;
    // The provided calculation was:
    // vec2 zeroToOne = positionInView / u_resolution; // This maps to a range of [0,1] if origin was top-left
                                                    // and view was from 0 to u_resolution.
                                                    // If origin is center, and range is -width/2 to width/2,
                                                    // then positionInView / u_resolution maps (-0.5,-0.5) to (0.5,0.5) roughly.
    // Let's use the direct conversion assuming positionInView is already view-space pixels from center.
    vec2 clipSpace = vec2(positionInView.x / (u_resolution.x / 2.0), positionInView.y / (u_resolution.y / 2.0));


    // gl_Position expects x, y in [-1, 1] range.
    // Positive Y in clip space is typically upwards.
    // If our canvas coordinate system has Y downwards (common), we need to flip Y.
    gl_Position = vec4(clipSpace.x, -clipSpace.y, 0, 1);
}
