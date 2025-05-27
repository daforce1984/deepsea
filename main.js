// Embedded gl-matrix functions (minimal set from v3.3.0)
const glMatrix = {};

glMatrix.mat4 = {
    create: function() {
        let out = new Float32Array(16);
        out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
        out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
        out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
        out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
        return out;
    },
    perspective: function(out, fovy, aspect, near, far) {
        const f = 1.0 / Math.tan(fovy / 2);
        out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
        out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
        out[8] = 0; out[9] = 0; out[11] = -1; out[15] = 0;
        if (far != null && far !== Infinity) {
            const nf = 1 / (near - far);
            out[10] = (far + near) * nf;
            out[14] = 2 * far * near * nf;
        } else {
            out[10] = -1;
            out[14] = -2 * near;
        }
        return out;
    },
    lookAt: function(out, eye, center, up) {
        let x0, x1, x2, y0, y1, y2, z0, z1, z2, len;
        let eyex = eye[0], eyey = eye[1], eyez = eye[2];
        let upx = up[0], upy = up[1], upz = up[2];
        let centerx = center[0], centery = center[1], centerz = center[2];

        if (Math.abs(eyex - centerx) < 0.000001 &&
            Math.abs(eyey - centery) < 0.000001 &&
            Math.abs(eyez - centerz) < 0.000001) {
            //return glMatrix.mat4.identity(out); // Assuming mat4.identity exists or use create
            // mat4.create() returns identity, so this is fine:
            let new_out = glMatrix.mat4.create();
            for(let i=0; i<16; ++i) out[i] = new_out[i];
            return out;
        }

        z0 = eyex - centerx; z1 = eyey - centery; z2 = eyez - centerz;
        len = 1 / Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
        z0 *= len; z1 *= len; z2 *= len;

        x0 = upy * z2 - upz * z1; x1 = upz * z0 - upx * z2; x2 = upx * z1 - upy * z0;
        len = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
        if (!len) { x0 = 0; x1 = 0; x2 = 0; }
        else { len = 1 / len; x0 *= len; x1 *= len; x2 *= len; }

        y0 = z1 * x2 - z2 * x1; y1 = z2 * x0 - z0 * x2; y2 = z0 * x1 - z1 * x0;
        len = Math.sqrt(y0 * y0 + y1 * y1 + y2 * y2);
        if (!len) { y0 = 0; y1 = 0; y2 = 0; }
        else { len = 1 / len; y0 *= len; y1 *= len; y2 *= len; }

        out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
        out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
        out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
        out[12] = -(x0 * eyex + x1 * eyey + x2 * eyez);
        out[13] = -(y0 * eyex + y1 * eyey + y2 * eyez);
        out[14] = -(z0 * eyex + z1 * eyey + z2 * eyez); 
        out[15] = 1;
        return out;
    },
    translate: function(out, a, v) {
        let x = v[0], y = v[1], z = v[2];
        let a00, a01, a02, a03; let a10, a11, a12, a13;
        let a20, a21, a22, a23;
        if (a === out) {
            out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
            out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
            out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
            out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
        } else {
            a00 = a[0]; a01 = a[1]; a02 = a[2]; a03 = a[3];
            a10 = a[4]; a11 = a[5]; a12 = a[6]; a13 = a[7];
            a20 = a[8]; a21 = a[9]; a22 = a[10]; a23 = a[11];
            out[0] = a00; out[1] = a01; out[2] = a02; out[3] = a03;
            out[4] = a10; out[5] = a11; out[6] = a12; out[7] = a13;
            out[8] = a20; out[9] = a21; out[10] = a22; out[11] = a23;
            out[12] = a00 * x + a10 * y + a20 * z + a[12];
            out[13] = a01 * x + a11 * y + a21 * z + a[13];
            out[14] = a02 * x + a12 * y + a22 * z + a[14];
            out[15] = a03 * x + a13 * y + a23 * z + a[15];
        }
        return out;
    },
    scale: function(out, a, v) {
        let x = v[0], y = v[1], z = v[2];
        out[0] = a[0] * x; out[1] = a[1] * x; out[2] = a[2] * x; out[3] = a[3] * x;
        out[4] = a[4] * y; out[5] = a[5] * y; out[6] = a[6] * y; out[7] = a[7] * y;
        out[8] = a[8] * z; out[9] = a[9] * z; out[10] = a[10] * z; out[11] = a[11] * z;
        out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
        return out;
    }
};

