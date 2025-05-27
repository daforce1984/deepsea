import { mat4 as _mat4, vec3 as _vec3, quat as _quat, mat3 as _mat3 } from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.3/+esm';

const glMatrix = {
    mat4: _mat4,
    vec3: _vec3,
    quat: _quat,
    mat3: _mat3
};

// End of Embedded gl-matrix functions

// main.js
// gl-matrix.js is expected to be loaded via CDN (see index.html)
// If glMatrix is not defined, 3D operations will fail.

let gl;

// Particle System Variables
const MAX_PARTICLES = 25000;
let activeParticles = [];
const PARTICLE_TYPE = { DUST: 0, BUBBLE: 1 };

const DUST_BOX_SIZE_X = 5.0; // Width of the dust box (meters)
const DUST_BOX_SIZE_Y = 3.0; // Height
const DUST_BOX_SIZE_Z = 7.0; // Depth (how far in front/behind camera)
const TARGET_DUST_PARTICLES_IN_BOX = 20000; // Desired number of dust particles

let particleShaderProgram;
let particleVertexBufferGL; // VBO for a unit quad
let aParticleQuadVertexLoc; // Attribute for particle shader's a_particle_quad_vertex
let uParticleWorldPosLoc, uParticleColorLoc, uParticleSizeLoc;
let uParticleViewMatrixLoc, uParticleProjectionMatrixLoc; // For shader

// Global Attribute Locations (as per subtask)
let seaboxPositionAttributeLocation;
let creaturePosAttrLoc; // For creature shader's a_creature_position
// aCreatureVertexNormalLoc is already global (line 221 of previous file)
// aParticleQuadVertexLoc is already global (line 156 of previous file)

// Framebuffer Object (FBO) for Occlusion Texture (Flashlight Spot)
let occlusionFBO;
let occlusionTexture;
let lightSpotShaderProgram; // For rendering the flashlight spot into the occlusion texture
let uLightSpot_ViewProjectionMatrixLoc; // For positioning the spot (added as per prompt)
let uLightSpot_ColorLoc; // For spot color/intensity
let uLightSpot_AspectRatioLoc; // For shaping the spot
let lightSpotQuadVBO; // VBO for a simple quad

// God Ray Shader Global Variables
let godRayShaderProgram;
let uOcclusionTextureLoc, uLightScreenPosLoc;
let uGodRayNumSamplesLoc, uGodRayDecayLoc, uGodRayExposureLoc, uGodRayDensityLoc, uGodRayWeightLoc; // New uniform locations
let uSceneDepthTextureLoc, uCameraNearLoc, uCameraFarLoc; // For depth interaction in god rays
// We can reuse lightSpotQuadVBO for the fullscreen quad

// Scene Framebuffer Object (FBO) for rendering the main scene to texture
let sceneFBO;
let sceneColorTexture;
let sceneDepthTexture;

// Shader for simple texture pass-through (rendering sceneColorTexture to canvas)
let texturePassThruShaderProgram;
// let uTexturePassThruSamplerLoc; // Will be replaced by texturePassThruTextureLoc
let texturePassThruPosLoc, texturePassThruTexCoordLoc, texturePassThruTextureLoc;
let passThruQuadBuffer; // For vertices and texcoords for the pass-through shader


const godRayParams = { // Default values for god ray parameters
    numSamples: 64, // Integer
    decay: 0.96,
    exposure: 0.15,
    density: 0.9,
    weight: 0.1
};

// Flashlight Model Global Variables
let flashlightModel = { // This will be deprecated by loadedGLBData
    vertices: [],
    normals: [],
    indices: []
};
let flashlightVertexBufferGL, flashlightNormalBufferGL, flashlightIndexBufferGL;

// Global object to store loaded GLB data
let loadedGLBData = {
    vertices: null,
    normals: null,
    indices: null,
    indexType: null // Will store gl.UNSIGNED_SHORT or gl.UNSIGNED_INT
};

// flashlightCubeModel and its buffers were here, now fully removed.

const FLASHLIGHT_MODEL_COLOR = [0.25, 0.25, 0.3, 1.0]; // Dark greyish color

const DUST_COLOR = [0.8, 0.8, 0.7, 0.3]; // Semi-transparent greyish
const BUBBLE_COLOR = [0.7, 0.8, 1.0, 0.2]; // Semi-transparent bluish
const PARTICLE_SPAWN_RATE = 0.5; // Chance to spawn a particle each frame (adjust)

// Camera Rotation Variables
let cameraYaw = -Math.PI / 2; // Initial yaw (looking along -Z)
let cameraPitch = 0;          // Initial pitch
const mouseSensitivity = 0.002;

// Flashlight Variables
let isFlashlightOn = true; // Flashlight is ON by default
const flashlightColor = [1.0, 1.0, 0.9]; // Slightly warm white
const flashlightIntensity = 1.5;          // Multiplier for flashlight brightness
const flashlightConeAngle = 25.0 * Math.PI / 180; // Inner cone angle (degrees to radians)
const flashlightOuterConeAngle = 30.0 * Math.PI / 180; // Outer cone for penumbra/falloff

// Uniform locations for flashlight (in creatureShaderProgram)
let uIsFlashlightOnLoc, uFlashlightPosLoc, uFlashlightDirLoc, uFlashlightColorLoc;
let uFlashlightIntensityLoc, uFlashlightConeCosLoc, uFlashlightOuterConeCosLoc;

// Fog uniform locations (for creatureShaderProgram)
let uFogColorLoc, uFogStartDistanceLoc, uFogEndDistanceLoc;

// Lighting and new uniform/attribute locations
let uCreatureModelMatrixLoc, uCreatureViewMatrixLoc, uCreatureProjectionMatrixLoc;
let uMaterialDiffuseColorLoc, uLightPositionLoc, uLightColorLoc, uCameraPositionLoc, uMaterialShininessLoc, uAmbientColorLoc;
let aCreatureVertexNormalLoc; // Attribute location for normals

const lightPosition = [50.0, 50.0, 100.0]; // Example static light position in world space
const lightColor = [0.01, 0.01, 0.01];       // White light
const ambientLightColor = [0.2, 0.2, 0.3]; // Dim ambient bluish light
const materialShininess = 32.0;
let canvas;

// 3D Camera and Projection
let projectionMatrix;
let viewMatrix;
let cameraPosition = [0, 0, 0]; // Initial camera position (x, y, z). Y is altitude. Start at surface.
let cameraTarget = [0, 0, -1]; // What the camera is looking at (initially down the Z axis)
const upVector = [0, 1, 0];    // Up direction for the camera

// Field of view for perspective projection
const fieldOfView = 45 * Math.PI / 180; // in radians
let aspect; // Calculated in window.onload or resize
const zNear = 0.1;
const zFar = 10000.0; // Increased zFar for large underwater scenes

// Background Shader Uniform Locations
let uBackgroundProjectionMatrixLoc;
let uBackgroundViewMatrixLoc;
let uBackgroundDepthLoc; // Specific for background shader's u_depth uniform (old, for normalized depth)
let uActualDepthMetersLoc; // New uniform for actual depth in meters

let seaboxVertexBuffer;
const seaboxVertices = [
    // Front face
    -1.0, -1.0,  1.0,
     1.0, -1.0,  1.0,
     1.0,  1.0,  1.0,
    -1.0,  1.0,  1.0,
    // Back face
    -1.0, -1.0, -1.0,
    -1.0,  1.0, -1.0,
     1.0,  1.0, -1.0,
     1.0, -1.0, -1.0,
    // Top face
    -1.0,  1.0, -1.0,
    -1.0,  1.0,  1.0,
     1.0,  1.0,  1.0,
     1.0,  1.0, -1.0,
    // Bottom face
    -1.0, -1.0, -1.0,
     1.0, -1.0, -1.0,
     1.0, -1.0,  1.0,
    -1.0, -1.0,  1.0,
    // Right face
     1.0, -1.0, -1.0,
     1.0,  1.0, -1.0,
     1.0,  1.0,  1.0,
     1.0, -1.0,  1.0,
    // Left face
    -1.0, -1.0, -1.0,
    -1.0, -1.0,  1.0,
    -1.0,  1.0,  1.0,
    -1.0,  1.0, -1.0,
];
const seaboxIndices = [
    0,  1,  2,    0,  2,  3,    // front
    4,  5,  6,    4,  6,  7,    // back
    8,  9, 10,    8, 10, 11,   // top
    12, 13, 14,   12, 14, 15,   // bottom
    16, 17, 18,   16, 18, 19,   // right
    20, 21, 22,   20, 22, 23,   // left
];
let seaboxIndexBuffer;

let backgroundShaderProgram; // Renamed from shaderProgram
let positionBuffer; // This was for the old 2D quad, potentially unused
let uResolutionLocation; // Still used by background fragment shader for u_depth calc
let uDepthLocation; // This is the OLD global uDepthLocation, ensure it's correctly handled or removed if replaced by uBackgroundDepthLoc
const MAX_DEPTH_FOR_COLOR_TRANSITION = 4000; // meters for full darkness

let creatureShaderProgram;
let creaturePositionBuffer; // A buffer to hold vertices for all creature types (or one per type)

// Uniform locations for creature shader
let uCreatureResolutionLocation;
let uCreatureTranslationLocation;
let uCreatureScaleLocation;
let uCreatureColorLocation;
let uCreatureCurrentDepthLocation; // For adjusting y-position in vertex shader

const SPAWN_INTERVAL_DEPTH = 100; // Spawn new creatures roughly every X meters of descent
let lastSpawnDepth = 0;

let currentAltitude = 0; // meters, sea level
const descentSpeedKmh = 5; // km/h
const descentSpeedMps = ((descentSpeedKmh * 1000) / 3600) * 10; // meters per second (10x speed for demo)
let lastTimestamp = 0; // for calculating delta time

// Get references to the HTML elements for displaying info
let altitudeDisplay;
let speedDisplay;

// Shader utility functions
function loadShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('An error occurred compiling the shaders: ' + gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function initShaderProgram(gl, vsSource, fsSource) {
    const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vsSource);
    const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, fsSource);

    const shaderProgram = gl.createProgram();
    gl.attachShader(shaderProgram, vertexShader);
    gl.attachShader(shaderProgram, fragmentShader);
    gl.linkProgram(shaderProgram);

    if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
        console.error('Unable to initialize the shader program: ' + gl.getProgramInfoLog(shaderProgram));
        return null;
    }
    return shaderProgram;
}

