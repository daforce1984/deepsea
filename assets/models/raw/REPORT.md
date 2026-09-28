# Model sources & ocean light reference (compiled 2026-09-26)

| File | What | Licence / author / source |
|---|---|---|
| shark.glb | great-white style shark, rigged, Swim/Swim_Fast/Swim_Bite | CC0, Quaternius, https://poly.pizza/m/YYsK3gRCBZ |
| shark_lowpoly.glb | simple shark | CC0, Quaternius, https://poly.pizza/m/AyHTK3zUSG |
| turtle.glb | sea turtle (static) | CC-BY 3.0, Poly by Google, https://poly.pizza/m/fklSEvGm1Q8 |
| crab.glb | crab, rigged, idle/walk | CC0, "methodical pixel", https://opengameart.org/content/crab-low-poly-animated-3d-model |
| crab_king_scan.glb | king crab scan (decimated) | Smithsonian 3D nmnhinvertebratezoology_17124161 (verify licence, likely CC0) |
| crab_blue_scan.glb | blue crab scan (decimated) | Smithsonian 3D package b0bf6d44-af22-40dc-bd85-7d66255be4a7 (licence unverified) |
| angler.glb / goblin_shark.glb / blobfish.glb | deep-sea fish, rigged, 6 clips | CC0, Quaternius, poly.pizza MRjSlwCjHM / JQrBevTzgD / 7Jh8vsARfN |
| reef_fish_barramundi.glb | realistic fish (PBR) | CC0, Microsoft, Khronos glTF-Sample-Assets |
| reef_fish_small.glb / reef_fish_clown.glb | school fish | CC0, Quaternius, poly.pizza XWl86YFtpF / BEcU9rjiAq |
| reef_fish_kingfish.glb | silver kingfish | CC-BY 3.0, Poly by Google, https://poly.pizza/m/e_Lkl7E-Tc8 |
| jellyfish.glb | jellyfish (static) | CC-BY 3.0, Poly by Google, https://poly.pizza/m/dA5osnS0Rzj |
| manta_ray.glb | manta ray | CC0, Quaternius, https://poly.pizza/m/yzD8b7ZHZm |
| boat.glb | cabin cruiser | CC-BY 3.0, Poly by Google, https://poly.pizza/m/c2SYxaiPfF3 |
| boat_fishing.glb | trawler | CC-BY 3.0, Poly by Google, https://poly.pizza/m/1ZuSXvhkRg_ |
| flashlight.glb | dive torch | CC-BY 3.0, Robert Ramsay, https://poly.pizza/m/bJaT8R5j3uD |
| rocks_a.glb / rocks_b.glb | rocks | CC0, Quaternius, poly.pizza OQvi8PIZ40 / gYhoEOKItJ |
| coral.glb | tube coral | CC-BY 3.0, Device Lab, https://poly.pizza/m/3HEc6LvqCJd |
| hand_left.glb / hand_right.glb | rigged WebXR hands (25 joints) | MIT, W3C WebXR Input Profiles 1.0.20 (generic-hand) |

## Light
- Jerlov Type I Kd (1/m): 450nm 0.0192, 475nm 0.0182, 550nm 0.0598, 600nm 0.1625, 650nm 0.3567 -> RGB ~ (0.36, 0.06, 0.019).
- Red gone ~10-20 m, orange ~40 m, yellow <100 m, green ~100 m, blue ~200 m (detectable to ~1000 m); ~1% light at 100-200 m.
- Zones (NOAA): euphotic 0-200 m, dysphotic/twilight 200-1000 m, aphotic >1000 m; abyssal plain 3000-6000 m.
- Great white: mostly 0-200 m (350-500 m daytime migration). Leatherback: mostly <300 m, records 1280-1344 m.
- Atolla 300-1500 m, Periphylla 200-1000 m. Anglerfish 200-1500 m; viperfish 200 m to ~4700 m.
Sources: oceanservice.noaa.gov/facts/light_travel.html, manoa.hawaii.edu exploringourfluidearth, rwu.pressbooks.pub webboceanography 6-5, github.com/tishibashi-cpu/jerlov, niwa.co.nz, seaturtlestatus.org, oceanexplorer.noaa.gov/ocean-fact/what-are-abyssal-plains