glMatrix.vec3 = {
    create: function() {
        let out = new Float32Array(3);
        out[0] = 0; out[1] = 0; out[2] = 0;
        return out;
    },
    add: function(out, a, b) {
        out[0] = a[0] + b[0];
        out[1] = a[1] + b[1];
        out[2] = a[2] + b[2];
        return out;
    },
    subtract: function(out, a, b) {
        out[0] = a[0] - b[0];
        out[1] = a[1] - b[1];
        out[2] = a[2] - b[2];
        return out;
    },
    normalize: function(out, a) {
        let x = a[0], y = a[1], z = a[2];
        let len = x * x + y * y + z * z;
        if (len > 0) {
            len = 1 / Math.sqrt(len);
            out[0] = a[0] * len;
            out[1] = a[1] * len;
            out[2] = a[2] * len;
        }
        return out;
    },
    scaleAndAdd: function(out, a, b, scale) { // Added scaleAndAdd
        out[0] = a[0] + b[0] * scale;
        out[1] = a[1] + b[1] * scale;
        out[2] = a[2] + b[2] * scale;
        return out;
    }
};

glMatrix.quat = {
  create: function() {
    let out = new Float32Array(4);
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; // x, y, z, w
    return out;
  },
  fromMat3: function(out, m) {
    // Algorithm in Ken Shoemake's article in 1987 SIGGRAPH course notes
    // article "Quaternion Calculus and Fast Animation".
    let fTrace = m[0] + m[4] + m[8];
    let fRoot;

    if (fTrace > 0.0) {
      // |w| > 1/2, may as well choose w > 1/2
      fRoot = Math.sqrt(fTrace + 1.0); // 2w
      out[3] = 0.5 * fRoot;
      fRoot = 0.5 / fRoot; // 1/(4w)
      out[0] = (m[5] - m[7]) * fRoot;
      out[1] = (m[6] - m[2]) * fRoot;
      out[2] = (m[1] - m[3]) * fRoot;
    } else {
      // |w| <= 1/2
      let i = 0;
      if (m[4] > m[0]) i = 1;
      if (m[8] > m[i * 3 + i]) i = 2;
      let j = (i + 1) % 3;
      let k = (i + 2) % 3;

      fRoot = Math.sqrt(m[i * 3 + i] - m[j * 3 + j] - m[k * 3 + k] + 1.0);
      out[i] = 0.5 * fRoot;
      fRoot = 0.5 / fRoot;
      out[3] = (m[j * 3 + k] - m[k * 3 + j]) * fRoot;
      out[j] = (m[j * 3 + i] + m[i * 3 + j]) * fRoot;
      out[k] = (m[k * 3 + i] + m[i * 3 + k]) * fRoot;
    }
    return out;
  },
  // Minimal rotateX for mat4.fromRotationTranslation
  // Simplified for mat4.rotateX directly on mat4 if needed
};

glMatrix.mat3 = { // Required for quat.fromMat3 if using mat3 intermediate
    create: function() {
        let out = new Float32Array(9);
        out[0] = 1; out[1] = 0; out[2] = 0;
        out[3] = 0; out[4] = 1; out[5] = 0;
        out[6] = 0; out[7] = 0; out[8] = 1;
        return out;
    }
};


// End of Embedded gl-matrix functions

// main.js
// gl-matrix.js is expected to be loaded via CDN (see index.html)
// If glMatrix is not defined, 3D operations will fail.

let gl;

// Particle System Variables
const MAX_PARTICLES = 500;
let activeParticles = [];
const PARTICLE_TYPE = { DUST: 0, BUBBLE: 1 };
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
// We can reuse lightSpotQuadVBO for the fullscreen quad

const godRayParams = { // Default values for god ray parameters
    numSamples: 64, // Integer
    decay: 0.96,
    exposure: 0.15,
    density: 0.9,
    weight: 0.1
};

// Flashlight Model Global Variables
let flashlightModel = {
    vertices: [],
    normals: [],
    indices: []
};
let flashlightVertexBufferGL, flashlightNormalBufferGL, flashlightIndexBufferGL;
const FLASHLIGHT_MODEL_COLOR = [0.25, 0.25, 0.3, 1.0]; // Dark greyish color

const DUST_COLOR = [0.8, 0.8, 0.7, 0.3]; // Semi-transparent greyish
const BUBBLE_COLOR = [0.7, 0.8, 1.0, 0.2]; // Semi-transparent bluish
const PARTICLE_SPAWN_RATE = 0.5; // Chance to spawn a particle each frame (adjust)

