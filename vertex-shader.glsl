// vertex-shader.glsl
attribute vec4 a_position; // Vertex positions for a quad that covers the screen

void main() {
    gl_Position = a_position;
}