async function loadGLB(filePath) {
    try {
        const response = await fetch(filePath);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();

        const dataView = new DataView(arrayBuffer);
        const magic = dataView.getUint32(0, true); // Little-endian
        if (magic !== 0x46546C67) { // 'glTF'
            console.error('Invalid GLB magic string.');
            return;
        }

        const version = dataView.getUint32(4, true);
        if (version !== 2) {
            console.warn(`GLB version is ${version}, expected 2. Attempting to parse anyway.`);
        }
        // const totalLength = dataView.getUint32(8, true); // Not strictly needed for this parser

        let chunkOffset = 12; // Start after header
        let jsonContent, binBuffer;

        while (chunkOffset < arrayBuffer.byteLength) {
            const chunkLength = dataView.getUint32(chunkOffset, true);
            chunkOffset += 4;
            const chunkType = dataView.getUint32(chunkOffset, true);
            chunkOffset += 4;

            if (chunkType === 0x4E4F534A) { // JSON
                const jsonChunk = new Uint8Array(arrayBuffer, chunkOffset, chunkLength);
                const jsonString = new TextDecoder('utf-8').decode(jsonChunk);
                jsonContent = JSON.parse(jsonString);
            } else if (chunkType === 0x004E4942) { // BIN
                binBuffer = arrayBuffer.slice(chunkOffset, chunkOffset + chunkLength);
            }
            chunkOffset += chunkLength;
        }

        if (!jsonContent || !binBuffer) {
            console.error('GLB parsing error: JSON or BIN chunk not found.');
            return;
        }

        // Assuming the first mesh and its first primitive
        const mesh = jsonContent.meshes[0];
        const primitive = mesh.primitives[0];

        // Accessor component type mapping
        const componentTypeMap = {
            5120: Int8Array,    // BYTE
            5121: Uint8Array,   // UNSIGNED_BYTE
            5122: Int16Array,   // SHORT
            5123: Uint16Array,  // UNSIGNED_SHORT
            5125: Uint32Array,  // UNSIGNED_INT
            5126: Float32Array  // FLOAT
        };
        const componentsPerType = {
            'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT2': 4, 'MAT3': 9, 'MAT4': 16
        };

        function getAccessorData(accessorIndex) {
            const accessor = jsonContent.accessors[accessorIndex];
            const bufferView = jsonContent.bufferViews[accessor.bufferView];
            const componentType = componentTypeMap[accessor.componentType];
            const numComponents = componentsPerType[accessor.type];
            const count = accessor.count; // Number of elements (e.g., number of VEC3s)
            
            const byteOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
            // byteLength for this accessor's data within the bufferView
            // const byteLength = accessor.count * numComponents * componentType.BYTES_PER_ELEMENT; 
            // Note: Using bufferView.byteLength is more robust if accessor doesn't span the whole view.
            // However, for this case, we will extract based on accessor.count and component size.

            const data = new componentType(binBuffer, byteOffset, count * numComponents);
            return data;
        }

        const positionAccessorIndex = primitive.attributes.POSITION;
        const normalAccessorIndex = primitive.attributes.NORMAL;
        const indicesAccessorIndex = primitive.indices;

        loadedGLBData.vertices = getAccessorData(positionAccessorIndex);
        loadedGLBData.normals = getAccessorData(normalAccessorIndex);
        loadedGLBData.indices = getAccessorData(indicesAccessorIndex);
        
        // Ensure indices are of the correct type for drawElements (Uint16Array or Uint32Array)
        // The getAccessorData function already returns the correct TypedArray based on componentType.
        // For example, if indices are UNSIGNED_SHORT (5123), it will return Uint16Array.
        // If they are UNSIGNED_INT (5125), it will return Uint32Array.
        // WebGL requires indices to be Uint16Array or Uint32Array (with OES_element_index_uint extension for the latter).
        const indicesAccessor = jsonContent.accessors[indicesAccessorIndex];
        if (indicesAccessor.componentType === 5123) { // UNSIGNED_SHORT
            loadedGLBData.indexType = gl.UNSIGNED_SHORT;
        } else if (indicesAccessor.componentType === 5125) { // UNSIGNED_INT
            loadedGLBData.indexType = gl.UNSIGNED_INT;
            // Check for OES_element_index_uint extension if using UNSIGNED_INT
            if (!gl.getExtension('OES_element_index_uint')) {
                console.warn("OES_element_index_uint extension not supported. GLB indices might not render correctly if they are UNSIGNED_INT.");
            }
        } else {
            console.error("Unsupported index component type:", indicesAccessor.componentType);
            // Fallback or throw error
            loadedGLBData.indexType = gl.UNSIGNED_SHORT; // Default fallback
        }


        console.log('GLB loaded and parsed:', loadedGLBData);

    } catch (error) {
        console.error('Error loading or parsing GLB:', error);
        loadedGLBData.vertices = new Float32Array(0); // Empty arrays as fallback
        loadedGLBData.normals = new Float32Array(0);
        loadedGLBData.indices = new Uint16Array(0);
        loadedGLBData.indexType = gl.UNSIGNED_SHORT;
    }
}

// function generateCylinder(radius, height, segments) { // REMOVED
//     let vertices = []; let normals = []; let indices = [];
//     const halfHeight = height / 2;

//     // Side vertices and normals
//     for (let i = 0; i <= segments; i++) {
//         const angle = (i / segments) * Math.PI * 2;
//         const x = Math.cos(angle) * radius; 
//         const z = Math.sin(angle) * radius;
//         vertices.push(x, halfHeight, z); normals.push(x/radius, 0, z/radius);
//         vertices.push(x, -halfHeight, z); normals.push(x/radius, 0, z/radius);
//     }
//     // Side indices
//     for (let i = 0; i < segments; i++) {
//         const p1 = i * 2;     const p2 = i * 2 + 1;
//         const p3 = (i + 1) * 2; const p4 = (i + 1) * 2 + 1;
//         indices.push(p1, p2, p3);
//         indices.push(p3, p2, p4);
//     }

//     // Caps
//     const capVertexBaseIndex = vertices.length / 3; 

//     // Top Cap
//     vertices.push(0, halfHeight, 0); 
//     normals.push(0, 1, 0);
//     const topCenterIdx = capVertexBaseIndex;
//     for (let i = 0; i <= segments; i++) { 
//         const angle = (i / segments) * Math.PI * 2;
//         const x = Math.cos(angle) * radius; const z = Math.sin(angle) * radius;
//         vertices.push(x, halfHeight, z); normals.push(0, 1, 0);
//     }
//     for (let i = 0; i < segments; i++) {
//         indices.push(topCenterIdx, capVertexBaseIndex + 1 + i, capVertexBaseIndex + 1 + i + 1);
//     }

//     // Bottom Cap
//     const bottomCapBaseIndex = vertices.length / 3; 
//     vertices.push(0, -halfHeight, 0); 
//     normals.push(0, -1, 0);
//     const bottomCenterIdx = bottomCapBaseIndex;
//     for (let i = 0; i <= segments; i++) { 
//         const angle = (i / segments) * Math.PI * 2;
//         const x = Math.cos(angle) * radius; const z = Math.sin(angle) * radius;
//         vertices.push(x, -halfHeight, z); normals.push(0, -1, 0);
//     }
//     for (let i = 0; i < segments; i++) {
//         indices.push(bottomCenterIdx, bottomCapBaseIndex + 1 + i + 1, bottomCapBaseIndex + 1 + i); 
//     }
//     return { vertices, normals, indices };
// }
function generateCylinder(radius, height, segments) { // Keep for creatures if needed, or remove if unused.
    // ... (original cylinder code, if still needed by other parts of the application)
    // For now, assuming it might be used by something else, so not removing its body.
    // If it's confirmed to be unused, the entire function can be removed.
    // For this subtask, we are only removing its call for flashlightModel.
    let vertices = []; let normals = []; let indices = [];
    const halfHeight = height / 2;

    // Side vertices and normals
    for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const x = Math.cos(angle) * radius; 
        const z = Math.sin(angle) * radius;
        vertices.push(x, halfHeight, z); normals.push(x/radius, 0, z/radius);
        vertices.push(x, -halfHeight, z); normals.push(x/radius, 0, z/radius);
    }
    // Side indices
    for (let i = 0; i < segments; i++) {
        const p1 = i * 2;     const p2 = i * 2 + 1;
        const p3 = (i + 1) * 2; const p4 = (i + 1) * 2 + 1;
        indices.push(p1, p2, p3);
        indices.push(p3, p2, p4);
    }

    // Caps
    const capVertexBaseIndex = vertices.length / 3; 

    // Top Cap
    vertices.push(0, halfHeight, 0); 
    normals.push(0, 1, 0);
    const topCenterIdx = capVertexBaseIndex;
    for (let i = 0; i <= segments; i++) { 
        const angle = (i / segments) * Math.PI * 2;
        const x = Math.cos(angle) * radius; const z = Math.sin(angle) * radius;
        vertices.push(x, halfHeight, z); normals.push(0, 1, 0);
    }
    for (let i = 0; i < segments; i++) {
        indices.push(topCenterIdx, capVertexBaseIndex + 1 + i, capVertexBaseIndex + 1 + i + 1);
    }

    // Bottom Cap
    const bottomCapBaseIndex = vertices.length / 3; 
    vertices.push(0, -halfHeight, 0); 
    normals.push(0, -1, 0);
    const bottomCenterIdx = bottomCapBaseIndex;
    for (let i = 0; i <= segments; i++) { 
        const angle = (i / segments) * Math.PI * 2;
        const x = Math.cos(angle) * radius; const z = Math.sin(angle) * radius;
        vertices.push(x, -halfHeight, z); normals.push(0, -1, 0);
    }
    for (let i = 0; i < segments; i++) {
        indices.push(bottomCenterIdx, bottomCapBaseIndex + 1 + i + 1, bottomCapBaseIndex + 1 + i); 
    }
    return { vertices, normals, indices };
}
    let vertices = []; let normals = []; let indices = [];
    const halfHeight = height / 2;

    // Side vertices and normals
    for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const x = Math.cos(angle) * radius; 
        const z = Math.sin(angle) * radius;
        vertices.push(x, halfHeight, z); normals.push(x/radius, 0, z/radius);
        vertices.push(x, -halfHeight, z); normals.push(x/radius, 0, z/radius);
    }
    // Side indices
    for (let i = 0; i < segments; i++) {
        const p1 = i * 2;     const p2 = i * 2 + 1;
        const p3 = (i + 1) * 2; const p4 = (i + 1) * 2 + 1;
        indices.push(p1, p2, p3);
        indices.push(p3, p2, p4);
    }

    // Caps
    const capVertexBaseIndex = vertices.length / 3; 

    // Top Cap
    vertices.push(0, halfHeight, 0); 
    normals.push(0, 1, 0);
    const topCenterIdx = capVertexBaseIndex;
    for (let i = 0; i <= segments; i++) { 
        const angle = (i / segments) * Math.PI * 2;
        const x = Math.cos(angle) * radius; const z = Math.sin(angle) * radius;
        vertices.push(x, halfHeight, z); normals.push(0, 1, 0);
    }
    for (let i = 0; i < segments; i++) {
        indices.push(topCenterIdx, capVertexBaseIndex + 1 + i, capVertexBaseIndex + 1 + i + 1);
    }

    // Bottom Cap
    const bottomCapBaseIndex = vertices.length / 3; 
    vertices.push(0, -halfHeight, 0); 
    normals.push(0, -1, 0);
    const bottomCenterIdx = bottomCapBaseIndex;
    for (let i = 0; i <= segments; i++) { 
        const angle = (i / segments) * Math.PI * 2;
        const x = Math.cos(angle) * radius; const z = Math.sin(angle) * radius;
        vertices.push(x, -halfHeight, z); normals.push(0, -1, 0);
    }
    for (let i = 0; i < segments; i++) {
        indices.push(bottomCenterIdx, bottomCapBaseIndex + 1 + i + 1, bottomCapBaseIndex + 1 + i); 
    }
    return { vertices, normals, indices };
}

// Creature Definitions
const creatures = {
    SHARK: 'shark',
    OCTOPUS: 'octopus',
    WHALE: 'whale'
};

