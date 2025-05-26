// godray-vertex-shader.glsl
attribute vec2 a_quad_pos; // Fullscreen quad vertices (-1 to 1)
varying vec2 v_texCoord;   // UV coordinates (0 to 1)

void main() {
    gl_Position = vec4(a_quad_pos, 0.0, 1.0);
    v_texCoord = a_quad_pos * 0.5 + 0.5; // Convert from -1..1 to 0..1
}
