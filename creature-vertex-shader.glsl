// creature-vertex-shader.glsl
attribute vec3 a_creature_position; // 3D model-space position
attribute vec3 a_vertex_normal;     // 3D model-space normal

uniform mat4 u_modelMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_projectionMatrix;

varying vec3 v_worldPosition;
varying vec3 v_worldNormal;

void main() {
    // Transform vertex position to world space
    vec4 worldPosition_v4 = u_modelMatrix * vec4(a_creature_position, 1.0);
    v_worldPosition = worldPosition_v4.xyz;

    // Transform vertex normal to world space
    // Assuming u_modelMatrix does not have non-uniform scaling, we can use it for normals.
    // For robustness with non-uniform scaling, use: mat3(transpose(inverse(u_modelMatrix)))
    v_worldNormal = normalize(mat3(u_modelMatrix) * a_vertex_normal);

    gl_Position = u_projectionMatrix * u_viewMatrix * worldPosition_v4;
}
