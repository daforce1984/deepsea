// vertex-shader.glsl (for 3D Sebox background)
attribute vec3 a_position; // Vertex positions for the seabox cube (3D)

uniform mat4 u_projectionMatrix;
uniform mat4 u_viewMatrix;
// No model matrix for skybox, or it's identity and centered on camera

varying vec3 v_worldPosition; // Pass world position to fragment shader if needed for effects

void main() {
    // Standard transformation for a very large box around the origin
    // vec4 worldPos = u_modelMatrix * vec4(a_position, 1.0); // If we had a model matrix scaling it up
    // For a skybox, a common technique is to make the view matrix ignore camera translation
    mat4 viewMatrixNoTranslation = u_viewMatrix;
    viewMatrixNoTranslation[3][0] = 0.0; // Remove x translation
    viewMatrixNoTranslation[3][1] = 0.0; // Remove y translation
    viewMatrixNoTranslation[3][2] = 0.0; // Remove z translation

    vec4 pos = u_projectionMatrix * viewMatrixNoTranslation * vec4(a_position, 1.0);
    
    // Ensure the skybox is always at the far clip plane so it's behind everything.
    // This makes it appear infinitely far and sorts correctly.
    gl_Position = pos.xyww; 
    
    v_worldPosition = a_position; // Pass original model position (or transformed if needed)
                                  // For depth color, we need camera's Y, not this.
}