// Store vertex data for each creature type.
// All creatures are now 3D cubes with normals and indices.
// The generateCylinder function might be used here or for other future shapes.
const creatureShapes = {
    [creatures.SHARK]: { // Will be a cube
        vertices: [ // Cube vertices (a 1x1x1 cube centered at origin)
            // Front face
            -0.5, -0.5,  0.5,   0.5, -0.5,  0.5,   0.5,  0.5,  0.5,  -0.5,  0.5,  0.5,
            // Back face
            -0.5, -0.5, -0.5,  -0.5,  0.5, -0.5,   0.5,  0.5, -0.5,   0.5, -0.5, -0.5,
            // Top face
            -0.5,  0.5, -0.5,  -0.5,  0.5,  0.5,   0.5,  0.5,  0.5,   0.5,  0.5, -0.5,
            // Bottom face
            -0.5, -0.5, -0.5,   0.5, -0.5, -0.5,   0.5, -0.5,  0.5,  -0.5, -0.5,  0.5,
            // Right face
             0.5, -0.5, -0.5,   0.5,  0.5, -0.5,   0.5,  0.5,  0.5,   0.5, -0.5,  0.5,
            // Left face
            -0.5, -0.5, -0.5,  -0.5, -0.5,  0.5,  -0.5,  0.5,  0.5,  -0.5,  0.5, -0.5,
        ],
        normals: [ // Normals for each vertex, corresponding to the faces
            // Front
             0.0,  0.0,  1.0,   0.0,  0.0,  1.0,   0.0,  0.0,  1.0,   0.0,  0.0,  1.0,
            // Back
             0.0,  0.0, -1.0,   0.0,  0.0, -1.0,   0.0,  0.0, -1.0,   0.0,  0.0, -1.0,
            // Top
             0.0,  1.0,  0.0,   0.0,  1.0,  0.0,   0.0,  1.0,  0.0,   0.0,  1.0,  0.0,
            // Bottom
             0.0, -1.0,  0.0,   0.0, -1.0,  0.0,   0.0, -1.0,  0.0,   0.0, -1.0,  0.0,
            // Right
             1.0,  0.0,  0.0,   1.0,  0.0,  0.0,   1.0,  0.0,  0.0,   1.0,  0.0,  0.0,
            // Left
            -1.0,  0.0,  0.0,  -1.0,  0.0,  0.0,  -1.0,  0.0,  0.0,  -1.0,  0.0,  0.0,
        ],
        indices: [
            0,  1,  2,    0,  2,  3,    // Front
            4,  5,  6,    4,  6,  7,    // Back
            8,  9, 10,    8, 10, 11,   // Top
            12, 13, 14,   12, 14, 15,   // Bottom
            16, 17, 18,   16, 18, 19,   // Right
            20, 21, 22,   20, 22, 23,   // Left
        ],
        color: [0.5, 0.5, 0.5, 1.0], // Grey for shark cube
        scale: 30 // Base size, now in 3D units
    },
    [creatures.OCTOPUS]: { 
        vertices: [ -0.5, -0.5,  0.5,   0.5, -0.5,  0.5,   0.5,  0.5,  0.5,  -0.5,  0.5,  0.5, -0.5, -0.5, -0.5,  -0.5,  0.5, -0.5,   0.5,  0.5, -0.5,   0.5, -0.5, -0.5, -0.5,  0.5, -0.5,  -0.5,  0.5,  0.5,   0.5,  0.5,  0.5,   0.5,  0.5, -0.5, -0.5, -0.5, -0.5,   0.5, -0.5, -0.5,   0.5, -0.5,  0.5,  -0.5, -0.5,  0.5,  0.5, -0.5, -0.5,   0.5,  0.5, -0.5,   0.5,  0.5,  0.5,   0.5, -0.5,  0.5, -0.5, -0.5, -0.5,  -0.5, -0.5,  0.5,  -0.5,  0.5,  0.5,  -0.5,  0.5, -0.5, ],
        normals:  [  0.0,  0.0,  1.0,   0.0,  0.0,  1.0,   0.0,  0.0,  1.0,   0.0,  0.0,  1.0,  0.0,  0.0, -1.0,   0.0,  0.0, -1.0,   0.0,  0.0, -1.0,   0.0,  0.0, -1.0,  0.0,  1.0,  0.0,   0.0,  1.0,  0.0,   0.0,  1.0,  0.0,   0.0,  1.0,  0.0,  0.0, -1.0,  0.0,   0.0, -1.0,  0.0,   0.0, -1.0,  0.0,   0.0, -1.0,  0.0,  1.0,  0.0,  0.0,   1.0,  0.0,  0.0,   1.0,  0.0,  0.0,   1.0,  0.0,  0.0, -1.0,  0.0,  0.0,  -1.0,  0.0,  0.0,  -1.0,  0.0,  0.0,  -1.0,  0.0,  0.0, ],
        indices:  [  0,  1,  2,    0,  2,  3,    4,  5,  6,    4,  6,  7,    8,  9, 10,    8, 10, 11,   12, 13, 14,   12, 14, 15,   16, 17, 18,   16, 18, 19,   20, 21, 22,   20, 22, 23, ],
        color: [0.8, 0.2, 0.2, 1.0], // Reddish for octopus cube
        scale: 25
    },
    [creatures.WHALE]: { 
        vertices: [ -0.5, -0.5,  0.5,   0.5, -0.5,  0.5,   0.5,  0.5,  0.5,  -0.5,  0.5,  0.5, -0.5, -0.5, -0.5,  -0.5,  0.5, -0.5,   0.5,  0.5, -0.5,   0.5, -0.5, -0.5, -0.5,  0.5, -0.5,  -0.5,  0.5,  0.5,   0.5,  0.5,  0.5,   0.5,  0.5, -0.5, -0.5, -0.5, -0.5,   0.5, -0.5, -0.5,   0.5, -0.5,  0.5,  -0.5, -0.5,  0.5,  0.5, -0.5, -0.5,   0.5,  0.5, -0.5,   0.5,  0.5,  0.5,   0.5, -0.5,  0.5, -0.5, -0.5, -0.5,  -0.5, -0.5,  0.5,  -0.5,  0.5,  0.5,  -0.5,  0.5, -0.5, ],
        normals:  [  0.0,  0.0,  1.0,   0.0,  0.0,  1.0,   0.0,  0.0,  1.0,   0.0,  0.0,  1.0,  0.0,  0.0, -1.0,   0.0,  0.0, -1.0,   0.0,  0.0, -1.0,   0.0,  0.0, -1.0,  0.0,  1.0,  0.0,   0.0,  1.0,  0.0,   0.0,  1.0,  0.0,   0.0,  1.0,  0.0,  0.0, -1.0,  0.0,   0.0, -1.0,  0.0,   0.0, -1.0,  0.0,   0.0, -1.0,  0.0,  1.0,  0.0,  0.0,   1.0,  0.0,  0.0,   1.0,  0.0,  0.0,   1.0,  0.0,  0.0, -1.0,  0.0,  0.0,  -1.0,  0.0,  0.0,  -1.0,  0.0,  0.0,  -1.0,  0.0,  0.0, ],
        indices:  [  0,  1,  2,    0,  2,  3,    4,  5,  6,    4,  6,  7,    8,  9, 10,    8, 10, 11,   12, 13, 14,   12, 14, 15,   16, 17, 18,   16, 18, 19,   20, 21, 22,   20, 22, 23, ],
        color: [0.3, 0.4, 0.6, 1.0], // Bluish grey for whale cube
        scale: 80
    }
};

// This array will hold all active creature instances
let activeCreatures = [];

// Buffers for the currently active creature's geometry (will be set before drawing each one)
let creatureVertexBufferGL; // GL buffer for vertices
let creatureNormalBufferGL; // GL buffer for normals
let creatureIndexBufferGL;  // GL buffer for indices

