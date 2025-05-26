// particle-vertex-shader.glsl
attribute vec2 a_particle_quad_vertex; // XY for a quad (-0.5 to 0.5)

uniform mat4 u_viewMatrix;
uniform mat4 u_projectionMatrix;
uniform vec3 u_particle_world_pos; // Center of the particle in world space
uniform float u_particle_size;
uniform vec3 u_camera_right_ws;    // Camera's right vector in world space
uniform vec3 u_camera_up_ws;       // Camera's up vector in world space

varying vec2 v_texCoord; // If using texture later, for now just for quad shape

void main() {
    // Billboard calculation: construct quad vertices in world space facing camera
    vec3 vertexWorldPos = u_particle_world_pos + 
                          u_camera_right_ws * a_particle_quad_vertex.x * u_particle_size +
                          u_camera_up_ws * a_particle_quad_vertex.y * u_particle_size;
    
    gl_Position = u_projectionMatrix * u_viewMatrix * vec4(vertexWorldPos, 1.0);
    v_texCoord = a_particle_quad_vertex + 0.5; // Texcoord from 0 to 1
}
