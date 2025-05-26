// particle-fragment-shader.glsl
precision mediump float;
uniform vec4 u_particle_color;
varying vec2 v_texCoord; // Use this to make it round if desired

void main() {
    // Optional: Make particles appear round instead of square
    float dist = distance(v_texCoord, vec2(0.5)); // Distance from center of quad
    if (dist > 0.5) {
         discard; // Discard fragment if outside circular shape
    }
    gl_FragColor = u_particle_color;
    // Apply pre-multiplied alpha if needed for certain blend modes, or just use color as is.
    // gl_FragColor = vec4(u_particle_color.rgb * u_particle_color.a, u_particle_color.a);
}