window.onload = async function() { // Make it async
    canvas = document.getElementById('glCanvas');
    if (!canvas) {
        console.error("Canvas element not found!");
        return;
    }

    gl = canvas.getContext('webgl');
    if (!gl) {
        gl = canvas.getContext('experimental-webgl'); // Fallback for older browsers
    }

    if (!gl) {
        console.error("Unable to initialize WebGL. Your browser may not support it.");
        alert("Unable to initialize WebGL. Your browser may not support it.");
        return;
    }

    gl.enable(gl.DEPTH_TEST); // Enable depth testing
    gl.depthFunc(gl.LEQUAL);    // Near things obscure far things

    // Load GLB model for flashlight
    await loadGLB('flashlight.glb');

    // Enable WEBGL_depth_texture extension
    const depthTextureExtension = gl.getExtension('WEBGL_depth_texture');
    if (!depthTextureExtension) {
        console.error("WEBGL_depth_texture extension not available! This is required for sampling the scene depth texture.");
        // alert("WEBGL_depth_texture extension not available! Depth effects may not work."); // Optional
    }

    // Set canvas size
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);

    // Initialize Scene FBO, Color Texture, and Depth Texture
    sceneFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);

    sceneColorTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sceneColorTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneColorTexture, 0);

    sceneDepthTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sceneDepthTexture);
    // For WebGL1, DEPTH_COMPONENT textures are tricky.
    // Using DEPTH_COMPONENT with UNSIGNED_SHORT or UNSIGNED_INT often requires OES_depth_texture extension.
    // For broader compatibility without extensions, one might render depth to an RGBA texture.
    // However, let's try with DEPTH_COMPONENT and check status.
    // Common formats: gl.DEPTH_COMPONENT16 (WebGL2), gl.DEPTH_COMPONENT (needs extension for sampling in GL1)
    // For WebGL 1, if OES_depth_texture is available:
    // gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, canvas.width, canvas.height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null);
    // A more robust WebGL1 approach might involve packing depth into RGBA.
    // For WebGL2, gl.DEPTH_COMPONENT24 or gl.DEPTH_COMPONENT32F are better.
    // Using UNSIGNED_SHORT as per current subtask instructions.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, canvas.width, canvas.height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null); // Changed to UNSIGNED_SHORT
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); // Must be NEAREST for depth
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); // Must be NEAREST for depth
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, sceneDepthTexture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.error("Scene FBO setup failed. Status: 0x" + status.toString(16));
        if (status === gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT) console.error("    Error: FRAMEBUFFER_INCOMPLETE_ATTACHMENT");
        else if (status === gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT) console.error("    Error: FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT");
        else if (status === gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS) console.error("    Error: FRAMEBUFFER_INCOMPLETE_DIMENSIONS (WebGL1: Not a direct enum, but indicates dimension mismatch)");
        else if (status === gl.FRAMEBUFFER_UNSUPPORTED) console.error("    Error: FRAMEBUFFER_UNSUPPORTED");
        // WebGL Specific (from WEBGL_depth_texture or general WebGL spec)
        else if (status === 0x8DAD) console.error("    Error: FRAMEBUFFER_INCOMPLETE_FORMATS_OES (Specific to OES_FB_format_combination, if applicable)"); // FRAMEBUFFER_INCOMPLETE_FORMATS_OES for WebGL1, if using OES extension
        // Common WebGL2 codes, but good for general knowledge as some drivers might report similar issues with different codes in WebGL1
        else if (status === 0x8CDD) console.error("    Error: FRAMEBUFFER_INCOMPLETE_DRAW_BUFFER (Typically WebGL2)"); 
        else if (status === 0x8CDE) console.error("    Error: FRAMEBUFFER_INCOMPLETE_READ_BUFFER (Typically WebGL2)");
        else console.error("    Error: Unknown FBO status code: 0x" + status.toString(16));
        // alert("Scene FBO setup failed. Check console."); // Optional
    } else {
        console.log("Scene FBO setup appears successful.");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); // Unbind sceneFBO

    // Initialize Texture Pass-Thru Shader Program
    const texturePassThruVS = `
        attribute vec2 a_quad_position;
        attribute vec2 a_texCoord;
        varying vec2 v_texCoord;
        void main() {
            gl_Position = vec4(a_quad_position, 0.0, 1.0);
            v_texCoord = a_texCoord;
        }`;

    const texturePassThruFS = `
        precision mediump float;
        varying vec2 v_texCoord;
        uniform sampler2D u_texture;
        void main() {
            gl_FragColor = texture2D(u_texture, v_texCoord);
        }`;
        
    texturePassThruShaderProgram = initShaderProgram(gl, texturePassThruVS, texturePassThruFS);
    if (!texturePassThruShaderProgram) {
        console.error("Failed to initialize texture pass-through shader program!");
        // alert("Critical error: Failed to initialize texture pass-through shader. Scene will not display.");
        // Potentially return or throw an error here to stop execution if this is critical
    } else {
        texturePassThruPosLoc = gl.getAttribLocation(texturePassThruShaderProgram, "a_quad_position");
        texturePassThruTexCoordLoc = gl.getAttribLocation(texturePassThruShaderProgram, "a_texCoord");
        texturePassThruTextureLoc = gl.getUniformLocation(texturePassThruShaderProgram, "u_texture"); // Replaces uTexturePassThruSamplerLoc

        console.log('Texture Pass-Thru Uniforms/Attribs:', {
            pos: texturePassThruPosLoc,
            uv: texturePassThruTexCoordLoc,
            tex: texturePassThruTextureLoc
        });
        console.log("Texture Pass-Thru Shader Program initialized.");
    }

    // Create Fullscreen Quad VBO for the pass-through shader
    const passThruQuadVertices = new Float32Array([
        // positions X, Y,   texCoords U, V
        -1.0, -1.0,   0.0, 0.0,
         1.0, -1.0,   1.0, 0.0,
        -1.0,  1.0,   0.0, 1.0,
         1.0,  1.0,   1.0, 1.0,
    ]);
    passThruQuadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, passThruQuadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, passThruQuadVertices, gl.STATIC_DRAW);


    // Initialize Projection and View Matrices
    aspect = canvas.width / canvas.height;
    projectionMatrix = glMatrix.mat4.create();
    glMatrix.mat4.perspective(projectionMatrix, fieldOfView, aspect, zNear, zFar);

    viewMatrix = glMatrix.mat4.create();
    cameraPosition[1] = currentAltitude; // currentAltitude is 0
    cameraTarget = [cameraPosition[0], cameraPosition[1], cameraPosition[2] - 1]; // Look along -Z
    glMatrix.mat4.lookAt(viewMatrix, cameraPosition, cameraTarget, upVector);

    // Fetch shaders
    let vsSource, fsSource;
    try {
        vsSource = await fetch('vertex-shader.glsl').then(res => res.text());
        fsSource = await fetch('fragment-shader.glsl').then(res => res.text());
    } catch (error) {
        console.error("Failed to fetch shaders:", error);
        alert("Failed to load shaders. Check console for details.");
        return;
    }

    backgroundShaderProgram = initShaderProgram(gl, vsSource, fsSource); // Renamed
    if (!backgroundShaderProgram) { // Renamed
        alert("Failed to initialize background shader program."); // Updated message
        return;
    }
    gl.useProgram(backgroundShaderProgram); // Use the renamed program

    // Get uniform locations for background shader (backgroundShaderProgram)
    uResolutionLocation = gl.getUniformLocation(backgroundShaderProgram, "u_resolution");
    uBackgroundDepthLoc = gl.getUniformLocation(backgroundShaderProgram, "u_depth"); // This assigns to the global uBackgroundDepthLoc
    uBackgroundProjectionMatrixLoc = gl.getUniformLocation(backgroundShaderProgram, "u_projectionMatrix");
    uBackgroundViewMatrixLoc = gl.getUniformLocation(backgroundShaderProgram, "u_viewMatrix");
    uBackgroundDepthLoc = gl.getUniformLocation(backgroundShaderProgram, "u_depth"); // Keep for now if any other shader might use it, or remove if truly unused.
    uActualDepthMetersLoc = gl.getUniformLocation(backgroundShaderProgram, "u_actualDepthMeters"); // Get new uniform location

    console.log('Background Uniform Locations:', { 
        proj: uBackgroundProjectionMatrixLoc, 
        view: uBackgroundViewMatrixLoc, 
        depth_normalized: uBackgroundDepthLoc, // This was for the old u_depth
        actual_depth_meters: uActualDepthMetersLoc 
    });

    // Get and log Sebox Attribute Location
    seaboxPositionAttributeLocation = gl.getAttribLocation(backgroundShaderProgram, "a_position");
    console.log('Seabox Attrib Locations:', { a_position: seaboxPositionAttributeLocation });


    // Create and bind buffers for seabox
    seaboxVertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, seaboxVertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(seaboxVertices), gl.STATIC_DRAW);

    seaboxIndexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, seaboxIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(seaboxIndices), gl.STATIC_DRAW);
    
    // The old positionBuffer and its setup for the 2D quad are no longer needed for the background.
    // The attribute a_position for backgroundShaderProgram will be set up in the render loop for the seabox.

    // Load and compile creature shaders
    try {
        const creatureVsSource = await fetch('creature-vertex-shader.glsl').then(res => res.text());
        const creatureFsSource = await fetch('creature-fragment-shader.glsl').then(res => res.text());
        creatureShaderProgram = initShaderProgram(gl, creatureVsSource, creatureFsSource);
        if (!creatureShaderProgram) {
            alert("Failed to initialize creature shader program.");
            return;
        }
        // Get uniform locations for creature shader
        uCreatureResolutionLocation = gl.getUniformLocation(creatureShaderProgram, "u_resolution");
        uCreatureTranslationLocation = gl.getUniformLocation(creatureShaderProgram, "u_translation");
        uCreatureScaleLocation = gl.getUniformLocation(creatureShaderProgram, "u_scale");
        uCreatureColorLocation = gl.getUniformLocation(creatureShaderProgram, "u_creature_color");
        uCreatureCurrentDepthLocation = gl.getUniformLocation(creatureShaderProgram, "u_current_depth");

    } catch (error) {
        console.error("Failed to fetch creature shaders:", error);
        alert("Failed to load creature shaders. Check console for details.");
        return;
    }
    
    // Initialize a generic buffer for creature vertices. We'll fill it on demand.
    // creaturePositionBuffer = gl.createBuffer(); // This is replaced by individual VBOs below.

    // Create GL buffers for creature geometry (will be filled per creature type in render loop)
    creatureVertexBufferGL = gl.createBuffer();
    creatureNormalBufferGL = gl.createBuffer();
    creatureIndexBufferGL = gl.createBuffer();

    // Get new attribute and uniform locations for creatureShaderProgram
    // Attributes:
    creaturePosAttrLoc = gl.getAttribLocation(creatureShaderProgram, "a_creature_position");
    aCreatureVertexNormalLoc = gl.getAttribLocation(creatureShaderProgram, "a_vertex_normal");
    console.log('Creature Attrib Locations:', { a_creature_position: creaturePosAttrLoc, a_vertex_normal: aCreatureVertexNormalLoc });

    // Uniforms for matrices:
    uCreatureModelMatrixLoc = gl.getUniformLocation(creatureShaderProgram, "u_modelMatrix");
    uCreatureViewMatrixLoc = gl.getUniformLocation(creatureShaderProgram, "u_viewMatrix");
    uCreatureProjectionMatrixLoc = gl.getUniformLocation(creatureShaderProgram, "u_projectionMatrix");

    // Uniforms for lighting:
    uMaterialDiffuseColorLoc = gl.getUniformLocation(creatureShaderProgram, "u_materialDiffuseColor");
    uLightPositionLoc = gl.getUniformLocation(creatureShaderProgram, "u_lightPosition");
    uLightColorLoc = gl.getUniformLocation(creatureShaderProgram, "u_lightColor");
    uCameraPositionLoc = gl.getUniformLocation(creatureShaderProgram, "u_cameraPosition");
    uMaterialShininessLoc = gl.getUniformLocation(creatureShaderProgram, "u_materialShininess");
    uAmbientColorLoc = gl.getUniformLocation(creatureShaderProgram, "u_ambientColor");

    // Old uniform locations (now unused or replaced by matrices/lighting uniforms):
    // uCreatureResolutionLocation (no longer needed for positioning)
    // uCreatureTranslationLocation (handled by modelMatrix)
    // uCreatureScaleLocation (handled by modelMatrix)
    // uCreatureColorLocation (replaced by uMaterialDiffuseColorLoc and lighting)
    // uCreatureCurrentDepthLocation (handled by viewMatrix and modelMatrix)

    // Get Flashlight Uniform Locations (for creatureShaderProgram)
    uIsFlashlightOnLoc = gl.getUniformLocation(creatureShaderProgram, "u_isFlashlightOn");
    uFlashlightPosLoc = gl.getUniformLocation(creatureShaderProgram, "u_flashlightPosition");
    uFlashlightDirLoc = gl.getUniformLocation(creatureShaderProgram, "u_flashlightDirection");
    uFlashlightColorLoc = gl.getUniformLocation(creatureShaderProgram, "u_flashlightColor");
    uFlashlightIntensityLoc = gl.getUniformLocation(creatureShaderProgram, "u_flashlightIntensity");
    uFlashlightConeCosLoc = gl.getUniformLocation(creatureShaderProgram, "u_flashlightConeCos");
    uFlashlightOuterConeCosLoc = gl.getUniformLocation(creatureShaderProgram, "u_flashlightOuterConeCos");

    // Get Fog Uniform Locations (for creatureShaderProgram)
    uFogColorLoc = gl.getUniformLocation(creatureShaderProgram, "u_fogColor");
    uFogStartDistanceLoc = gl.getUniformLocation(creatureShaderProgram, "u_fogStartDistance");
    uFogEndDistanceLoc = gl.getUniformLocation(creatureShaderProgram, "u_fogEndDistance");
    console.log('Fog Uniform Locations:', { 
        color: uFogColorLoc, 
        start: uFogStartDistanceLoc, 
        end: uFogEndDistanceLoc 
    });

    // Initialize Flashlight Model Buffers from loadedGLBData
    // flashlightModel = generateCylinder(1.0, 1.0, 16); // This line was already removed correctly.

    flashlightVertexBufferGL = gl.createBuffer(); // Ensure these are declared globally
    flashlightNormalBufferGL = gl.createBuffer();
    flashlightIndexBufferGL = gl.createBuffer();

    if (loadedGLBData.vertices && loadedGLBData.normals && loadedGLBData.indices) {
        gl.bindBuffer(gl.ARRAY_BUFFER, flashlightVertexBufferGL);
        gl.bufferData(gl.ARRAY_BUFFER, loadedGLBData.vertices, gl.STATIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, flashlightNormalBufferGL);
        gl.bufferData(gl.ARRAY_BUFFER, loadedGLBData.normals, gl.STATIC_DRAW);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, flashlightIndexBufferGL);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, loadedGLBData.indices, gl.STATIC_DRAW);
        console.log("Flashlight GLB data buffered to GPU.");
    } else {
        console.error("Flashlight GLB data not loaded correctly, buffers not set.");
        // As a fallback, you might want to fill with minimal data to prevent WebGL errors
        // For example, a single point or triangle, or just leave them empty if render path handles it.
        // For now, relying on the error console log.
    }

    // All lines related to flashlightCubeVertexBufferGL, flashlightCubeNormalBufferGL, 
    // and flashlightCubeIndexBufferGL buffer creation and data population were here, now fully removed.


    // Basic clear color - might be overridden by shader but good for initial setup
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // --- Initialize Particle Shader and Buffers ---
    try {
        const particleVsSource = await fetch('particle-vertex-shader.glsl').then(res => res.text());
        const particleFsSource = await fetch('particle-fragment-shader.glsl').then(res => res.text());
        particleShaderProgram = initShaderProgram(gl, particleVsSource, particleFsSource);
        if (!particleShaderProgram) { alert("Failed to init particle shaders."); return; }

        aParticleQuadVertexLoc = gl.getAttribLocation(particleShaderProgram, "a_particle_quad_vertex");
        console.log('Particle Attrib Locations:', { a_particle_quad_vertex: aParticleQuadVertexLoc });
        
        uParticleWorldPosLoc = gl.getUniformLocation(particleShaderProgram, "u_particle_world_pos");
        uParticleColorLoc = gl.getUniformLocation(particleShaderProgram, "u_particle_color");
        uParticleSizeLoc = gl.getUniformLocation(particleShaderProgram, "u_particle_size");
        uParticleViewMatrixLoc = gl.getUniformLocation(particleShaderProgram, "u_viewMatrix");
        uParticleProjectionMatrixLoc = gl.getUniformLocation(particleShaderProgram, "u_projectionMatrix");
        
        // Get camera orientation uniforms for billboarding (after using program)
        // Note: These specific getUniformLocation calls for u_camera_right_ws and u_camera_up_ws 
        // are actually better placed in the render loop if they are fetched using gl.getUniformLocation
        // directly before gl.uniform3fv. However, if we store their locations globally (like others),
        // they should be fetched here. The provided plan fetches them in render, so we'll stick to that.
        // For consistency, let's assume they are NOT fetched here but in render, or define global vars for their locations.
        // The subtask description implies they are fetched in render loop before use.

    } catch (error) { console.error("Particle shader fetch error:", error); return; }

    // VBO for a unit quad (2 triangles making a square for each particle)
    // Vertices for a quad from -0.5 to 0.5 in x and y
    const particleQuadVertices = [ -0.5,-0.5,  0.5,-0.5, -0.5, 0.5, -0.5, 0.5,  0.5,-0.5,  0.5, 0.5 ];
    particleVertexBufferGL = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, particleVertexBufferGL);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(particleQuadVertices), gl.STATIC_DRAW);


    // Initialize display elements and timestamp
    altitudeDisplay = document.getElementById('altitude');
    speedDisplay = document.getElementById('speed');

    if (!altitudeDisplay || !speedDisplay) {
        console.error("Info display elements not found!");
        return;
    }

    speedDisplay.textContent = `Descent Speed: ${descentSpeedKmh * 10} km/h (Accelerated for Demo)`;
    lastTimestamp = performance.now();
    lastSpawnDepth = currentAltitude; // Initialize lastSpawnDepth

    console.log("WebGL initialized, shaders compiled, and background quad set up.");

    // --- Initialize FBO, Occlusion Texture, Light Spot Shader, and VBO ---
    occlusionFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, occlusionFBO);

    occlusionTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, occlusionTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, occlusionTexture, 0);

    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        console.error("Framebuffer setup failed: " + gl.checkFramebufferStatus(gl.FRAMEBUFFER));
        alert("Error: Framebuffer setup failed for post-processing.");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const lightSpotVS = `
        attribute vec2 a_quad_pos;
        uniform mat4 u_viewProjectionMatrix; // Though not used for fullscreen screen-space
        varying vec2 v_texCoord;
        void main() {
            gl_Position = vec4(a_quad_pos, 0.0, 1.0); // Fullscreen quad
            v_texCoord = a_quad_pos * 0.5 + 0.5;
        }`;
    const lightSpotFS = `
        precision mediump float;
        varying vec2 v_texCoord;
        uniform vec3 u_light_spot_color;
        uniform float u_aspect_ratio;
        void main() {
            vec2 centered_coord = v_texCoord - vec2(0.5);
            centered_coord.x *= u_aspect_ratio;
            float dist = length(centered_coord);
            float intensity = smoothstep(0.4, 0.05, dist);
            gl_FragColor = vec4(u_light_spot_color * intensity, 1.0);
        }`;
    lightSpotShaderProgram = initShaderProgram(gl, lightSpotVS, lightSpotFS);
    if (lightSpotShaderProgram) {
        uLightSpot_ViewProjectionMatrixLoc = gl.getUniformLocation(lightSpotShaderProgram, "u_viewProjectionMatrix"); // Added fetch
        uLightSpot_ColorLoc = gl.getUniformLocation(lightSpotShaderProgram, "u_light_spot_color");
        uLightSpot_AspectRatioLoc = gl.getUniformLocation(lightSpotShaderProgram, "u_aspect_ratio");
        console.log("Light Spot Shader Program and uniforms initialized.");
    } else {
        console.error("Failed to initialize Light Spot Shader Program.");
    }

    const quadVertices = [-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1];
    lightSpotQuadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, lightSpotQuadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(quadVertices), gl.STATIC_DRAW);
    // --- End FBO and Light Spot Shader Init ---

    // --- Initialize God Ray Shader Program ---
    try {
        const godRayVS_src = await fetch('godray-vertex-shader.glsl').then(res => res.text());
        const godRayFS_src = await fetch('godray-fragment-shader.glsl').then(res => res.text());
        godRayShaderProgram = initShaderProgram(gl, godRayVS_src, godRayFS_src);
        if (!godRayShaderProgram) { alert("Failed to init god ray shaders."); }
        else {
            uOcclusionTextureLoc = gl.getUniformLocation(godRayShaderProgram, "u_occlusionTexture");
            uLightScreenPosLoc = gl.getUniformLocation(godRayShaderProgram, "u_lightScreenPos");
            uGodRayNumSamplesLoc = gl.getUniformLocation(godRayShaderProgram, "u_num_samples");
            uGodRayDecayLoc = gl.getUniformLocation(godRayShaderProgram, "u_decay");
            uGodRayExposureLoc = gl.getUniformLocation(godRayShaderProgram, "u_exposure");
            uGodRayDensityLoc = gl.getUniformLocation(godRayShaderProgram, "u_density");
            uGodRayWeightLoc = gl.getUniformLocation(godRayShaderProgram, "u_weight");
            // Get new uniforms for depth interaction
            uSceneDepthTextureLoc = gl.getUniformLocation(godRayShaderProgram, "u_sceneDepthTexture");
            uCameraNearLoc = gl.getUniformLocation(godRayShaderProgram, "u_cameraNear");
            uCameraFarLoc = gl.getUniformLocation(godRayShaderProgram, "u_cameraFar");
            console.log('GodRay Shader Uniforms:', { 
                u_occlusionTexture: uOcclusionTextureLoc, 
                u_lightScreenPos: uLightScreenPosLoc,
                u_sceneDepthTexture: uSceneDepthTextureLoc,
                u_cameraNear: uCameraNearLoc,
                u_cameraFar: uCameraFarLoc,
                numSamples: uGodRayNumSamplesLoc, 
                decay: uGodRayDecayLoc, 
                exposure: uGodRayExposureLoc, 
                density: uGodRayDensityLoc, 
                weight: uGodRayWeightLoc 
            });
        }
    } catch (error) { console.error("God Ray shader fetch error:", error); }
    // --- End God Ray Shader Program Init ---

    // --- Mouse Click Listener for Flashlight and Pointer Lock ---
    canvas.addEventListener('click', function(event) {
        isFlashlightOn = !isFlashlightOn;
        console.log("Flashlight toggled: ", isFlashlightOn);

        if (!document.pointerLockElement && canvas.requestPointerLock) {
            canvas.requestPointerLock();
        }
    });

    // --- Pointer Lock and Mouse Move Listener for Camera Rotation ---
    function updateCameraOrientation(event) {
        if (document.pointerLockElement === canvas) {
            cameraYaw += event.movementX * mouseSensitivity;
            cameraPitch -= event.movementY * mouseSensitivity;

            // Clamp pitch
            const maxPitch = Math.PI / 2 - 0.01; // Just under 90 degrees
            cameraPitch = Math.max(-maxPitch, Math.min(maxPitch, cameraPitch));

            // Normalize yaw to the range [0, 2*PI)
            cameraYaw = (cameraYaw % (2 * Math.PI) + (2 * Math.PI)) % (2 * Math.PI);
        }
    }

    document.addEventListener('pointerlockchange', () => {
        if (document.pointerLockElement === canvas) {
            document.addEventListener("mousemove", updateCameraOrientation, false);
            // console.log("Pointer locked.");
        } else {
            document.removeEventListener("mousemove", updateCameraOrientation, false);
            // console.log("Pointer unlocked.");
        }
    }, false);

    requestAnimationFrame(render); // Start render loop
};