// Camera Rotation Variables
let cameraYaw = -Math.PI / 2; // Initial yaw (looking along -Z)
let cameraPitch = 0;          // Initial pitch
const mouseSensitivity = 0.002;

// Flashlight Variables
let isFlashlightOn = false; // Flashlight is off by default
const flashlightColor = [1.0, 1.0, 0.9]; // Slightly warm white
const flashlightIntensity = 1.5;          // Multiplier for flashlight brightness
const flashlightConeAngle = 25.0 * Math.PI / 180; // Inner cone angle (degrees to radians)
const flashlightOuterConeAngle = 30.0 * Math.PI / 180; // Outer cone for penumbra/falloff

// Uniform locations for flashlight (in creatureShaderProgram)
let uIsFlashlightOnLoc, uFlashlightPosLoc, uFlashlightDirLoc, uFlashlightColorLoc;
let uFlashlightIntensityLoc, uFlashlightConeCosLoc, uFlashlightOuterConeCosLoc;

// Lighting and new uniform/attribute locations
let uCreatureModelMatrixLoc, uCreatureViewMatrixLoc, uCreatureProjectionMatrixLoc;
let uMaterialDiffuseColorLoc, uLightPositionLoc, uLightColorLoc, uCameraPositionLoc, uMaterialShininessLoc, uAmbientColorLoc;
let aCreatureVertexNormalLoc; // Attribute location for normals

const lightPosition = [50.0, 50.0, 100.0]; // Example static light position in world space
const lightColor = [1.0, 1.0, 1.0];       // White light
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

