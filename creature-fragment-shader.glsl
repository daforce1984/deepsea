// creature-fragment-shader.glsl
precision mediump float;

// Existing uniforms for global light and material
uniform vec3 u_materialDiffuseColor;
uniform vec3 u_lightPosition; // Global light
uniform vec3 u_lightColor;    // Global light color
uniform vec3 u_cameraPosition;
uniform float u_materialShininess;
uniform vec3 u_ambientColor;

// New uniforms for flashlight
uniform bool u_isFlashlightOn;
uniform vec3 u_flashlightPosition;

// Uniforms for Fog Effect
uniform vec3 u_fogColor;
uniform float u_fogStartDistance;
uniform float u_fogEndDistance;

uniform vec3 u_flashlightPosition;
uniform vec3 u_flashlightDirection; // Normalized direction vector
uniform vec3 u_flashlightColor;
uniform float u_flashlightIntensity;
uniform float u_flashlightConeCos;     // Cosine of flashlight's inner half-angle
uniform float u_flashlightOuterConeCos; // Cosine of flashlight's outer half-angle

varying vec3 v_worldPosition;
varying vec3 v_worldNormal;

// Function to calculate lighting from a single point/spot light
vec3 calculateLight(vec3 normal, vec3 fragPos, vec3 lightPos, vec3 lightCol, 
                    vec3 diffuseMaterial, vec3 viewDir, float shininess,
                    bool isSpotlight, vec3 spotDir, float spotConeCos, float spotOuterConeCos, float spotIntensity) {
    
    vec3 lightDir = normalize(lightPos - fragPos);
    
    // Spotlight intensity factor
    float spotEffect = 1.0;
    if (isSpotlight) {
        float fragmentAngleCos = dot(-lightDir, normalize(spotDir)); // Angle between lightToFragment and spotlightDirection
        // Smoothstep for penumbra effect
        spotEffect = smoothstep(spotOuterConeCos, spotConeCos, fragmentAngleCos);
        //spotEffect = (fragmentAngleCos > spotConeCos) ? 1.0 : 0.0; // Basic cone check
    }

    if (spotEffect == 0.0) { // If outside spotlight cone (for spotlights)
        return vec3(0.0); // No contribution from this light
    }

    // Ambient (already handled globally, or could be per light source type)
    // For this function, we'll just calculate diffuse and specular for the given light.

    // Diffuse
    float diff = max(dot(normal, lightDir), 0.0);
    vec3 diffuse = diff * lightCol * diffuseMaterial;

    // Specular
    vec3 reflectDir = reflect(-lightDir, normal);
    float spec = pow(max(dot(viewDir, reflectDir), 0.0), shininess);
    vec3 specular = spec * lightCol; // Specular usually reflects light color

    return (diffuse + specular) * spotEffect * spotIntensity;
}


void main() {
    vec3 normal = normalize(v_worldNormal);
    vec3 viewDir = normalize(u_cameraPosition - v_worldPosition);
    
    // Start with global ambient light
    vec3 finalColor = u_ambientColor * u_materialDiffuseColor;

    // Add contribution from global light source
    // (Treating global light as a point light for simplicity here, not a spotlight)
    finalColor += calculateLight(normal, v_worldPosition, u_lightPosition, u_lightColor, 
                                 u_materialDiffuseColor, viewDir, u_materialShininess,
                                 false, vec3(0.0), 0.0, 0.0, 1.0); // Global light is not a spotlight, intensity 1.0


    // Add contribution from flashlight if it's on
    if (u_isFlashlightOn) {
        finalColor += calculateLight(normal, v_worldPosition, u_flashlightPosition, u_flashlightColor,
                                     u_materialDiffuseColor, viewDir, u_materialShininess,
                                     true, u_flashlightDirection, u_flashlightConeCos, u_flashlightOuterConeCos, u_flashlightIntensity);
    }
    
    // Clamp final color to avoid over-saturation, though HDR might be better in a full engine
    finalColor = clamp(finalColor, 0.0, 1.0);

    // Apply Fog
    float distanceToCamera = length(v_worldPosition - u_cameraPosition);
    float fogFactor = smoothstep(u_fogStartDistance, u_fogEndDistance, distanceToCamera);
    finalColor = mix(finalColor, u_fogColor, fogFactor);
    
    // Final clamp might be redundant if already done, but safe.
    finalColor = clamp(finalColor, 0.0, 1.0); 

    gl_FragColor = vec4(finalColor, 1.0); // Assuming creature alpha is 1.0
}