function spawnParticle(forcedType = null) {
    if (activeParticles.length >= MAX_PARTICLES) return;

    // Ensure all particles are DUST type unless a different type is forced (which is not the case for BUBBLE anymore)
    const type = forcedType !== null ? forcedType : PARTICLE_TYPE.DUST;

    let position = glMatrix.vec3.create();
    let velocity = glMatrix.vec3.create();
    let life;
    let color;
    let size;

    if (type === PARTICLE_TYPE.DUST) {
        position[0] = cameraPosition[0] + (Math.random() - 0.5) * DUST_BOX_SIZE_X;
        position[1] = cameraPosition[1] + (Math.random() - 0.5) * DUST_BOX_SIZE_Y;
        position[2] = cameraPosition[2] + (Math.random() - 0.65) * DUST_BOX_SIZE_Z; // Bias slightly in front

        velocity[0] = (Math.random() - 0.5) * 0.2;
        velocity[1] = (Math.random() - 0.5) * 0.2 - 0.1; // Slight sink
        velocity[2] = (Math.random() - 0.5) * 0.2;
        life = Math.random() * 2.5 + 1.5; // Lifetime 1.5-4 seconds for dust
        size = Math.random() * 0.3 + 0.1; // Adjusted particle size
        color = [...DUST_COLOR]; // Use global DUST_COLOR
        color[3] = 0.0; // Start transparent for fade-in
    // } else { // REMOVE BUBBLE SPAWNING LOGIC - All particles will be dust
        // The properties below were for BUBBLE type, now removed.
        // const spawnVolRadius = 500; 
        // const spawnVolDepth = 1000;
        // position[0] = cameraPosition[0] + (Math.random() - 0.5) * spawnVolRadius * 1; 
        // position[1] = cameraPosition[1] + (Math.random() - 0.5) * spawnVolRadius * 0.5;
        // position[2] = cameraPosition[2] - (Math.random() * spawnVolDepth * 0.5); 

        // velocity[1] = Math.random() * 50 + 30; 
        // velocity[0] = (Math.random() - 0.5) * 10;
        // velocity[2] = (Math.random() - 0.5) * 10;
        // life = Math.random() * 3.0 + 2.0;
        // color = [...BUBBLE_COLOR];
        // size = Math.random() * 5 + 5;
    }
    // Ensure all particles are added with dust properties if the 'else' block was entered previously by a forced BUBBLE type.
    // Since 'type' is now always DUST unless forced otherwise (and BUBBLE is not forced),
    // this re-assignment block ensures consistency if any other PARTICLE_TYPE were to be added later and forced.
    if (type !== PARTICLE_TYPE.DUST && forcedType !== null) {
        // This case should ideally not be hit if only DUST is intended.
        // If a new forcedType (other than DUST) is ever used, it would need its own property definitions.
        // For now, to prevent errors, we can default to DUST properties if somehow reached.
        console.warn(`Particle type ${type} forced, but only DUST properties are defined. Defaulting to DUST properties.`);
        position[0] = cameraPosition[0] + (Math.random() - 0.5) * DUST_BOX_SIZE_X;
        position[1] = cameraPosition[1] + (Math.random() - 0.5) * DUST_BOX_SIZE_Y;
        position[2] = cameraPosition[2] + (Math.random() - 0.65) * DUST_BOX_SIZE_Z;
        velocity[0] = (Math.random() - 0.5) * 0.2;
        velocity[1] = (Math.random() - 0.5) * 0.2 - 0.1;
        velocity[2] = (Math.random() - 0.5) * 0.2;
        life = Math.random() * 2.5 + 1.5;
        size = Math.random() * 1.5 + 0.5;
        color = [...DUST_COLOR];
        color[3] = 0.0; // Start transparent
    }
    
    activeParticles.push({ position, velocity, color, life, type, size, initialLife: life });
}

function updateParticles(deltaTime) {
    for (let i = activeParticles.length - 1; i >= 0; i--) {
        let p = activeParticles[i];
        p.life -= deltaTime;

        // Note: Particle removal is handled later, after alpha updates

        glMatrix.vec3.scaleAndAdd(p.position, p.position, p.velocity, deltaTime);

        // Fade-in/out for Dust Particles & Original Bubble Fade
        if (p.type === PARTICLE_TYPE.DUST) {
            const age = p.initialLife - p.life;
            const fadeInDuration = 0.75; // seconds to fade in
            
            if (age < fadeInDuration) {
                p.color[3] = (age / fadeInDuration) * DUST_COLOR[3];
            } else {
                // Fade out based on remaining life, but start after fadeIn is complete
                if (p.initialLife > fadeInDuration) {
                    p.color[3] = DUST_COLOR[3] * (p.life / (p.initialLife - fadeInDuration));
                } else { // If lifetime is shorter than fade-in, just use full alpha then let it die
                    p.color[3] = DUST_COLOR[3];
                }
            }
        // } else if (p.type === PARTICLE_TYPE.BUBBLE) { // REMOVE BUBBLE ALPHA LOGIC
            // p.color[3] = BUBBLE_COLOR[3] * (p.life / p.initialLife); 
        }
        // Clamp alpha - now only DUST_COLOR[3] is relevant for the max alpha
        p.color[3] = Math.max(0.0, Math.min(p.color[3], DUST_COLOR[3]));


        // Clipping/Fading at Box Edges for Dust Particles
        // This logic remains as it's specific to DUST type, which is now the only type.
        if (p.type === PARTICLE_TYPE.DUST) {
            const halfBoxX = DUST_BOX_SIZE_X / 2.0;
            const halfBoxY = DUST_BOX_SIZE_Y / 2.0;
            const halfBoxZ = DUST_BOX_SIZE_Z / 2.0;
            const localPos = glMatrix.vec3.subtract([], p.position, cameraPosition);
            
            let outsideFactor = 0.0;
            const fadeOutMargin = 0.75; // meters, how far outside before fully transparent

            if (Math.abs(localPos[0]) > halfBoxX) {
                outsideFactor = Math.max(outsideFactor, (Math.abs(localPos[0]) - halfBoxX) / fadeOutMargin);
            }
            if (Math.abs(localPos[1]) > halfBoxY) {
                outsideFactor = Math.max(outsideFactor, (Math.abs(localPos[1]) - halfBoxY) / fadeOutMargin);
            }
            if (Math.abs(localPos[2]) > halfBoxZ) { // Assumes camera is at the center of the box for Z
                outsideFactor = Math.max(outsideFactor, (Math.abs(localPos[2]) - halfBoxZ) / fadeOutMargin);
            }

            if (outsideFactor > 0.0) {
                p.color[3] *= (1.0 - Math.min(1.0, outsideFactor));
            }

            if (outsideFactor > 1.0 || p.color[3] < 0.01) {
                p.life = Math.min(p.life, 0.05); // Kill particle quickly if far out or fully faded
            }
        }
        
        if (p.life <= 0) {
            activeParticles.splice(i, 1);
            continue;
        }
        
        // Optional: Bubbles expand slightly? (Original comment, can be kept or removed)
        // if (p.type === PARTICLE_TYPE.BUBBLE) p.size *= (1 + deltaTime * 0.1);
    }
}