function generateCylinder(radius, height, segments) {
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

    // Set canvas size
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);

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

    // Initialize Flashlight Model
    flashlightModel = generateCylinder(1.0, 1.0, 16); // Unit cylinder (radius 1, height 1)

    flashlightVertexBufferGL = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, flashlightVertexBufferGL);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(flashlightModel.vertices), gl.STATIC_DRAW);

    flashlightNormalBufferGL = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, flashlightNormalBufferGL);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(flashlightModel.normals), gl.STATIC_DRAW);

    flashlightIndexBufferGL = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, flashlightIndexBufferGL);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(flashlightModel.indices), gl.STATIC_DRAW);

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
            console.log('GodRay Shader Uniforms:', { 
                u_occlusionTexture: uOcclusionTextureLoc, 
                u_lightScreenPos: uLightScreenPosLoc,
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

            const maxPitch = Math.PI / 2 - 0.01; // Just under 90 degrees
            cameraPitch = Math.max(-maxPitch, Math.min(maxPitch, cameraPitch));
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

function spawnParticle() {
    if (activeParticles.length >= MAX_PARTICLES) return;

    const type = (Math.random() < 0.3) ? PARTICLE_TYPE.BUBBLE : PARTICLE_TYPE.DUST;
    
    // Spawn in a volume around and in front of the camera
    const spawnVolRadius = 500; // Horizontal/Vertical spawn radius from camera center
    const spawnVolDepth = 1000; // How far in front particles can spawn

    let position = glMatrix.vec3.create();
    // Random offset from camera position
    position[0] = cameraPosition[0] + (Math.random() - 0.5) * spawnVolRadius * 2;
    position[1] = cameraPosition[1] + (Math.random() - 0.5) * spawnVolRadius; // Spawn around camera's Y
    position[2] = cameraPosition[2] - (Math.random() * spawnVolDepth);     // Spawn in front

    let velocity = glMatrix.vec3.create();
    let life = Math.random() * 3.0 + 2.0; // Lifetime 2-5 seconds
    let color = (type === PARTICLE_TYPE.BUBBLE) ? [...BUBBLE_COLOR] : [...DUST_COLOR];
    let size = (type === PARTICLE_TYPE.BUBBLE) ? (Math.random() * 5 + 5) : (Math.random() * 2 + 1);

    if (type === PARTICLE_TYPE.BUBBLE) {
        velocity[1] = Math.random() * 50 + 30; // Bubbles rise
        velocity[0] = (Math.random() - 0.5) * 10;
        velocity[2] = (Math.random() - 0.5) * 10;
    } else { // Dust
        velocity[0] = (Math.random() - 0.5) * 5;
        velocity[1] = (Math.random() - 0.5) * 5 - 10; // Dust mostly sinks slowly
        velocity[2] = (Math.random() - 0.5) * 5;
        size *= 2.0; // Make dust specks a bit larger for visibility if very transparent
    }
    
    activeParticles.push({ position, velocity, color, life, type, size, initialLife: life });
}

function updateParticles(deltaTime) {
    for (let i = activeParticles.length - 1; i >= 0; i--) {
        let p = activeParticles[i];
        p.life -= deltaTime;

        if (p.life <= 0) {
            activeParticles.splice(i, 1);
            continue;
        }

        glMatrix.vec3.scaleAndAdd(p.position, p.position, p.velocity, deltaTime);

        // Fade out particles (adjust alpha)
        p.color[3] = ((p.type === PARTICLE_TYPE.BUBBLE) ? BUBBLE_COLOR[3] : DUST_COLOR[3]) * (p.life / p.initialLife);
        
        // Optional: Bubbles expand slightly?
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

    // Clear the canvas
    gl.clearColor(0.0, 0.0, 0.0, 1.0); // Set clear color (can be redundant if shader covers screen)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // --- Render Sebox Background ---
    gl.depthMask(false); // Disable depth writing for skybox
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
    if (Math.random() < PARTICLE_SPAWN_RATE) { // Probabilistic spawn
      for(let k=0; k < 3; ++k) spawnParticle(); // Spawn a few particles at a time
    }
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
    if (isFlashlightOn) {
        gl.useProgram(creatureShaderProgram); 

        // Set up for additive blending
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE); // Additive blending (source + destination)
        // gl.depthMask(false); // God rays typically don't write to depth

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, occlusionTexture);
        gl.uniform1i(uOcclusionTextureLoc, 0); // Texture unit 0

        // Light position on screen (center for now, as light spot is screen-centered)
        gl.uniform2f(uLightScreenPosLoc, 0.5, 0.5); 

        // Set new god ray parameter uniforms
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

    // --- God Ray Rendering Pass (moved after flashlight model) ---
    if (isFlashlightOn && godRayShaderProgram && occlusionTexture && uOcclusionTextureLoc && uLightScreenPosLoc) {
        gl.useProgram(godRayShaderProgram);

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
        if (creaturePosAttrLoc !== -1 && typeof creaturePosAttrLoc !== 'undefined') { 
            gl.bindBuffer(gl.ARRAY_BUFFER, flashlightVertexBufferGL);
            gl.vertexAttribPointer(creaturePosAttrLoc, 3, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(creaturePosAttrLoc);
        }
        if (aCreatureVertexNormalLoc !== -1 && typeof aCreatureVertexNormalLoc !== 'undefined') {
            gl.bindBuffer(gl.ARRAY_BUFFER, flashlightNormalBufferGL);
            gl.vertexAttribPointer(aCreatureVertexNormalLoc, 3, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(aCreatureVertexNormalLoc);
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, flashlightIndexBufferGL);

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

        glMatrix.mat4.scale(flashlightModelMatrix, flashlightModelMatrix, [0.020, 0.15, 0.020]); // XZ radius, Y length (now points forward)

        gl.uniformMatrix4fv(uCreatureModelMatrixLoc, false, flashlightModelMatrix);
        gl.uniform3fv(uMaterialDiffuseColorLoc, FLASHLIGHT_MODEL_COLOR.slice(0,3));

        gl.drawElements(gl.TRIANGLES, flashlightModel.indices.length, gl.UNSIGNED_SHORT, 0);

        // Disable attributes after use if they were enabled specifically for this model
        if (creaturePosAttrLoc !== -1 && typeof creaturePosAttrLoc !== 'undefined') {
             gl.disableVertexAttribArray(creaturePosAttrLoc);
        }
        if (aCreatureVertexNormalLoc !== -1 && typeof aCreatureVertexNormalLoc !== 'undefined') {
             gl.disableVertexAttribArray(aCreatureVertexNormalLoc);
        }
    }
    
    // --- God Ray Rendering Pass (This is the new location) ---
    if (isFlashlightOn && godRayShaderProgram && occlusionTexture && uOcclusionTextureLoc && uLightScreenPosLoc) {
        gl.useProgram(godRayShaderProgram);

        // Set up for additive blending
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE); // Additive blending (source + destination)
        // gl.depthMask(false); // God rays typically don't write to depth

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, occlusionTexture);
        gl.uniform1i(uOcclusionTextureLoc, 0); // Texture unit 0

        // Light position on screen (center for now, as light spot is screen-centered)
        gl.uniform2f(uLightScreenPosLoc, 0.5, 0.5); 

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
        gl.viewport(0, 0, canvas.width, canvas.height);
        aspect = canvas.width / canvas.height;
        glMatrix.mat4.perspective(projectionMatrix, fieldOfView, aspect, zNear, zFar);
        console.log("Resized canvas and updated 3D projection matrix.");
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
