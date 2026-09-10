# PolyFish

An interactive underwater ecosystem simulation built with Three.js. Watch fish, dolphins, and manatees hunt, eat, reproduce, and die in a living virtual ocean - complete with procedural kelp forests, physics-driven plankton, and a documentary-style camera system.

Originally built in Unity, ported to run entirely in the browser.

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in your browser. Click anywhere to start the simulation.

## What You're Looking At

PolyFish simulates a self-sustaining underwater food chain:

- **Fish** eat plankton particles spawned by kelp, reproduce when well-fed, and flee from dolphins
- **Dolphins** hunt fish, must surface periodically to breathe, and perform killing sprints
- **Manatees** graze on kelp plants, slowly wandering the ocean floor
- **Kelp** grows from seeds dropped by fish, sways with Verlet-chain physics, and produces food

When the ecosystem collapses (all fish die), the simulation restarts with a new seed.

## Features

- Real-time 3D ecosystem with predator-prey dynamics and metabolism
- GPU-instanced rendering (2,100+ entities at playable framerates)
- Jolt Physics WASM for rigid-body simulation on a Web Worker
- Procedural swim animation via vertex shaders
- Documentary-style auto-camera with depth-of-field
- Underwater caustics and volumetric god rays
- WebXR support with hand tracking (Quest 3), smooth locomotion, and physics-based food throwing
- Narrated introduction sequence with ambient audio
- Cinematic end credits sequence (DOM-based, cross-platform)

## Modes

**Narrative Mode** (default) - Full ecosystem simulation with staged creature introductions, narration, and music. Press `S` to toggle the documentary screensaver camera.

**Model Viewer** - Inspect individual creature models and their skeletal animations. Access via the mode switcher (requires dev mode).

**Editor Mode** - Tune creature physics, animation, and behavior parameters in real-time. Export configs as JSON.

## Controls

| Key | Action |
|-----|--------|
| WASD | Move camera |
| Mouse | Look around |
| Click + drag | Throw food |
| S | Toggle screensaver camera |
| Shift | Sprint |
| Backtick | Toggle debug colliders (dev mode) |
| Backspace | Restart simulation |

## URL Parameters

Toggle features via query string for performance tuning or debugging:

```
?useCaustics=0     Disable underwater caustics
?useGodrays=0      Disable volumetric god rays
?useDOF=0          Disable depth of field
?useSnow=0         Disable marine snow particles
?useInstancing=0   Disable GPU instancing
?debug             Enable debug logging
```

## Capture mode

PolyFish doubles as a test subject for a sibling tool that captures rendered worlds as Gaussian
splats. `?capture=1` puts it in a state that can be photographed from the outside: it enters an
emulated VR session, runs the ecosystem for a warmup and then freezes everything that moves, turns
off fog and every view-dependent effect, hides the VR chrome, keeps the camera rig at the origin, and
exposes `window.__capture` so a driver can set the headset pose, read back the views the frame was
actually rendered from, grab the canvas, and read exact depth.

```
?capture=1&w=1024&h=768&warmup=25&ipd=0.063&fovy=90&depth=1&aa=0
```

| Parameter | Meaning |
|---|---|
| `w`, `h` | per-eye resolution. In stereo the canvas is `2w` wide |
| `ipd` | stereo baseline in metres; `0` renders one mono view per pose |
| `fovy` | vertical field of view in degrees |
| `warmup` | seconds of simulation before the freeze, so kelp and creatures exist |
| `near`, `far` | clip planes, defaulting to 0.1 and 200 rather than the app's 0.08 and 800, because a depth buffer spends its precision near the eye |
| `depth` | render the depth pass |
| `aa` | multisampling. `0` makes frames bit-reproducible |

It is inert without `?capture=1`, and the twelve lines it adds to `main.js` are all behind that flag.
`src/capture/CaptureMode.js` is the whole of it; the tool's side is `docs/fake-headset.md` in the
splattool repo.