function spawnCreature() {
    // Define spawn volume dimensions (world units)
    const spawnRangeX = 800; // Spawn within +/- 400 units from camera's X track
    const spawnRangeZForward = 1500; // Spawn up to 1500 units in front (more negative Z)

    // Spawn relative to camera's current XZ plane position
    const spawnX = cameraPosition[0] + (Math.random() - 0.5) * spawnRangeX;
    const spawnDepthY = cameraPosition[1]; // Spawn at current camera depth (Y)
    const spawnZ = cameraPosition[2] - (Math.random() * spawnRangeZForward); // Spawn in -Z direction from camera


    let creatureType;
    const randType = Math.random();
    const currentDepthPositive = Math.abs(cameraPosition[1]); // Based on camera's Y

    if (currentDepthPositive > 500 && currentDepthPositive < 1500 && randType < 0.33) {
        creatureType = creatures.SHARK;
    } else if (currentDepthPositive > 1000 && currentDepthPositive < 2500 && randType < 0.66) {
        creatureType = creatures.OCTOPUS;
    } else if (currentDepthPositive > 2000 && currentDepthPositive < 3800) {
        creatureType = creatures.WHALE;
    } else {
        return;
    }
    
    if (creatureType) {
        // console.log(`Spawning ${creatureType} at depth ${Math.round(spawnDepthY)}m, pos: (${Math.round(spawnX)}, ${Math.round(spawnDepthY)}, ${Math.round(spawnZ)})`);
        activeCreatures.push({
            type: creatureType,
            x: spawnX,
            y: spawnDepthY,
            z: spawnZ,
            definition: creatureShapes[creatureType]
        });
    }
}

