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

// Uniforms for depth interaction
uniform sampler2D u_sceneDepthTexture;
uniform float u_cameraNear;
uniform float u_cameraFar;

const int MAX_SHADER_SAMPLES = 128;

// Function to convert depth from texture (0.0 to 1.0) to view space Z (positive, distance from camera)
// Note: This specific formula assumes depth is [0,1] and perspective projection.
// It returns positive view space Z. Adjust if your projection matrix or depth range differs.
float linearizeDepth(float depthSample, float near, float far) {
    float z_ndc = 2.0 * depthSample - 1.0; // Convert to Normalized Device Coordinates [-1, 1]
    if (far == 0.0) return near; // Avoid division by zero if far is not set or perspective is weird
    // If far is very large (e.g. infinite projection), this formula can be problematic.
    // A common alternative for infinite far: return near / (1.0 - depthSample * (1.0 - near/far_placeholder_if_infinite));
    // However, with a finite zFar, this should be okay.
    return (2.0 * near * far) / (far + near - z_ndc * (far - near));
}

void main() {
    vec2 deltaTexCoord = v_texCoord - u_lightScreenPos;
    deltaTexCoord *= 1.0 / max(1.0, float(u_num_samples)) * u_density;

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

        // Get scene depth at the current ray sample's screen position
        float sceneDepthAtSampleTexCoord = texture2D(u_sceneDepthTexture, currentTexCoord).r; // Assuming depth is in 'r' component
        float viewZ_scene = linearizeDepth(sceneDepthAtSampleTexCoord, u_cameraNear, u_cameraFar);

        // Attenuate the ray sample if it's "behind" a close object in the scene.
        // Rays are stronger if the scene geometry at the sample point is further away.
        // This creates an effect where rays are occluded by closer objects.
        // The constant '0.1' and '0.8' here are magic numbers for sensitivity, may need tuning.
        // 'viewZ_scene / u_cameraFar' normalizes view depth to [0,1] roughly.
        float occlusionFactor = smoothstep(0.1, 0.8, viewZ_scene / u_cameraFar);
        sampleValue *= occlusionFactor;

        sampleValue *= illuminationDecay * u_weight;
        color += sampleValue;
        illuminationDecay *= u_decay;
    }
    gl_FragColor = vec4(color.rgb * u_exposure, 1.0);
}
