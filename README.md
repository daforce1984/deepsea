# Deep Sea Explorer

A simple HTML5 and WebGL-based simulation of a descent into the deep sea. Experience the ocean getting darker and encounter various sea creatures like sharks, octopuses, and whales as you descend.

## Features

*   **Dynamic Depth Simulation:** Shows current altitude and a descent speed of 5 km/h (currently accelerated for demonstration purposes).
*   **Atmospheric Background:** The sea color transitions from bright blue at the surface to dark blue/black in the depths, rendered with GLSL shaders.
*   **Sea Creatures:** Sharks, octopuses, and whales appear at different depth ranges.
*   **WebGL Rendering:** All graphics are rendered using HTML5 Canvas and WebGL.

## How to Run

The primary way to run the simulation is by opening the `index.html` file directly in a modern web browser that supports WebGL:

1.  Ensure you have a modern web browser that supports WebGL.
2.  Clone or download the repository.
3.  Open the `index.html` file in your web browser (e.g., by double-clicking it or using `file:///` path).

The simulation should start automatically.

### Using `run_server.bat` (Windows)

Alternatively, if you are on Windows and have Python installed (and added to your PATH), you can use the `run_server.bat` script:

1.  Double-click the `run_server.bat` file in the project root directory.
2.  This will attempt to open the simulation in your default web browser at `http://localhost:8888/index.html` and start a local Python HTTP server on port 8888.
3.  If the browser opens before the server is fully ready, you might need to refresh the page after a moment.
4.  To stop the server, close the command prompt window that opens, or press `Ctrl+C` in it.

This method can be helpful if opening `index.html` directly via `file:///` causes any browser security restrictions with certain features (like fetching shader files in some stricter browser configurations, though this project is designed to work directly via `file:///` where possible).

## Files

*   `index.html`: The main HTML file that sets up the page structure, canvas, and information display.
*   `main.js`: Contains all the JavaScript logic for the simulation, including WebGL initialization, shader loading, rendering loop, descent mechanics, and creature spawning/management.
*   `vertex-shader.glsl`: The GLSL vertex shader for rendering the background.
*   `fragment-shader.glsl`: The GLSL fragment shader for rendering the background, responsible for the color transition with depth.
*   `creature-vertex-shader.glsl`: The GLSL vertex shader for rendering sea creatures, handling their positioning and scaling.
*   `creature-fragment-shader.glsl`: The GLSL fragment shader for rendering sea creatures, applying their colors.
