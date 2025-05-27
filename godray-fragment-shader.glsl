// godray-fragment-shader.glsl
precision mediump float;

varying vec2 v_texCoord;

uniform sampler2D u_occlusionTexture; // Texture with the light spot
uniform vec2 u_lightScreenPos;    // Screen position of the light source (0.0 to 1.0)
                                  // (e.g., (0.5, 0.5) for center)

// God Ray parameters - now uniforms
uniform int u_num_samples; 
uniform float u_decay;
uniform float u_exposure;
uniform float u_density;
uniform float u_weight;

const int MAX_SHADER_SAMPLES = 128;

void main() {
    vec2 deltaTexCoord = v_texCoord - u_lightScreenPos;
    // Ensure u_num_samples is not zero to prevent division by zero if passed as such.
    // GLSL doesn't allow dynamic loops based on non-const uniforms easily in older versions.
    // However, WebGL 1.0 GLSL ES 1.00 allows loops with counters based on uniforms.
    // Let's assume this works. If not, NUM_SAMPLES would need to remain a const or require shader recompile.
    // For safety, let's keep NUM_SAMPLES as a const in shader, but make others uniform.
    // The user can change the const and re-run if they want to change sample count.
    // Or, better, pass it as a float and cast to int for loop, ensuring it's > 0.

    // Let's try making NUM_SAMPLES a uniform int. Max loop count might be implementation defined.
    // If it causes issues, it can be reverted to const.
    
    deltaTexCoord *= 1.0 / max(1.0, float(u_num_samples)) * u_density; // Use max(1,...) for safety

    float illuminationDecay = 1.0;
    vec4 color = vec4(0.0);

    for (int i = 0; i < MAX_SHADER_SAMPLES; i++) { // Loop with uniform
        if (i >= u_num_samples) {
            break;
        }
        vec2 currentTexCoord = u_lightScreenPos + deltaTexCoord * float(i);
        // Check if currentTexCoord is within texture bounds (0..1)
        if (currentTexCoord.x < 0.0 || currentTexCoord.x > 1.0 ||
            currentTexCoord.y < 0.0 || currentTexCoord.y > 1.0) {
            break; 
        }
        vec4 sampleValue = texture2D(u_occlusionTexture, currentTexCoord);
        sampleValue *= illuminationDecay * u_weight;
        color += sampleValue;
        illuminationDecay *= u_decay;
    }
    gl_FragColor = vec4(color.rgb * u_exposure, 1.0);
}