**The browser window has to be the canvas size.** The emulated runtime sets the canvas from
`window.innerWidth` when a session starts and builds the projection and viewports from it, so the
window decides the capture resolution. `window.__capture.status().canvasMatchesRequest` says whether
they agree.

## Tech Stack

- **Three.js r170** - 3D rendering and scene management
- **Jolt Physics 1.0** - WASM rigid-body physics with SharedArrayBuffer worker
- **Vite 6** - Dev server and production bundler
- **Vitest** - Unit testing
- **Playwright** - End-to-end testing

## Project Structure

```
src/
  main.js              Entry point, game loop, entity spawning
  config.js            All tunable parameters (creature stats, physics, visuals)
  core/                Physics, object pools, spatial hash, model loading
  entities/            Creature, Food, Plant, Seed (AI, lifecycle, physics)
  rendering/           GPU instancing, shaders, VFX, water surface, god rays
  camera/              Documentary director, cinematographer, depth of field
  input/               Keyboard/mouse, WebXR controllers, mobile joystick
  systems/             Simulation loop, spawners, population monitor, HUD
  modes/               Narrative, model viewer, editor mode system
  audio/               Web Audio API manager for music, narration, SFX
  utils/               Math helpers, terrain queries, texture cache
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for a deep dive into the architecture, physics integration, and entity lifecycle.

## VR (WebXR)

PolyFish supports VR on Quest headsets via WebXR. The dev server uses HTTPS (via `@vitejs/plugin-basic-ssl`) which is required for WebXR.

**Locomotion**: Left thumbstick moves in the direction the left controller points. Right thumbstick smooth-turns the rig.

**Feeding**: Hold the trigger to spawn food in your hand, release to throw. Both controllers work independently.

**Food hold mechanics**: Food uses a lerp-based hold (not scene-graph parenting) for a weighted, underwater feel. The food mesh stays in the scene and lerps toward the controller grip position each frame. Since individual food meshes are never added to the scene directly (all food renders via a shared `InstancedMesh`), held food goes through the same instanced rendering path as free-floating food.

**Throwing**: On trigger release, the controller's `linearVelocity` from the XR API is read and scaled to 0.4× (raw velocity is too fast for underwater). Because smooth turn rotates the Three.js rig rather than the XR reference space, the velocity is rotated by the rig's quaternion to get the correct world-space throw direction. Angular velocity from the controller is carried through as food spin for visual continuity.

**End credits in VR**: When the ecosystem collapses, the scene fades to black via a tint sphere, then the XR session is ended and DOM-based credits play on the flat screen.

## Development

```bash
npm run dev          # Dev server with hot reload
npm run build        # Production build to dist/
npm run test         # Run unit tests
npm run test:watch   # Watch mode
```

## Making Of

The project includes an interactive series of articles documenting how PolyFish was built, available at `/making-of/` when running the dev server:

- **Origins** - Project history and the Unity-to-Three.js port
- **Creatures** - AI behavior, state machines, and procedural animation
- **Ecosystem** - Food chain dynamics, metabolism, and population balance
- **Kelp** - Verlet chain physics, ocean currents, and plant lifecycle
- **Rendering** - Shaders, caustics, god rays, and GPU instancing
- **Camera** - Documentary director system and cinematic shot types
- **Audio** - Narration, ambient soundscapes, and Web Audio integration
- **Performance** - Profiling, optimization passes, and frame budget management

## Deployment

The project deploys as a static site. A `vercel.json` is included for Vercel hosting (sets required COOP headers for SharedArrayBuffer support).

## Third-Party Assets

Audio assets are used under Creative Commons licenses. See attribution files in `assets/audio/` for details. 3D models are original work.

## Contact

Questions or feedback? [Open an issue](https://github.com/occ-matt/polyfish/issues) on this repo, or find me on [Bluesky](https://bsky.app/profile/mattscott.dev).

## License

MIT - see [LICENSE](LICENSE) for details.