function render(timestamp) {
    // In render function, at the very beginning:
    if (isFlashlightOn && occlusionFBO && lightSpotShaderProgram && lightSpotQuadVBO && uLightSpot_ColorLoc && uLightSpot_AspectRatioLoc) { // Check all required components
        gl.bindFramebuffer(gl.FRAMEBUFFER, occlusionFBO);
        // The viewport for the FBO should match the occlusionTexture dimensions, which are canvas.width/height
        gl.viewport(0, 0, canvas.width, canvas.height); 
        
        gl.clearColor(0.0, 0.0, 0.0, 1.0); // Clear occlusion texture to black
        gl.clear(gl.COLOR_BUFFER_BIT); // Only need to clear color, depth not used for this texture

        gl.useProgram(lightSpotShaderProgram);

        // Set uniforms for the light spot shader
        gl.uniform3fv(uLightSpot_ColorLoc, [1.0, 1.0, 0.9]); // Bright spot color
        gl.uniform1f(uLightSpot_AspectRatioLoc, canvas.width / canvas.height);

        const quadPosLoc = gl.getAttribLocation(lightSpotShaderProgram, "a_quad_pos");
        if (quadPosLoc !== -1) {
            gl.bindBuffer(gl.ARRAY_BUFFER, lightSpotQuadVBO);
            gl.vertexAttribPointer(quadPosLoc, 2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(quadPosLoc);
            gl.drawArrays(gl.TRIANGLES, 0, 6); // Draw fullscreen quad for the spot
            gl.disableVertexAttribArray(quadPosLoc); 
        }
        
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); // Unbind FBO, back to default framebuffer for main scene rendering
        // Reset viewport to draw to the main canvas (if it was different, though here it's the same)
        // gl.viewport(0, 0, gl.canvas.width, gl.canvas.height); // Not strictly needed if FBO viewport was full canvas
    } else if (occlusionFBO) { // If flashlight is off, but FBO exists
        // Ensure occlusion texture is cleared to black
        gl.bindFramebuffer(gl.FRAMEBUFFER, occlusionFBO);
        gl.viewport(0, 0, canvas.width, canvas.height); // Match texture dimensions
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // ... rest of the existing render function (main canvas clearing, seabox, creatures, particles, etc.)

    // 1. Bind Scene FBO to render the main scene to texture
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
    gl.viewport(0, 0, canvas.width, canvas.height); // Ensure viewport matches FBO textures
    gl.clearColor(0.0, 0.0, 0.0, 1.0); // Clear scene FBO (background color for the scene texture)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // Note: Depth buffer for sceneFBO is cleared here.

    const deltaTime = (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;

    // Update camera position for descent
    cameraPosition[1] -= descentSpeedMps * deltaTime;
    currentAltitude = cameraPosition[1]; // Keep currentAltitude in sync

    // Calculate new forward vector from yaw and pitch
    let forward = glMatrix.vec3.create();
    forward[0] = Math.cos(cameraPitch) * Math.cos(cameraYaw);
    forward[1] = Math.sin(cameraPitch);
    forward[2] = Math.cos(cameraPitch) * Math.sin(cameraYaw);
    glMatrix.vec3.normalize(forward, forward);

    // Update cameraTarget
    glMatrix.vec3.add(cameraTarget, cameraPosition, forward);

    // Update view matrix using the new cameraPosition and cameraTarget
    if (viewMatrix && typeof glMatrix !== 'undefined') {
        glMatrix.mat4.lookAt(viewMatrix, cameraPosition, cameraTarget, upVector);
    }

    if (altitudeDisplay) {
        // Display depth as a positive value. cameraPosition[1] is negative during descent.
        let depthValue = Math.abs(Math.round(cameraPosition[1]));
        altitudeDisplay.textContent = `Depth: ${depthValue} m`;
    }

    // Check for spawning new creatures
    if (Math.abs(currentAltitude) - Math.abs(lastSpawnDepth) > SPAWN_INTERVAL_DEPTH) {
        if (Math.random() < 0.7) { // 70% chance to spawn when interval is crossed
            spawnCreature();
        }
        lastSpawnDepth = currentAltitude; // Update last spawn depth marker
    }

    // // Clear the canvas // This is now done for the FBO above.
    // gl.clearColor(0.0, 0.0, 0.0, 1.0); 
    // gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // --- Render Sebox Background (to sceneFBO) ---
    gl.depthMask(false); // Disable depth writing for skybox (standard practice for skyboxes)
    gl.useProgram(backgroundShaderProgram); // Use the renamed background shader program

    // Set camera/projection uniforms for background shader
    gl.uniformMatrix4fv(uBackgroundProjectionMatrixLoc, false, projectionMatrix); // Uses global
    gl.uniformMatrix4fv(uBackgroundViewMatrixLoc, false, viewMatrix); // Uses global

    // REMOVE/COMMENT OUT old normalized depth logic for background shader:
    // const normalizedDepth = Math.min(Math.abs(currentAltitude) / MAX_DEPTH_FOR_COLOR_TRANSITION, 1.0);
    // if (uBackgroundDepthLoc !== null && typeof uBackgroundDepthLoc !== 'undefined' && uBackgroundDepthLoc !== -1) { // Check if it was found
    //    gl.uniform1f(uBackgroundDepthLoc, normalizedDepth); 
    // }

    // ADD new actual depth uniform for background shader:
    if (uActualDepthMetersLoc !== null && typeof uActualDepthMetersLoc !== 'undefined' && uActualDepthMetersLoc !== -1) { // Check if it was found
        gl.uniform1f(uActualDepthMetersLoc, Math.abs(cameraPosition[1]));
    } else {
        // This indicates an issue if the uniform isn't found, though the console.log in onload should catch it first.
        // console.error("u_actualDepthMetersLoc not found for background shader");
    }
    // uResolution is not directly used by the updated background shaders.

    // Bind seabox buffers
    gl.bindBuffer(gl.ARRAY_BUFFER, seaboxVertexBuffer);
    // const seaboxPositionAttributeLocation = gl.getAttribLocation(backgroundShaderProgram, "a_position"); // Now global
    if (seaboxPositionAttributeLocation !== -1 && typeof seaboxPositionAttributeLocation !== 'undefined') { // Check if valid
      gl.vertexAttribPointer(seaboxPositionAttributeLocation, 3, gl.FLOAT, false, 0, 0); // 3 components for 3D
      gl.enableVertexAttribArray(seaboxPositionAttributeLocation);
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, seaboxIndexBuffer);

    // Draw the seabox
    gl.drawElements(gl.TRIANGLES, seaboxIndices.length, gl.UNSIGNED_SHORT, 0);

    if (seaboxPositionAttributeLocation !== -1 && typeof seaboxPositionAttributeLocation !== 'undefined') {
      gl.disableVertexAttribArray(seaboxPositionAttributeLocation);
    }
    
    gl.depthMask(true); // Re-enable depth writing for other objects
    // gl.disableVertexAttribArray(seaboxPositionAttributeLocation); // Consider if creature shader uses 'a_position'

    // --- Render Creatures ---
    // Ensure creature shader program is used if it's different
    if (creatureShaderProgram) { // Check if creatureShaderProgram is initialized
      gl.useProgram(creatureShaderProgram);
    } else {
      // Handle error or skip creature rendering if shader not ready
      console.warn("Creature shader program not initialized. Skipping creature rendering.");
    }

    // Set shared lighting and camera uniforms (once per frame for all creatures)
    gl.uniform3fv(uLightPositionLoc, lightPosition);
    gl.uniform3fv(uLightColorLoc, lightColor);
    gl.uniform3fv(uAmbientColorLoc, ambientLightColor);
    gl.uniform1f(uMaterialShininessLoc, materialShininess);
    gl.uniform3fv(uCameraPositionLoc, cameraPosition); // Global cameraPosition

    // Set Flashlight Uniforms
    gl.uniform1i(uIsFlashlightOnLoc, isFlashlightOn ? 1 : 0);
    if (isFlashlightOn) {
        gl.uniform3fv(uFlashlightPosLoc, cameraPosition); // Flashlight originates from camera
        gl.uniform3fv(uFlashlightDirLoc, forward); // Use the new 'forward' vector

        gl.uniform3fv(uFlashlightColorLoc, flashlightColor);
        gl.uniform1f(uFlashlightIntensityLoc, flashlightIntensity);
        gl.uniform1f(uFlashlightConeCosLoc, Math.cos(flashlightConeAngle));
        gl.uniform1f(uFlashlightOuterConeCosLoc, Math.cos(flashlightOuterConeAngle));
    }

    // Pass view and projection matrices (these are global, set once if not per-object)
    gl.uniformMatrix4fv(uCreatureViewMatrixLoc, false, viewMatrix);
    gl.uniformMatrix4fv(uCreatureProjectionMatrixLoc, false, projectionMatrix);

    // Set Fog Uniforms (for creatureShaderProgram)
    const fogColor = [0.0, 0.01, 0.025, 1.0]; // Very dark blue/grey, for "deep sea"
    const fogStartDistance = 1.0;     // Start fog effect 
    const fogEndDistance = 750.0;      // Objects are fully obscured by fog at this distance

    if (uFogColorLoc !== null && uFogColorLoc !== -1) gl.uniform3fv(uFogColorLoc, fogColor.slice(0,3)); // Pass RGB
    if (uFogStartDistanceLoc !== null && uFogStartDistanceLoc !== -1) gl.uniform1f(uFogStartDistanceLoc, fogStartDistance);
    if (uFogEndDistanceLoc !== null && uFogEndDistanceLoc !== -1) gl.uniform1f(uFogEndDistanceLoc, fogEndDistance);


    // Enable vertex attributes before the loop
    if (creaturePosAttrLoc !== -1 && typeof creaturePosAttrLoc !== 'undefined') { // Check if valid before enabling
        gl.enableVertexAttribArray(creaturePosAttrLoc);
    }
    if (aCreatureVertexNormalLoc !== -1 && typeof aCreatureVertexNormalLoc !== 'undefined') { // Check if normal attribute exists
      gl.enableVertexAttribArray(aCreatureVertexNormalLoc);
    }

    for (let i = activeCreatures.length - 1; i >= 0; i--) {
        const creature = activeCreatures[i];
        const creatureDef = creature.definition; // creature.definition is from creatureShapes

        // --- Refined Despawning Logic ---
        // Y-axis despawn (creature is too far above the camera)
        const DESPAWN_Y_ABOVE = 1000; // meters (world units)
        if (creature.y > cameraPosition[1] + DESPAWN_Y_ABOVE) {
            activeCreatures.splice(i, 1);
            // console.log(`Despawned (Y above): ${creature.type}`); // Example of a commented-out despawn log
            continue;
        }

        // General distance-based despawning (from camera's XZ position)
        const MAX_XZ_DISTANCE = 2000; // Max horizontal/depth distance from camera's XZ
        const dx = creature.x - cameraPosition[0];
        const dz = creature.z - cameraPosition[2];
        if ((dx * dx + dz * dz) > (MAX_XZ_DISTANCE * MAX_XZ_DISTANCE)) {
            activeCreatures.splice(i, 1);
            // console.log(`Despawned (XZ distance): ${creature.type}`); // Example of a commented-out despawn log
            continue;
        }
        // --- End Refined Despawning Logic ---

        // 1. Set up buffers for this creature type (vertices, normals, indices)
        gl.bindBuffer(gl.ARRAY_BUFFER, creatureVertexBufferGL);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(creatureDef.vertices), gl.DYNAMIC_DRAW);
        if (creaturePosAttrLoc !== -1 && typeof creaturePosAttrLoc !== 'undefined') {
          gl.vertexAttribPointer(creaturePosAttrLoc, 3, gl.FLOAT, false, 0, 0);
        }


        if (aCreatureVertexNormalLoc !== -1 && typeof aCreatureVertexNormalLoc !== 'undefined') {
            gl.bindBuffer(gl.ARRAY_BUFFER, creatureNormalBufferGL);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(creatureDef.normals), gl.DYNAMIC_DRAW);
            gl.vertexAttribPointer(aCreatureVertexNormalLoc, 3, gl.FLOAT, false, 0, 0);
        }

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, creatureIndexBufferGL);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(creatureDef.indices), gl.DYNAMIC_DRAW);

        // 2. Construct Model Matrix for this creature
        let modelMatrix = glMatrix.mat4.create();
        let creatureWorldPos = [creature.x, creature.y, creature.z || 0];
        glMatrix.mat4.translate(modelMatrix, modelMatrix, creatureWorldPos);
        
        let scaleVec = [creatureDef.scale, creatureDef.scale, creatureDef.scale];
        // For whale, make it longer along Z and shorter along Y
        if (creature.type === creatures.WHALE) {
            scaleVec = [creatureDef.scale * 0.7, creatureDef.scale * 0.4, creatureDef.scale * 2.0];
        } else if (creature.type === creatures.SHARK) {
             scaleVec = [creatureDef.scale * 0.6, creatureDef.scale * 0.5, creatureDef.scale * 1.5];
        }


        glMatrix.mat4.scale(modelMatrix, modelMatrix, scaleVec);
        
        gl.uniformMatrix4fv(uCreatureModelMatrixLoc, false, modelMatrix);

        // 3. Set material color for this creature
        gl.uniform3fv(uMaterialDiffuseColorLoc, creatureDef.color.slice(0, 3)); // Pass RGB part of color

        // 4. Draw the creature
        gl.drawElements(gl.TRIANGLES, creatureDef.indices.length, gl.UNSIGNED_SHORT, 0);
    }
    // Disable vertex attributes after the loop
    if (creaturePosAttrLoc !== -1 && typeof creaturePosAttrLoc !== 'undefined') {
        gl.disableVertexAttribArray(creaturePosAttrLoc);
    }
    if (aCreatureVertexNormalLoc !== -1 && typeof aCreatureVertexNormalLoc !== 'undefined') {
        gl.disableVertexAttribArray(aCreatureVertexNormalLoc);
    }

    // --- Particle System Logic and Rendering ---
    // Maintain Dust Particle Count
    let dustParticlesInBoxCount = 0;
    for (const p of activeParticles) {
        if (p.type === PARTICLE_TYPE.DUST) {
            const localPos = glMatrix.vec3.subtract([], p.position, cameraPosition);
            if (Math.abs(localPos[0]) <= DUST_BOX_SIZE_X / 2.0 &&
                Math.abs(localPos[1]) <= DUST_BOX_SIZE_Y / 2.0 &&
                Math.abs(localPos[2]) <= DUST_BOX_SIZE_Z / 2.0) {
                dustParticlesInBoxCount++;
            }
        }
    }

    const maxDustToSpawnPerFrame = 3;
    let spawnedThisFrame = 0;
    if (dustParticlesInBoxCount < TARGET_DUST_PARTICLES_IN_BOX) {
        for (let k = 0; k < (TARGET_DUST_PARTICLES_IN_BOX - dustParticlesInBoxCount) && spawnedThisFrame < maxDustToSpawnPerFrame; ++k) {
            if (activeParticles.length >= MAX_PARTICLES) break;
            spawnParticle(PARTICLE_TYPE.DUST); // Force spawn DUST
            spawnedThisFrame++;
        }
    }
    
    // Optional: Spawn bubbles randomly and less frequently - REMOVE THIS BLOCK
    // if (Math.random() < 0.02) { 
    //     if (activeParticles.length < MAX_PARTICLES) {
    //         spawnParticle(PARTICLE_TYPE.BUBBLE); // This would now spawn a DUST particle due to changes in spawnParticle
    //     }
    // }

    updateParticles(deltaTime);

    if (activeParticles.length > 0 && particleShaderProgram) {
        gl.useProgram(particleShaderProgram);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); // Standard alpha blending
        gl.depthMask(false); // Don't write to depth buffer for transparent particles

        gl.uniformMatrix4fv(uParticleViewMatrixLoc, false, viewMatrix);
        gl.uniformMatrix4fv(uParticleProjectionMatrixLoc, false, projectionMatrix);

        // Calculate and set camera's right and up vectors for billboarding
        // viewMatrix is column-major:
        // Right: (viewMatrix[0], viewMatrix[4], viewMatrix[8])
        // Up:    (viewMatrix[1], viewMatrix[5], viewMatrix[9])
        let camRight = [viewMatrix[0], viewMatrix[4], viewMatrix[8]];
        let camUp = [viewMatrix[1], viewMatrix[5], viewMatrix[9]];
        
        // Fetching locations here is less ideal than storing them globally, but matches the plan
        const uCameraRightWsLoc = gl.getUniformLocation(particleShaderProgram, "u_camera_right_ws");
        const uCameraUpWsLoc = gl.getUniformLocation(particleShaderProgram, "u_camera_up_ws");

        gl.uniform3fv(uCameraRightWsLoc, camRight);
        gl.uniform3fv(uCameraUpWsLoc, camUp);

        gl.bindBuffer(gl.ARRAY_BUFFER, particleVertexBufferGL);
        if (aParticleQuadVertexLoc !== -1 && typeof aParticleQuadVertexLoc !== 'undefined') { // Check if valid
          gl.vertexAttribPointer(aParticleQuadVertexLoc, 2, gl.FLOAT, false, 0, 0);
          gl.enableVertexAttribArray(aParticleQuadVertexLoc);
        }

        for (const p of activeParticles) {
            gl.uniform3fv(uParticleWorldPosLoc, p.position);
            gl.uniform4fv(uParticleColorLoc, p.color);
            gl.uniform1f(uParticleSizeLoc, p.size);
            // Only draw if the attribute was successfully set up
            if (aParticleQuadVertexLoc !== -1 && typeof aParticleQuadVertexLoc !== 'undefined') {
                 gl.drawArrays(gl.TRIANGLES, 0, 6); // 6 vertices for 2 triangles (a quad)
            }
        }
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        // gl.disableVertexAttribArray(aParticleQuadVertexLoc); // Optional: if it interferes with other shaders
    }

    // --- Render Flashlight Model ---
    // This section is now for rendering the flashlight model itself, using creatureShaderProgram.
    // The misplaced God Ray pass that was here has been removed.
    // The actual flashlight model rendering code is below, currently under a misleading comment.
    // For clarity, the flashlight model rendering part using creatureShaderProgram should be here.
    // However, the task is specific about removing the misplaced God Ray code first.
    // The flashlight model rendering will be handled by the existing code block
    // that starts around line 1095 (formerly "God Ray Rendering Pass (moved after flashlight model)")
    // which correctly uses creatureShaderProgram for the flashlight model.

    // --- God Ray Rendering Pass (moved after flashlight model) ---
    // This comment is misleading. This section below actually renders the FLASHLIGHT MODEL.
    // The ACTUAL God Ray pass is further down.
    if (isFlashlightOn && godRayShaderProgram && occlusionTexture && uOcclusionTextureLoc && uLightScreenPosLoc) {
        gl.useProgram(creatureShaderProgram); // This should be creatureShaderProgram for the flashlight model

        // Set all necessary uniforms for creatureShaderProgram
        gl.uniformMatrix4fv(uCreatureViewMatrixLoc, false, viewMatrix);
        gl.uniformMatrix4fv(uCreatureProjectionMatrixLoc, false, projectionMatrix);
        gl.uniform3fv(uCameraPositionLoc, cameraPosition);
        gl.uniform3fv(uLightPositionLoc, lightPosition); 
        gl.uniform3fv(uLightColorLoc, lightColor);    
        gl.uniform3fv(uAmbientColorLoc, ambientLightColor); 
        gl.uniform1f(uMaterialShininessLoc, 16.0); 

        gl.uniform1i(uIsFlashlightOnLoc, isFlashlightOn ? 1 : 0);
        
        // Recalculate currentForwardVec for flashlight direction (already done above for cameraTarget)
        let currentForwardVec = glMatrix.vec3.create(); 
        currentForwardVec[0] = Math.cos(cameraPitch) * Math.cos(cameraYaw);
        currentForwardVec[1] = Math.sin(cameraPitch);
        currentForwardVec[2] = Math.cos(cameraPitch) * Math.sin(cameraYaw);
        glMatrix.vec3.normalize(currentForwardVec, currentForwardVec);

        if (uFlashlightPosLoc) gl.uniform3fv(uFlashlightPosLoc, cameraPosition);
        if (uFlashlightDirLoc) gl.uniform3fv(uFlashlightDirLoc, currentForwardVec); 
        if (uFlashlightColorLoc) gl.uniform3fv(uFlashlightColorLoc, flashlightColor);
        if (uFlashlightIntensityLoc) gl.uniform1f(uFlashlightIntensityLoc, flashlightIntensity);
        if (uFlashlightConeCosLoc) gl.uniform1f(uFlashlightConeCosLoc, Math.cos(flashlightConeAngle));
        if (uFlashlightOuterConeCosLoc) gl.uniform1f(uFlashlightOuterConeCosLoc, Math.cos(flashlightOuterConeAngle));

        // Flashlight Model Attributes Setup
        if (creaturePosAttrLoc !== -1 && typeof creaturePosAttrLoc !== 'undefined' && flashlightVertexBufferGL) { 
            gl.bindBuffer(gl.ARRAY_BUFFER, flashlightVertexBufferGL); // Use GLB vertex buffer
            gl.vertexAttribPointer(creaturePosAttrLoc, 3, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(creaturePosAttrLoc);
        }
        if (aCreatureVertexNormalLoc !== -1 && typeof aCreatureVertexNormalLoc !== 'undefined' && flashlightNormalBufferGL) {
            gl.bindBuffer(gl.ARRAY_BUFFER, flashlightNormalBufferGL); // Use GLB normal buffer
            gl.vertexAttribPointer(aCreatureVertexNormalLoc, 3, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(aCreatureVertexNormalLoc);
        }
        if (flashlightIndexBufferGL) {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, flashlightIndexBufferGL); // Use GLB index buffer
        }

        // Construct Model Matrix for the flashlight
        let flashlightModelMatrix = glMatrix.mat4.create();
        let camQuat = glMatrix.quat.create(); 
        let camRotationMat3 = glMatrix.mat3.create(); // Temp mat3 for quat conversion
        let camActualRight = glMatrix.vec3.create();
        let camActualUp = glMatrix.vec3.create();

        // Re-calculate right and up vectors based on currentForwardVec and global upVector
        glMatrix.vec3.cross(camActualRight, currentForwardVec, upVector); 
        glMatrix.vec3.normalize(camActualRight, camActualRight);
        glMatrix.vec3.cross(camActualUp, camActualRight, currentForwardVec); // up = right x forward (adjust if needed)
        glMatrix.vec3.normalize(camActualUp, camActualUp); // Ensure it's normalized
        
        // Construct column-major rotation matrix from basis vectors for glMatrix.quat.fromMat3
        // Assuming currentForwardVec is the Z-axis of the camera's local space (points out of screen)
        // The flashlight model's "forward" should align with this.
        // If cylinder's main axis is Y, we'll rotate it.
        // Basis vectors for rotation matrix (columns): Right, Up, -Forward (because GL is right-handed, +Z often comes out of screen)
        camRotationMat3[0] = camActualRight[0]; camRotationMat3[1] = camActualRight[1]; camRotationMat3[2] = camActualRight[2];
        camRotationMat3[3] = camActualUp[0];    camRotationMat3[4] = camActualUp[1];    camRotationMat3[5] = camActualUp[2];
        camRotationMat3[6] = -currentForwardVec[0]; camRotationMat3[7] = -currentForwardVec[1]; camRotationMat3[8] = -currentForwardVec[2];
        glMatrix.quat.fromMat3(camQuat, camRotationMat3);


        const offsetRightVal = 0.15; const offsetDownVal = 0.10; const offsetForwardVal = 0.25;
        let finalFlashlightPos = glMatrix.vec3.clone(cameraPosition);
        glMatrix.vec3.scaleAndAdd(finalFlashlightPos, finalFlashlightPos, camActualRight, offsetRightVal);
        glMatrix.vec3.scaleAndAdd(finalFlashlightPos, finalFlashlightPos, camActualUp, -offsetDownVal); 
        glMatrix.vec3.scaleAndAdd(finalFlashlightPos, finalFlashlightPos, currentForwardVec, offsetForwardVal);

        glMatrix.mat4.fromRotationTranslation(flashlightModelMatrix, camQuat, finalFlashlightPos);
        
        // The cylinder is generated with its height along Y. We want it to point along Z (forward).
        // So, rotate it by -90 degrees around X-axis.
        // Or, if we want it to align with the `currentForwardVec` which is camera's Z,
        // we need to ensure the cylinder's original orientation is considered.
        // Let's assume the cylinder's length is along its Y axis. We want to align this Y with camera's Z.
        // This means we need a rotation that maps Y-axis to Z-axis.
        // A common way is to rotate -PI/2 around X axis if cylinder's length is Y and we want it to point along Z.
        let rotationX = glMatrix.mat4.create();
        glMatrix.mat4.rotateX(rotationX, rotationX, -Math.PI / 2);
        glMatrix.mat4.multiply(flashlightModelMatrix, flashlightModelMatrix, rotationX);

        glMatrix.mat4.scale(flashlightModelMatrix, flashlightModelMatrix, [0.05, 0.05, 0.15]); // Keep existing scale for now

        gl.uniformMatrix4fv(uCreatureModelMatrixLoc, false, flashlightModelMatrix);
        gl.uniform3fv(uMaterialDiffuseColorLoc, FLASHLIGHT_MODEL_COLOR.slice(0,3));

        if (loadedGLBData.indices && loadedGLBData.indices.length > 0 && loadedGLBData.indexType) {
            gl.drawElements(gl.TRIANGLES, loadedGLBData.indices.length, loadedGLBData.indexType, 0);
        } else {
            // console.warn("Flashlight GLB data not available for rendering or indexType not set.");
        }

        // Disable attributes after use if they were enabled specifically for this model
        if (creaturePosAttrLoc !== -1 && typeof creaturePosAttrLoc !== 'undefined') {
             gl.disableVertexAttribArray(creaturePosAttrLoc);
        }
        if (aCreatureVertexNormalLoc !== -1 && typeof aCreatureVertexNormalLoc !== 'undefined') {
             gl.disableVertexAttribArray(aCreatureVertexNormalLoc);
        }
    }
    
    // --- God Ray Rendering Pass (This is the new location, happens AFTER scene is on canvas) ---
    // First, unbind sceneFBO and render sceneColorTexture to the main canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height); // Reset viewport to canvas
    gl.clearColor(0.0, 0.0, 0.0, 1.0); // Clear the actual canvas before drawing the texture to it
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); // Clear actual canvas's depth too

    if (texturePassThruShaderProgram && sceneColorTexture && texturePassThruTextureLoc && passThruQuadBuffer) {
        gl.useProgram(texturePassThruShaderProgram);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sceneColorTexture); // Bind the color texture from sceneFBO
        gl.uniform1i(texturePassThruTextureLoc, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, passThruQuadBuffer);
        if (texturePassThruPosLoc !== -1) {
            gl.enableVertexAttribArray(texturePassThruPosLoc);
            gl.vertexAttribPointer(texturePassThruPosLoc, 2, gl.FLOAT, false, 16, 0); // 2 components, 4 bytes/float * 4 components per vertex = 16 bytes stride, 0 offset
        }
        if (texturePassThruTexCoordLoc !== -1) {
            gl.enableVertexAttribArray(texturePassThruTexCoordLoc);
            gl.vertexAttribPointer(texturePassThruTexCoordLoc, 2, gl.FLOAT, false, 16, 8); // 2 components, 16 bytes stride, 2 floats * 4 bytes/float = 8 bytes offset
        }
        
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        if (texturePassThruPosLoc !== -1) gl.disableVertexAttribArray(texturePassThruPosLoc);
        if (texturePassThruTexCoordLoc !== -1) gl.disableVertexAttribArray(texturePassThruTexCoordLoc);
    }


    // Now, proceed with God Rays if flashlight is on. This will be blended on top of the scene.
    if (isFlashlightOn && godRayShaderProgram && occlusionTexture && uOcclusionTextureLoc && uLightScreenPosLoc && sceneDepthTexture) {
        gl.useProgram(godRayShaderProgram);

        // Set up for additive blending
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE); // Additive blending (source + destination)
        // gl.depthMask(false); // God rays typically don't write to depth

        gl.activeTexture(gl.TEXTURE0); // Occlusion texture still on unit 0
        gl.bindTexture(gl.TEXTURE_2D, occlusionTexture);
        gl.uniform1i(uOcclusionTextureLoc, 0);

        // Bind sceneDepthTexture to another unit (e.g., TEXTURE1)
        if (uSceneDepthTextureLoc) {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, sceneDepthTexture);
            gl.uniform1i(uSceneDepthTextureLoc, 1); // Texture unit 1
        }

        // Set camera near/far for depth linearization
        if (uCameraNearLoc) gl.uniform1f(uCameraNearLoc, zNear);
        if (uCameraFarLoc) gl.uniform1f(uCameraFarLoc, zFar);

        // Light position on screen (center for now, as light spot is screen-centered)
        gl.uniform2f(uLightScreenPosLoc, 0.5, 0.5);

        if(uGodRayNumSamplesLoc) gl.uniform1i(uGodRayNumSamplesLoc, godRayParams.numSamples);
        if(uGodRayDecayLoc) gl.uniform1f(uGodRayDecayLoc, godRayParams.decay);
        if(uGodRayExposureLoc) gl.uniform1f(uGodRayExposureLoc, godRayParams.exposure);
        if(uGodRayDensityLoc) gl.uniform1f(uGodRayDensityLoc, godRayParams.density);
        if(uGodRayWeightLoc) gl.uniform1f(uGodRayWeightLoc, godRayParams.weight);

        const godRayQuadPosLoc = gl.getAttribLocation(godRayShaderProgram, "a_quad_pos");
        if (godRayQuadPosLoc !== -1) {
            gl.bindBuffer(gl.ARRAY_BUFFER, lightSpotQuadVBO); // Reuse quad VBO
            gl.vertexAttribPointer(godRayQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(godRayQuadPosLoc);
            
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            
            gl.disableVertexAttribArray(godRayQuadPosLoc);
        }
        
        gl.disable(gl.BLEND); // Reset blend mode
        // gl.depthMask(true); // Reset depth mask if it was changed
    }

    requestAnimationFrame(render);
}

