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
let aParticleQuadVertexLoc; // Attribute for quad corner
let uParticleWorldPosLoc, uParticleColorLoc, uParticleSizeLoc;
let uParticleViewMatrixLoc, uParticleProjectionMatrixLoc; // For shader

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

let shaderProgram;
let positionBuffer;
let uResolutionLocation;
let uDepthLocation;
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

    // Ensure glMatrix is available
    if (typeof glMatrix === 'undefined') {
        console.error("gl-matrix was not loaded! 3D operations will fail.");
        alert("Error: Required 3D math library (gl-matrix) not found. Please check internet connection or CDN link.");
        return; // Stop if library is missing
    }

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

    shaderProgram = initShaderProgram(gl, vsSource, fsSource);
    if (!shaderProgram) {
        alert("Failed to initialize shader program.");
        return;
    }
    gl.useProgram(shaderProgram); // Use the program

    // Get uniform locations for background shader (shaderProgram)
    uResolutionLocation = gl.getUniformLocation(shaderProgram, "u_resolution"); // Still needed for u_depth calculation logic in fragment shader
    uDepthLocation = gl.getUniformLocation(shaderProgram, "u_depth");
    const uBackgroundProjectionMatrixLoc = gl.getUniformLocation(shaderProgram, "u_projectionMatrix");
    const uBackgroundViewMatrixLoc = gl.getUniformLocation(shaderProgram, "u_viewMatrix");


    // Create and bind buffers for seabox
    seaboxVertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, seaboxVertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(seaboxVertices), gl.STATIC_DRAW);

    seaboxIndexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, seaboxIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(seaboxIndices), gl.STATIC_DRAW);
    
    // The old positionBuffer and its setup for the 2D quad are no longer needed for the background.
    // The attribute a_position for shaderProgram will be set up in the render loop for the seabox.

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
    // const creatureAttributeLocation = gl.getAttribLocation(creatureShaderProgram, "a_creature_position"); // This will be fetched in render or if used globally
    aCreatureVertexNormalLoc = gl.getAttribLocation(creatureShaderProgram, "a_vertex_normal");

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
        altitudeDisplay.textContent = `Altitude: ${Math.round(currentAltitude)} m`;
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
    gl.useProgram(shaderProgram); // Use the background shader program

    // Set camera/projection uniforms for background shader
    gl.uniformMatrix4fv(uBackgroundProjectionMatrixLoc, false, projectionMatrix);
    gl.uniformMatrix4fv(uBackgroundViewMatrixLoc, false, viewMatrix);

    // Normalized depth for color calculation (same as before for fragment shader)
    const normalizedDepth = Math.min(Math.abs(currentAltitude) / MAX_DEPTH_FOR_COLOR_TRANSITION, 1.0);
    gl.uniform1f(uDepthLocation, normalizedDepth);
    // uResolution is not directly used by the updated background shaders but uDepthLocation is.

    // Bind seabox buffers
    gl.bindBuffer(gl.ARRAY_BUFFER, seaboxVertexBuffer);
    const seaboxPositionAttributeLocation = gl.getAttribLocation(shaderProgram, "a_position");
    gl.enableVertexAttribArray(seaboxPositionAttributeLocation);
    gl.vertexAttribPointer(seaboxPositionAttributeLocation, 3, gl.FLOAT, false, 0, 0); // 3 components for 3D

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, seaboxIndexBuffer);

    // Draw the seabox
    gl.drawElements(gl.TRIANGLES, seaboxIndices.length, gl.UNSIGNED_SHORT, 0);
    
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

    // Enable vertex attributes
    const creaturePosAttrLoc = gl.getAttribLocation(creatureShaderProgram, "a_creature_position");
    gl.enableVertexAttribArray(creaturePosAttrLoc);
    if (aCreatureVertexNormalLoc !== -1 && aCreatureVertexNormalLoc !== null) { // Check if normal attribute exists
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
        gl.vertexAttribPointer(creaturePosAttrLoc, 3, gl.FLOAT, false, 0, 0);

        if (aCreatureVertexNormalLoc !== -1 && aCreatureVertexNormalLoc !== null) {
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
    // It's good practice to disable arrays after the loop
    // gl.disableVertexAttribArray(creaturePosAttrLoc);
    // if (aCreatureVertexNormalLoc !== -1 && aCreatureVertexNormalLoc !== null) {
    //    gl.disableVertexAttribArray(aCreatureVertexNormalLoc);
    // }

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
        gl.vertexAttribPointer(aParticleQuadVertexLoc, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(aParticleQuadVertexLoc);

        for (const p of activeParticles) {
            gl.uniform3fv(uParticleWorldPosLoc, p.position);
            gl.uniform4fv(uParticleColorLoc, p.color);
            gl.uniform1f(uParticleSizeLoc, p.size);
            gl.drawArrays(gl.TRIANGLES, 0, 6); // 6 vertices for 2 triangles (a quad)
        }
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        // gl.disableVertexAttribArray(aParticleQuadVertexLoc); // Optional: if it interferes with other shaders
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
