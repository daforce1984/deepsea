# Deep Sea Explorer

A simple HTML5 and WebGL-based simulation of a descent into the deep sea. Experience the ocean getting darker and encounter various sea creatures like sharks, octopuses, and whales as you descend.

## Features

*   **Dynamic Depth Simulation:** Shows current altitude and a descent speed of 5 km/h (currently accelerated for demonstration purposes).
*   **Atmospheric Background:** The sea color transitions from bright blue at the surface to dark blue/black in the depths, rendered with GLSL shaders.
*   **Sea Creatures:** Sharks, octopuses, and whales appear at different depth ranges.
*   **WebGL Rendering:** All graphics are rendered using HTML5 Canvas and WebGL.

## How to Run

1.  Ensure you have a modern web browser that supports WebGL.
2.  Clone or download the repository.
3.  Open the `index.html` file in your web browser.

The simulation will start automatically.

## Files

*   `index.html`: The main HTML file that sets up the page structure, canvas, and information display.
*   `main.js`: Contains all the JavaScript logic for the simulation, including WebGL initialization, shader loading, rendering loop, descent mechanics, and creature spawning/management.
*   `vertex-shader.glsl`: The GLSL vertex shader for rendering the background.
*   `fragment-shader.glsl`: The GLSL fragment shader for rendering the background, responsible for the color transition with depth.
*   `creature-vertex-shader.glsl`: The GLSL vertex shader for rendering sea creatures, handling their positioning and scaling.
*   `creature-fragment-shader.glsl`: The GLSL fragment shader for rendering sea creatures, applying their colors.