// Handle window resize
window.onresize = function() {
    if (canvas && gl && projectionMatrix && typeof glMatrix !== 'undefined') {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        gl.viewport(0, 0, canvas.width, canvas.height); // Default viewport for canvas
        aspect = canvas.width / canvas.height;
        glMatrix.mat4.perspective(projectionMatrix, fieldOfView, aspect, zNear, zFar);
        console.log("Resized canvas and updated 3D projection matrix.");

        // Resize FBO textures as well
        if (sceneColorTexture) {
            gl.bindTexture(gl.TEXTURE_2D, sceneColorTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
        if (sceneDepthTexture) {
            gl.bindTexture(gl.TEXTURE_2D, sceneDepthTexture);
            // Corrected to UNSIGNED_SHORT as per FBO setup and current subtask
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, canvas.width, canvas.height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null);
        }
        // Also resize occlusionTexture for flashlight spot
        if (occlusionTexture) {
            gl.bindTexture(gl.TEXTURE_2D, occlusionTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
        gl.bindTexture(gl.TEXTURE_2D, null); // Unbind
        console.log("Resized FBO textures.");
    }
};

// Helper for mat4.fromRotationTranslation (if not in embedded glMatrix)
if (glMatrix.mat4 && !glMatrix.mat4.fromRotationTranslation) {
    glMatrix.mat4.fromRotationTranslation = function(out, q, v) {
        // Quaternion math
        let x = q[0], y = q[1], z = q[2], w = q[3];
        let x2 = x + x, y2 = y + y, z2 = z + z;
        let xx = x * x2, yx = y * x2, yy = y * y2;
        let zx = z * x2, zy = z * y2, zz = z * z2;
        let wx = w * x2, wy = w * y2, wz = w * z2;

        out[0] = 1 - (yy + zz); out[1] = yx + wz; out[2] = zx - wy; out[3] = 0;
        out[4] = yx - wz; out[5] = 1 - (xx + zz); out[6] = zy + wx; out[7] = 0;
        out[8] = zx + wy; out[9] = zy - wx; out[10] = 1 - (xx + yy); out[11] = 0;
        out[12] = v[0]; out[13] = v[1]; out[14] = v[2]; out[15] = 1;
        return out;
    };
}
// Helper for mat4.rotateX (if not in embedded glMatrix)
if (glMatrix.mat4 && !glMatrix.mat4.rotateX) {
    glMatrix.mat4.rotateX = function(out, a, rad) {
        let s = Math.sin(rad), c = Math.cos(rad);
        let a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
        let a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
        if (a !== out) { // If the source and destination differ, copy the unchanged rows
            out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
            out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
        }
        out[4] = a10 * c + a20 * s; out[5] = a11 * c + a21 * s;
        out[6] = a12 * c + a22 * s; out[7] = a13 * c + a23 * s;
        out[8] = a20 * c - a10 * s; out[9] = a21 * c - a11 * s;
        out[10] = a22 * c - a12 * s; out[11] = a23 * c - a13 * s;
        return out;
    };
}
