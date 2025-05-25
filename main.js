// main.js
let gl;
let canvas;

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
// For simplicity, we'll define them in a local coordinate system (around 0,0).
// We'll scale and translate them later when rendering.
const creatureShapes = {
    [creatures.SHARK]: {
        vertices: [ // A simple triangle for a shark's body/fin
            0.0,  0.5,  // Top point
           -0.2, -0.5,  // Bottom-left
            0.2, -0.5   // Bottom-right
        ],
        color: [0.5, 0.5, 0.5, 1.0], // Grey
        scale: 30 // Base pixel size (approx)
    },
    [creatures.OCTOPUS]: {
        // Vertices for 2 triangles making a diamond:
        // Top triangle: (0.0, 0.5), (-0.4, 0.0), (0.4, 0.0)
        // Bottom triangle: (-0.4, 0.0), (0.0, -0.5), (0.4, 0.0)
        vertices: [
             0.0,  0.5,  -0.4,  0.0,   0.4,  0.0, // Top triangle
            -0.4,  0.0,   0.0, -0.5,   0.4,  0.0  // Bottom triangle
        ],
        color: [0.8, 0.2, 0.2, 1.0], // Reddish
        scale: 25
    },
    [creatures.WHALE]: {
        vertices: [ // A simple representation of a whale (elongated body)
            // Main body (two triangles forming a quad)
            -0.8,  0.2,   0.8,  0.2,  -0.8, -0.2,
             0.8,  0.2,   0.8, -0.2,  -0.8, -0.2,
            // Tail (a triangle)
             0.8,  0.0,   1.2,  0.3,   1.2, -0.3
        ],
        color: [0.3, 0.4, 0.6, 1.0], // Bluish grey
        scale: 80
    }
};

// This array will hold all active creature instances
let activeCreatures = [];

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

    // Set canvas size
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);

    // Basic clear color
    // Set canvas size
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);

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

    // Get uniform locations
    uResolutionLocation = gl.getUniformLocation(shaderProgram, "u_resolution");
    uDepthLocation = gl.getUniformLocation(shaderProgram, "u_depth");

    // Setup buffer for a full-screen quad
    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    const positions = [
        -1.0, -1.0,
         1.0, -1.0,
        -1.0,  1.0,
        -1.0,  1.0,
         1.0, -1.0,
         1.0,  1.0,
    ];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

    // Get attribute location
    const positionAttributeLocation = gl.getAttribLocation(shaderProgram, "a_position");
    gl.enableVertexAttribArray(positionAttributeLocation);
    gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

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
    creaturePositionBuffer = gl.createBuffer();

    // Basic clear color - might be overridden by shader but good for initial setup
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

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
    requestAnimationFrame(render); // Start render loop
};

function spawnCreature() {
    const randomX = (Math.random() - 0.5) * canvas.width * 0.8; // Spawn within 80% of screen width
    const spawnDepth = currentAltitude; // Spawn at the current depth of the viewer

    let creatureType;
    const randType = Math.random();

    // Define depth ranges for creatures (absolute values, positive for depth)
    const currentDepthPositive = Math.abs(currentAltitude);

    if (currentDepthPositive > 500 && currentDepthPositive < 1500 && randType < 0.33) { // Sharks: 500m - 1500m
        creatureType = creatures.SHARK;
    } else if (currentDepthPositive > 1000 && currentDepthPositive < 2500 && randType < 0.66) { // Octopus: 1000m - 2500m
        creatureType = creatures.OCTOPUS;
    } else if (currentDepthPositive > 2000 && currentDepthPositive < 3800) { // Whales: 2000m - 3800m (less frequent)
        creatureType = creatures.WHALE;
    } else {
        // Don't spawn if not in a specific range or by chance
        return;
    }
    
    if (creatureType) {
         console.log(`Spawning ${creatureType} at depth ${Math.round(spawnDepth)}m, x: ${Math.round(randomX)}`);
        activeCreatures.push({
            type: creatureType,
            x: randomX, // x position in world space (pixels from center of screen horizontally)
            y: spawnDepth, // y position in world space (depth at which it's spawned, matches currentAltitude)
            definition: creatureShapes[creatureType]
        });
    }
}

function render(timestamp) {
    const deltaTime = (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;

    currentAltitude -= descentSpeedMps * deltaTime;
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

    // Use the shader program for the background
    gl.useProgram(shaderProgram);

    // Set uniforms
    gl.uniform2f(uResolutionLocation, canvas.width, canvas.height);
    // Normalize depth: currentAltitude is negative when descending.
    // 0 altitude = 0 depth_normalized.
    // -MAX_DEPTH_FOR_COLOR_TRANSITION altitude = 1 depth_normalized.
    const normalizedDepth = Math.min(Math.abs(currentAltitude) / MAX_DEPTH_FOR_COLOR_TRANSITION, 1.0);
    gl.uniform1f(uDepthLocation, normalizedDepth);

    // Bind the position buffer for the quad
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    // (The vertexAttribPointer setup is done once at init)

    // Draw the quad (2 triangles, 6 vertices)
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- Render Creatures ---
    gl.useProgram(creatureShaderProgram);

    // Set shared uniforms for creatures for this frame
    gl.uniform2f(uCreatureResolutionLocation, canvas.width, canvas.height);
    gl.uniform1f(uCreatureCurrentDepthLocation, currentAltitude); // Pass current camera altitude

    const creatureAttributeLocation = gl.getAttribLocation(creatureShaderProgram, "a_creature_position");
    gl.enableVertexAttribArray(creatureAttributeLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, creaturePositionBuffer); // Bind the generic buffer

    const DESPAWN_DISTANCE_ABOVE_VIEW = 1000; // meters

    for (let i = activeCreatures.length - 1; i >= 0; i--) {
        const creature = activeCreatures[i];
        const creatureDef = creature.definition;

        // Check if creature is too far off-screen
        if (creature.y > currentAltitude + DESPAWN_DISTANCE_ABOVE_VIEW) {
            // console.log(`Despawning creature type ${creature.type} at ${Math.round(creature.y)}m as it's too far above view ${Math.round(currentAltitude)}m`);
            activeCreatures.splice(i, 1); // Remove creature
            continue;
        }

        // Set creature-specific uniforms
        gl.uniform2f(uCreatureTranslationLocation, creature.x, creature.y);
        gl.uniform1f(uCreatureScaleLocation, creatureDef.scale);
        gl.uniform4fv(uCreatureColorLocation, creatureDef.color);

        // Buffer the creature's vertex data
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(creatureDef.vertices), gl.DYNAMIC_DRAW);

        // Setup attribute pointer for this creature's vertices (2 components per vertex)
        gl.vertexAttribPointer(creatureAttributeLocation, 2, gl.FLOAT, false, 0, 0);

        // Draw the creature
        gl.drawArrays(gl.TRIANGLES, 0, creatureDef.vertices.length / 2);
    }
    // gl.disableVertexAttribArray(creatureAttributeLocation); // Optional

    requestAnimationFrame(render);
}

// Handle window resize
window.onresize = function() {
    if (canvas && gl) {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        gl.viewport(0, 0, canvas.width, canvas.height);
        console.log("Resized canvas.");
    }
};
