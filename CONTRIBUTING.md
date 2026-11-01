# PolyFish Three.js — Developer Guide

Welcome! This guide will help you quickly understand the codebase and contribute meaningfully to the PolyFish ecosystem simulation.

## Project Overview

**PolyFish** is an interactive underwater ecosystem simulation originally built in Unity, now ported to Three.js. It showcases a multi-species food chain where creatures (fish, dolphins, manatees) hunt, eat, reproduce, and die in a living virtual ocean. Plants (kelp) produce food, which creatures consume to survive.

### Core Experience
- **Narrative Mode**: Full ecosystem simulation with staged creature spawning, narration, and music
- **Model Viewer**: Inspect 3D creature models and animations
- **Editor Mode**: Tune creature parameters and experiment with behavior

## Tech Stack

- **Three.js r170** — 3D rendering
- **Jolt Physics WASM** — 3D rigid-body physics and collision detection
- **Vite** — dev server and bundler
- **Vitest** — unit testing
- **Playwright** — e2e testing

Key design principle: **Object pooling** for all entities (creatures, food, plants, seeds). The game loop is optimized to avoid per-frame allocations.

## Getting Started

### Install & Run

```bash
npm install
npm run dev      # Start dev server (opens http://localhost:3000)
npm run build    # Production build
npm run preview  # Preview built output
npm run test     # Run tests
npm run test:watch
```

### File Structure

```
PolyFish_ThreeJS/
├── src/
│   ├── main.js                      # Entry point: init, game loop, spawning
│   ├── config.js                    # All tunable parameters
│   ├── core/
│   │   ├── JoltWorld.js             # Physics world singleton
│   │   ├── ObjectPool.js            # Generic object pooling
│   │   ├── PhysicsBody.js           # Wrapper for creature physics state
│   │   ├── VerletChain.js           # Soft-body Verlet for kelp
│   │   ├── ModelLoader.js           # GLB model preloading & caching
│   │   ├── ProceduralRig.js         # Bone generation for kelp
│   │   ├── SpatialHash.js            # 2D grid hash for O(nearby) entity queries
│   │   ├── DebugColliders.js        # Wireframe collision visualization
│   │   └── DebugForceHUD.js         # Camera-attached global force indicator
│   ├── entities/
│   │   ├── Creature.js              # Fish, dolphin, manatee AI & physics
│   │   ├── Plant.js                 # Kelp — eats by manatees, produces food
│   │   ├── Food.js                  # Plankton particles — consumed by creatures
│   │   └── Seed.js                  # Germinates into plants
│   ├── rendering/
│   │   ├── SwimMaterial.js          # Procedural vertex shader swim animation
│   │   ├── IBLMaterial.js           # PBR materials with image-based lighting
│   │   ├── SceneManager.js          # Three.js scene, camera, renderer
│   │   ├── MarineSnow.js            # Floating particle background
│   │   ├── ParticleBurst.js         # Eating/death effect particles
│   │   ├── FadeOverlay.js           # Fade-to-black transitions
│   │   ├── VREndScreen.js           # End-of-simulation credits sequence (unified DOM overlay for desktop + VR)
│   │   ├── CausticShader.js         # Procedural underwater caustic lighting
│   │   └── WaterSurface.js          # GPU wave animation for ocean surface
│   ├── camera/
│   │   ├── DocumentaryDirector.js   # Editorial brain: shot sequencing, phase management
│   │   ├── Cinematographer.js       # Per-frame camera position/lookAt for 11 shot types
│   │   ├── EcosystemScout.js        # Event detection: chases, kills, feeding moments
│   │   └── CinematicDOF.js          # Depth-of-field post-processing (EffectComposer)
│   ├── input/
│   │   ├── CameraController.js      # FPS + documentary screensaver modes
│   │   └── FeedingInput.js          # Player food throwing (click + drag)
│   ├── systems/
│   │   ├── SpawnerSystem.js         # Waste spawner (plants produce food)
│   │   ├── PopulationMonitor.js     # Restart when ecosystem crashes
│   │   ├── NarrationSystem.js       # Audio narration timeline
│   │   └── ProceduralAnim.js        # Unused: old animation system
│   ├── modes/
│   │   ├── SceneMode.js             # Base class
│   │   ├── NarrativeMode.js         # Full simulation + narration
│   │   ├── ModelViewerMode.js       # Inspect creatures
│   │   ├── EditorMode.js            # Parameter tweaking
│   │   └── SceneModeManager.js      # Mode switching logic
│   ├── audio/
│   │   └── AudioManager.js          # Music & narration playback
│   ├── utils/
│   │   ├── MathUtils.js             # randomRange, easeOutCubic, distSq, etc
│   │   └── Terrain.js               # Terrain heightmap & collision queries
│   └── index.html                   # HTML entry point
├── assets/                          # GLB models, audio files, etc
├── tests/                           # Unit tests
├── e2e/                             # Playwright e2e tests
├── vite.config.js
└── package.json
```

## Architecture Overview

### Entity Lifecycle

All dynamic entities (creatures, food, plants, seeds) use **object pooling** for efficiency:

```
[POOL] ← get() → [ACTIVE] → update/draw → die → deactivate() → [POOL]
```

1. **Pool State** (`active = false`): Entity is dormant, waiting for reuse
2. **Activate** (`get()`, set `active = true`): Initialize physics, visibility, AI state
3. **Update** (`update(dt, ...)`): AI, physics, rendering per-frame
4. **Deactivate** (`deactivate()`): Hide mesh, remove physics bodies, reset state → back to pool
5. **Recycle** (repeat): Next call to `get()` reuses the same object

### Game Loop (main.js)

```javascript
init()
  ↓
// Per-frame (60 Hz)
gameLoop()
  ├─ Physics: joltWorld.step(dt)
  ├─ Update all creature pools: creature.update(dt, targets, callbacks)
  ├─ Update food pool: food.update(dt)
  ├─ Update seed pool: seed.update(dt, ...)
  ├─ Update plant pool: plant.update(dt, elapsed)
  │  └─ Verlet chains for creature-plant collisions
  ├─ Spawner system: plant.produceFood() → spawnFood()
  ├─ Camera & input: cameraController.update(dt)
  │  └─ Screensaver: scout.update() → director.update() → cinematographer.computeFrame()
  ├─ Mode-specific updates: modeManager.update(dt)
  └─ Render: sceneManager.render() or cinematicDOF.render() (if DOF toggled on)
```

### Restart Cycle (main.js)

When the ecosystem crashes (all fish eaten, zero population):

1. **Debug cleanup**: `debugColliders.removeAll()` sweeps any lingering debug visuals
2. **Full teardown**: `destroyAll()` on all 6 object pools (creature pools, food, seed, plant)
   - Deactivates all active items (each entity's `deactivate()` cleans up its own debug objects, Jolt bodies, etc.)
   - Removes meshes from scene
   - Clears arrays
3. **Audio stop**: `stopAll()` kills audio sources with `onended=null` to prevent ghost callbacks
4. **End sequence** (`VREndScreen`): Cinematic credits sequence with phased transitions:
   - Unified DOM overlay for both desktop and VR (WebXR `dom-overlay` feature)
   - Tint sphere darkens the 3D scene; HTML/CSS credits render identically on both platforms
   - Phases: `stopping` → `fading` (scene darkens to ~88%) → `reveal` (credits fade in) → `scrolling` (film-style upward scroll) → `finale` (fade to full black) → `done` (page reload)
   - Dev shortcut: Press `0` in dev mode (`?dev=true`) to trigger immediately
5. **Page reload**: After credits complete, the page reloads to restart fresh

Triggered by `PopulationMonitor` when active creature count reaches 0. Dev trigger bound to `0` key in dev mode.

### Configuration System (config.js)

**All tunable parameters** are in `/src/config.js`:

```javascript
CONFIG = {
  creatures: {
    fish: { speed, foodToReproduce, energyUsedPerMinute, ... },
    dolphin: { killSprint: true, oxygen: { depleteRate, refillRate, surfaceY, urgentThreshold, criticalThreshold }, ... },
    manatee: { ... },
  },
  plant: { collisionRadius, foodRateYoung, ... },
  poolSizes: { fish: 60, food: 80, ... },
  boundary: { radius, yMin, yMax, ... },
  waterSurface: { noiseStrength, noiseSpeed, noiseScale, ... },
  caustics: { intensity, scale, speed, fadeDepth, distanceFade },
  ambientLightIntensity, directionalLightIntensity,
  // ... 100+ more knobs
}
```

Changes apply on next `activate()` or require manual reset. No hot-reload yet.

## Key Systems Explained

### 1. Physics Integration (Jolt WASM)

**File**: `/src/core/JoltWorld.js`, `/src/core/PhysicsBody.js`

Creatures are **rigid bodies** in a 3D physics world:

```javascript
// Create a capsule for a creature
const capsule = new Jolt.CapsuleShape(halfHeight, radius);
const bodyID = joltWorld.createBody(
  capsule,
  position,
  rotation,
  Jolt.EMotionType_Dynamic,
  LAYER_MOVING,
  { mass: 2.0, drag: 2.27, restitution: 0.1 }
);
```

**Collision layers**:
- `LAYER_STATIC` (0): Terrain, plants (no collision with each other)
- `LAYER_MOVING` (1): Creatures, seeds, food (collide with static & moving)

**Physics loop** (runs on a Web Worker via `PhysicsProxy`):
1. AI computes desired velocity → queued as commands in the SharedArrayBuffer command buffer
2. Main thread calls `physicsProxy.step(dt)` which writes control flags using `Atomics.store` and notifies the worker
3. Worker reads commands, calls `joltWorld.step(dt)`, writes resolved transforms back to the SharedArrayBuffer
4. Worker signals completion via `Atomics.store` on the `STEP_COMPLETE` control flag
5. Main thread reads back resolved positions from the shared transform buffer

**Atomics requirement**: All control flag reads/writes use `Atomics.store`/`Atomics.load` via an `Int32Array` view over the control region. This ensures correct memory ordering on ARM devices (e.g. Quest) where the weak memory model can reorder plain SharedArrayBuffer writes, causing stale position reads and visual flickering.

**Important**: DO NOT call `SetPosition()` mid-frame. Instead, set **velocity** and let Jolt integrate.

**Body slot validation**: `physicsProxy.createBody()` returns `-1` when out of body slots. All entity code must treat `< 0` as `null` — otherwise `getPosition(-1)` silently returns `(0,0,0)`, causing entities to teleport to world origin. The pattern is: `const slot = createBody(...); this.joltBodyID = slot >= 0 ? slot : null;`

### 2. Entity Types & Behavior

#### Creatures (Fish, Dolphin, Manatee)

**File**: `/src/entities/Creature.js`

Creatures are **state machines** with multiple behaviors:

1. **Seeking** (idle): Look for food within range
2. **Chasing** (thrusting): Move toward target, face it, accelerate
3. **Eating** (cooldown): In mouth radius → gain energy → reproduce or waste
4. **Fleeing**: Sprint away from predators at 3.5x throttle (stamina-gated)
5. **Kill Sprint** (dolphins only): 3.5x killing dart when aligned with prey (cooldown + stamina)
6. **Oxygen** (dolphins only): Must surface to breathe; each meal burns 33% of max O₂, plus passive drain (~60s to empty). Overrides all AI when low

**AI Loop** (priority chain):

```
oxygen check (dolphins only)
  ↓
flee from predators
  ↓
hunt food
  ↓
engine burn
```

**Death States**:
- Creature remains visible for 3–5 seconds as a corpse
- Other creatures can eat corpses (manatees eat dead fish)
- Dead creatures float belly-up with smooth rotation
- Creatures eaten by dolphins disappear instantly
- Finally decomposes → spawns plant at death location

**Spawn Scale-in**: Creatures start at 0.01x scale, grow over 4 seconds using ease-out cubic. Jolt physics body is created AFTER scale-in completes.

**Growth & Reproduction**:
- Each eaten food increments `reproFoodCounter`
- When `reproFoodCounter >= foodToReproduce`, trigger `onReproduce()` callback
- Offspring spawn at parent position + random offset (2.0–3.5 units) to prevent stacking
- Offspring inherit parent speed (mutation): `parentSpeed * randomRange(0.8, 1.2)`
- Creature scales with food eaten: `scale = base * (1 + reproFoodCounter / foodToReproduce)`

**Separation Force**: A soft inverse-distance repulsion pushes same-type creatures apart when closer than 1.5 units, using a spatial hash (`SpatialHash`, cell size 5) for O(nearby) lookups instead of brute-force iteration. This prevents visual stacking when multiple creatures converge on the same food source. LOD-aware: LOD 2 creatures skip separation entirely, LOD 1 runs every other frame.

**Metabolism** (if enabled):
- Drain energy every `metabolicClock` seconds (default 2s)
- Drain = `energyUsedPerMinute * (metabolicClock / 60)`
- If energy hits 0 → die of starvation
- Food restores energy by `foodEnergy` amount

#### Plants (Kelp)

**File**: `/src/entities/Plant.js`, `/src/core/VerletChain.js`

Plants use **Verlet soft-body physics** instead of rigid bodies:

```
Anchor (base)
  ↓
Node 0 ← Node 1 ← ... ← Node N (tip)
```

Each node has:
- Position (pos, prev for Verlet integration)
- Rest position (anchor in place)
- Impulse (from creature collisions)

**Three force systems**:

1. **Ocean Current**: Directional oscillating flow field that varies with height & time
   - Primary wave swings back and forth along a dominant direction (`currentDirection`, default ~34°)
   - Secondary cross-axis sway adds organic feel perpendicular to the primary
   - `currentDirectionBias` (0–1) controls directional vs oscillation blend (default 0.7)
   - Amplitude = `currentAmplitude * heightFactor²` — tips sway more than base
   - Phase shifts along the chain height → traveling wave up the stalk
   - Slow frequency (`currentSpeed` 0.15) for long, natural wave cycles

2. **Creature Collision (drag-along)**: When a creature swims through the plant
   - Direct position displacement on contact (75% of force) — immediate, localized bend
   - Smaller impulse (25%) for trailing wrap/wake — spreads gently to neighbors
   - Squared falloff (`closeness²`) — closest nodes bend hard, edges barely react
   - Low impulse spread (0.2) keeps reaction localized rather than stiffening the whole chain
   - Per-plant randomized Verlet params: inertia (0.82–0.90), amplitude (0.60–0.85), speed (0.60–0.80), buoyancy (0.35–0.45) for natural forest variation

3. **Buoyancy**: Upward force across the whole chain, stronger toward the tip, keeping stalks upright

**Verlet Iteration** (per frame):
```
for each node:
  apply inertia (carry momentum from prev frame)
  apply buoyancy (full chain: all nodes float upward, stronger at tips)
  apply ocean current (directional oscillation based on height + time)
  apply restoring spring (loose XZ: 0.008, firm Y: 0.06)
  enforce distance constraints (3 passes)
  pin bottom 3 nodes toward rest (linear taper 0.5→0)
```

**Food Production**:
- Young plants: produce food every 2 seconds
- Old plants (80%+ lifespan): slow down to 8 seconds
- Food spawns from lower-mid section of the stalk (25–55% height) so food hangs around the middle of the kelp column, not the tips
- Each food spawned with upward ejection force
- Spawns registered with `SpawnerSystem`

**Health & Damage**:
- Plants have 4 health points
- Each creature bite: `-1 health`
- Smooth shrink animation (0.6s ease-out cubic) interpolates from current scale to new reduced scale — no instant popping
- At 0 health: die immediately

**Manatee Grazing Targets**:
- When a manatee picks a plant as food, it locks onto a specific Verlet node (25–50% height)
- The node index is cached per-target — the manatee navigates to the same node until it eats or picks a new plant
- The eating check uses the same grazing node position, not the plant's midpoint
- The target sways with the kelp in real time (live Verlet node position)

#### Food (Plankton)

**File**: `/src/entities/Food.js`

Procedural **stellated octahedron** geometry (radiolarian-like spikes):

```javascript
// 8 faces, each extruded into a spike
export function createPlanktonGeometry(coreRadius, spikeLength) { ... }
```

Physics:
- Jolt sphere collider (radius = `targetScale * 0.12`) for collision with creatures and terrain
- Bouncy physics material: restitution 0.95, friction 0.05, low damping — food bounces off creatures
- AI velocity synced to Jolt each frame; collision-corrected position read back
- Floats (no gravity via PhysicsBody), gentle spin that decays to idle tumble
- Despawns after ~10 seconds of age (configurable, shorter for old plants)

**Interaction**:
- Creatures detect food in **mouth radius** (0.15m for fish, 0.5m for manatees)
- On eating: emit particle burst, increment food counter, despawn
- Food Jolt body removed on deactivate and during full restart teardown

#### Seeds (Plant Reproduction)

**File**: `/src/entities/Seed.js`

Hard octahedron geometry, bounces until landing:

```
activate() → fall & bounce → hasLanded=true → tick germination timer
  → if germinated & noDensityCrowd → spawnPlant() → deactivate()
```

**Germination Logic**:
- Base chance: 45%
- Check nearby plant count within radius 1.33m
- Reduce chance by 12% per nearby plant
- Floor at 5% (always a small chance)

### 3. Creature AI (Steering & Movement)

**File**: `/src/entities/Creature.js` (lines 315–500)

#### Target Finding

```javascript
findFood(targets) {
  let closest = null
  for each target in searchList:
    if closer than previous closest:
      closest = target

  // Manatees prefer a different plant than last one eaten
  // Dolphins scavenge corpses if no live prey
  this.foodTarget = closest || fallback
}
```

#### Facing & Turning

```javascript
faceTarget(dt) {
  direction = (target - position).normalize()

  // Three.js lookAt: rotate Z toward target
  // Compute smooth rotation to face it
  this.mesh.lookAt(targetPos)
}
```

**Turn Banking**:
- Compute yaw rate by comparing forward vector frame-to-frame
- Bank angle = `yaw * 0.15` (proportional to turn rate)
- Smooth transitions: `bankAngle += (targetBank - bankAngle) * 4 * dt`
- Applied as local Z-roll on top of physics rotation

#### Engine Burn Cycle

Creatures pulse their thrust in bursts:

```
enginesOn = true  → burn for engineBurnTime → coast → find new target → repeat
```

This modulates:
- **Throttle** (`_throttle`): 0.2–1.0, controls thrust magnitude
- **Swim animation phase**: Tail flaps faster when engines fire
- **Food-finding cadence**: Only scan for food after each burn cycle, not every frame

#### Thrust & Steering

```javascript
updateEngine(dt) {
  // Continuous forward thrust (impulse mode in Unity)
  if (joltBodyID) {
    const thrustForce = direction * speed * thrustMultiplier * throttle
    applyForce(thrustForce)
  }

  // Boundary steering (soft wall)
  if (distance > boundaryRadius) {
    steer += (center - pos).normalize() * steerForce
  }
}
```

### 4. Rendering Pipeline

#### SwimMaterial (Vertex Shader Animation)

**File**: `/src/rendering/SwimMaterial.js`

Injects procedural **sine-wave undulation** into the vertex shader:

```glsl
// Vertex displacement: travels from head to tail
float bodyCoord = normalized_position_along_z_axis; // 0=head, 1=tail
float wavePhase = bodyCoord * frequency - uPhase;
float wave = sin(wavePhase) * amplitude;
transformed.x += wave;  // or .y for dolphins (vertical swim)
```

**Key features**:
- `uPhase`: Accumulated in JS per frame (smooth, non-time-based)
- `uAmplitude`: Blended between idle, thrust, coast states
- `uMaskStart`: Head region (eyes) doesn't undulate → stays rigid
- `uHeadPhase`: Delayed phase for head to follow body
- Per-creature configs in `SWIM_CONFIGS`

**Material Reuse** (critical optimization):
- Shader programs are cached by Three.js
- If you create new uniforms AFTER compilation, the shader keeps using the old ones
- Solution: Store uniforms on `material._swimUniforms`, reuse across activate cycles
- See `applySwimMaterial()` for the workaround

#### IBL Material (Lighting)

**File**: `/src/rendering/IBLMaterial.js`

PBR `MeshStandardMaterial` with image-based lighting:

```javascript
createIBLMaterial({
  roughness: 0.9,
  metalness: 0,
  flatShading: true  // terrain
})
```

Provides realistic lighting without real-time lights (performance win).

#### Scene Manager

**File**: `/src/rendering/SceneManager.js`

Singleton managing:
- Three.js scene, camera (PerspectiveCamera, FOV 80°) — camera is added to the scene so camera-parented children (e.g. DebugForceHUD) render
- WebGL renderer with PCFSoftShadowMap shadows (2048×2048)
- Fog (linear, 0–35m depth — pulled close for atmospheric density)
- Directional light (sun, intensity 2.7) with 2048×2048 shadow map (shadow strength 1.0, normalBias 0.02)
- Ambient light (intensity 5.25, constant underwater glow)
- Hemisphere light (blue sky/warm floor, intensity 0.3)

#### Ocean Surface (Underwater Ceiling)

**File**: `/src/main.js` (`createWaterSurface()`), `/src/rendering/WaterSurface.js`

A faceted plane mesh positioned at dolphin breathing height, visible only from below (underwater looking up). Creates the visual impression of looking up at the ocean surface from underwater.

**Construction** (in `createWaterSurface()`):
- 200×200 plane, 120 segments (matching terrain density ~1.6 units/segment)
- `rotateX(Math.PI/2)` → normals face DOWN → `FrontSide` renders from below
- Vertex jitter applied before `toNonIndexed()` for organic feel
- `toNonIndexed()` + `computeVertexNormals()` + `flatShading: true` → faceted low-poly look
- RGBA per-face vertex colors with edge alpha fade (dissolves from 60% center outward)
- `transparent: true`, `opacity: 0.75`, `depthWrite: false` — semi-transparent but clearly visible surface
- `metalness: 0.4`, `roughness: 0.15`, `envMapIntensity: 1.5` — shiny, reflective water catching specular highlights
- `renderOrder: 999` to render after opaque objects

**GPU Wave Animation** (in `WaterSurface.js`):
- `material.onBeforeCompile` injects vertex shader code via `#include <begin_vertex>` replacement
- **Macro motion**: 3 overlapping sine waves at different angles (X-axis, Z-axis, diagonal) to break stripe patterns. Amplitude = `1.25 * noiseStrength`
- **Micro roughness**: 2 high-frequency chop waves at varied angles for surface texture detail (reduced from 4 for performance). Amplitude = ~18% of macro. Speed = ~1.15× macro speed
- Config baked into shader as constants at compile time (`noiseStrength`, `noiseSpeed`, `noiseScale`)
- Only `uTime` uniform updates per frame — all displacement computed on GPU

**Dedicated underlight** (layer isolation):
- `DirectionalLight(0xaaddff, 2.5)` pointing UP from below the surface
- Light set to `layers.set(1)`, surface mesh has `layers.enable(1)`
- This restricts the underlight to only illuminate the surface mesh, not creatures or terrain

**Height positioning**:
- Surface Y = tallest kelp tip + 3 + max wave amplitude (so wave troughs don't dip below the logical surface)
- Height is locked once set via `userData.heightLocked` flag — prevents dynamic repositioning

#### Terrain (Seabed)

**File**: `/src/main.js` (`createPlaceholderTerrain()`)

The ocean floor is a single faceted plane mesh with edge fade:

- 512×512 plane, 200 segments — reduced from 320 for performance (~60% fewer vertices)
- Height displacement via `sin(x*0.05) * cos(z*0.04) * 2.0` offset to -7.81
- `toNonIndexed()` + `computeVertexNormals()` + `flatShading: true` → faceted triangles
- RGBA vertex colors (muted olive-brown) with edge alpha fade starting at 60% from center
- `transparent: true`, `depthWrite: true` — depth writing enabled to prevent gap artifacts between triangles
- Terrain is static (no wave animation registered)
- Camera start position raycasted onto terrain surface + 0.5 eye height

#### Underwater Caustics

**File**: `/src/rendering/CausticShader.js`

Procedural animated light caustics projected onto all scene surfaces, simulating light refracting through the wavy water surface above. Applied via `onBeforeCompile` shader injection (same chaining pattern as SwimMaterial).

**Algorithm**: Dual-layer F2-F1 Voronoi noise with two-octave domain warping. F2-F1 (second-nearest minus nearest cell distance) produces bright lines at cell boundaries — the characteristic underwater caustic web/net pattern. The domain warp distorts the Voronoi grid with layered value noise so cells appear organic and flowing rather than geometrically rigid.

**Projection**: Tilted top-down — primarily XZ plane but blends in Y component (`worldPos.xz + worldPos.y * vec2(0.3, 0.2)`) so vertical surfaces like the logo show curved patterns instead of vertical streaks.

**Fading layers** (all multiplicative):
- **Depth fade**: Quadratic falloff below surface (`1 - t²`, where t = depth/fadeDepth). Strongest near surface, fading to zero at `fadeDepth` (30 units)
- **Distance fade**: Smoothstep from camera position. Full strength within `distanceFade` (25 units), fading to zero at 1.6× that distance. Prevents caustics from popping through distant fog
- **Normal gate**: `smoothstep(-0.1, 0.3, normal.y)` — only upward-facing surfaces receive caustic light. Ceilings and steep walls are excluded

**Per-material boost**: `applyCaustics(material, boost)` accepts an optional intensity multiplier. Terrain uses 1.0×, creatures/plants/food/seeds/logo use 2.0× so caustics are more visible on objects than on the ground.

**Shared uniforms**: All patched materials reference a single `_sharedUniforms` object. One `updateCausticTime(elapsed)` call per frame updates all materials simultaneously.

**Config** (`config.js → caustics`):
- `intensity`: 0.09 — global brightness
- `scale`: 0.22 — spatial frequency (lower = larger cells)
- `speed`: 0.4 — animation speed
- `fadeDepth`: 30.0 — depth below surface where caustics disappear
- `distanceFade`: 25.0 — camera distance where fade begins

**Shader early-out**: The fragment shader computes cheap fade factors (normal facing, depth fade, camera distance) before the expensive Voronoi. If combined fade < 0.01, the Voronoi is skipped entirely — saving GPU cycles on surfaces that wouldn't show caustics anyway.

**Material patching order**: IBLMaterial creates base material → `applyCaustics()` patches it → `applySwimMaterial()` chains on top. Each hook saves the previous `onBeforeCompile` and calls it first.

#### Particle Effects

**File**: `/src/rendering/ParticleBurst.js`

Emits ~30 particles when:
- Creature eats food
- Creature dies
- Plant is damaged
- Plant decomposes

Particles: fast, colored points that fade out over 0.5s.

### 5. Title Screen & Camera Start

**File**: `/src/main.js` (`setupTitleScreen()`, `handleTitleClick()`)

On load, the app shows a title screen with a 3D "PolyFish" logo sitting on the seabed:

- Logo model loaded from GLB, colored with sampled fish vertex colors + emissive glow (30% of fish color)
- Camera position determined by raycasting down from (0, 50, 6.44) to find the terrain surface, then placing the camera at terrain height + 0.5 eye height
- Logo positioned at camera Y + 3.0, in front of camera at Z=-1
- "CLICK TO BEGIN" HTML overlay appears below the logo
- On click: logo fades out (1.5s ease), seed drops from above camera, narrative mode begins
- Camera target and position also raycast-aligned in `NarrativeMode.enter()` for mode switches

**Important**: Raycaster filters to `isMesh` objects only (skipping Sprites) to avoid `raycaster.camera` errors.

### 6. Input & Camera System

**File**: `/src/input/CameraController.js`

#### FPS Mode (Default)

- **WASD**: Move forward/back/strafe
- **Mouse**: Look around (pointer lock)
- **Shift**: Sprint (1.8x speed)
- **Tab**: Toggle screensaver

Physics:
- Acceleration: 30 units/s²
- Friction: 6.0 (snappy stops)
- Max speed: 1.5 normal, 2.7 sprint

#### Screensaver Mode (Documentary Camera System)

**Files**: `/src/camera/DocumentaryDirector.js`, `/src/camera/Cinematographer.js`, `/src/camera/EcosystemScout.js`, `/src/camera/CinematicDOF.js`

A nature-documentary-style camera system with three specialized modules:

- **Director** — editorial brain managing shot sequencing, narrative phase transitions, and timing
- **Cinematographer** — computes per-frame camera position/lookAt for each shot type with lead room and composition
- **Scout** — detects dramatic moments (chases, kills, feeding) and recommends interrupts

**11 Shot Types**:

1. **ESTABLISHING_WIDE**: High, slow orbit showing full reef (24–36s)
2. **HERO_PORTRAIT**: Medium close-up orbiting a creature with rule-of-thirds composition (18–30s)
3. **CHASE_FOLLOW**: Behind predator with heavy lead room, prey visible ahead (9–15s)
4. **SIDE_TRACK**: Perpendicular to creature at eye level, profile view (15–27s)
5. **GROUND_HIDE**: Static on seafloor, creatures pass through — classic nature doc hide cam (15–27s)
6. **SNELLS_WINDOW**: Low angle looking up through water column (24–36s)
7. **SLOW_REVEAL**: Starts tight on subject, pulls back to reveal scale (30–45s)
8. **FLY_THROUGH**: Smooth dolly between two points of interest (18–30s)
9. **REACTION_CUT**: Quick cut to creature reacting — fleeing, eating (6–12s)
10. **MACRO_DETAIL**: Very tight, shallow DOF, bokeh background (18–30s)
11. **KELP_EDGE**: Peripheral kelp edge, looking up/inward at ~75° (18–30s)

**5 Narrative Phases** (state machine cycling):

```
ESTABLISHING (2-3 shots) → INTRODUCE (2-4) → DEVELOP (3-5) → CLIMAX (1-2) → RESOLVE (2-3) → cycle
```

Each phase has a preferred shot pool. CLIMAX is intentionally short to keep tension impactful before cycling back to contemplative phases.

**Shot Selection**: Candidates are scored by "visual distance" (angle, size, motion, subject type differences) from the previous shot. Top half of scores are picked randomly for variety without repetition.

**Scout Interrupts**: The Scout detects dramatic ecosystem events. EPIC events (kills, births) can interrupt at any time past `MIN_SHOT_DURATION` (6s). HIGH events only interrupt past 50% of the current shot. Interrupts no longer force the CLIMAX phase — they count as a shot in whatever phase is active.

**Transitions**: All shot changes use fade-to-black. CUT transitions (scout interrupts) teleport the camera to the new position during the black hold frame.

**Motion Safety**: Multi-layer velocity clamping prevents jarring camera movement:
- Position clamp: 0.5 units/sec max
- LookAt clamp: 1.0 units/sec max
- Angular velocity clamp: 30°/sec max
- Soft sphere collision pushes camera away from creatures

**Letterbox Bars**: Cinematic 2.0:1 black bars appear at top/bottom when entering screensaver mode, with 0.8s CSS transition animation. The gentle ratio sits at title-safe edges rather than aggressively cropping into the frame. Auto-adjusts on window resize.

**Keyboard Controls** (screensaver mode only):
- **G**: Cycle grid overlay (off → rule of thirds → golden ratio → center cross + safe zones)
- **I**: Toggle debug HUD (shot type, phase, elapsed time, velocity telemetry)
- **D**: Toggle depth-of-field post-processing (routes through EffectComposer)
- **V**: Toggle vignette effect (lazily creates ShaderPass on first enable)

**Subject Tracking Reticle**: When grid overlay is active, a red crosshair circle tracks the current subject's screen-space position, showing framing relative to composition guides.

**DOF System** (`CinematicDOF.js`):
- Three profiles: DEEP (f/16-22, everything sharp), MEDIUM (f/5.6-8, subtle blur), SHALLOW (f/2.8, isolated subject)
- BokehPass for depth-of-field blur
- Optional vignette ShaderPass (disabled by default, toggle with V key)
- EffectComposer uses HalfFloatType render target to minimize color space issues
- Note: When DOF is active, slight darkening occurs due to EffectComposer intermediate framebuffer handling with sRGB color space

### 7. Food Throwing (Player Input)

**File**: `/src/input/FeedingInput.js`

- **Click & hold**: Summon food in front of camera, "held" state
- **Drag back**: Prime throw (force = drag distance * 10)
- **Release**: Lob food toward cursor + force, apply Jolt impulse
- While held: food pinned to follow camera position

Used only in **Narrative mode**.

### 8. Object Pooling (Core Optimization)

**File**: `/src/core/ObjectPool.js`

Generic pool for any reusable object:

```javascript
const fishPool = new ObjectPool({
  factory: () => {
    const creature = new Creature(mesh, 'fish')
    return creature
  },
  initialSize: 60,
  canGrow: true
})

// Get & activate
const fish = fishPool.get()
fish.activate(position)

// Deactivate & return
fish.deactivate()
```

**Key methods**:

- `get()`: Find inactive item or create new; mark active
- `release(item)`: Mark inactive, remove from active array (swap-remove O(1))
- `forEachActive(fn)`: Iterate active items, auto-clean stale entries
- `getActiveCount()`: Current active count (may include stale until forEachActive)
- `destroyAll(scene)`: Full teardown (deactivates all items, removes meshes from scene, clears arrays). Used during ecosystem restart.

**Why pools?**
- Avoid GC pressure from spawning/destroying thousands of entities per minute
- Reuse allocated mesh, geometry, physics body
- Amortize initialization cost over entity lifetime

### 9. Debug Tools

**Files**: `/src/core/DebugColliders.js`, `/src/core/DebugForceHUD.js`

Press **backtick** (`` ` ``) to toggle **debug mode**:

- Shows wireframe collider shapes (red capsules for creatures, green spheres for food, orange octahedra for seeds)
- Lines from creatures to their food targets (yellow)
- Kelp Verlet force arrows per node: cyan=current, yellow=spring, green=buoyancy, red=impulse (fixed-dt visualization, no frame-rate pulsing)
- Camera-attached **DebugForceHUD**: small compass widget in bottom-left showing global ocean current direction/strength (cyan arrow) and buoyancy (green arrow). Rotates like a compass relative to world coordinates
- Creature state printed in console every 5 seconds
- Dolphin oxygen events logged to console: LOW (30%), CRITICAL (10%), FULL (resumed hunting)
- `removeAll()` called during restart to clean up all debug visuals before pool teardown

Other keyboard shortcuts:

- **1/2/3**: Switch modes (Narrative / Viewer / Editor)
- **`+` or `=`**: Cycle time scale (1x → 3x → 5x → 10x → 1x)
- **Backspace** (Narrative mode): Manual ecosystem restart
- **0** (dev mode only): Trigger end credits sequence immediately
- **Tab**: Toggle camera mode (FPS ↔ Screensaver)
- **G** (screensaver): Cycle grid overlay (off → thirds → golden → center)
- **I** (screensaver): Toggle debug HUD (shot type, phase, velocity)
- **D** (screensaver): Toggle depth-of-field post-processing
- **V** (screensaver): Toggle vignette effect

## Common Tasks

### Add a New Creature Type

1. **Add to config.js**:
```javascript
CONFIG.creatures.newspecies = {
  speed: 0.15,
  foodTag: "food",  // what they eat: "food", "creature_fish", or "plant"
  foodToReproduce: 4,
  metabolicClock: 2,
  energyUsedPerMinute: 60,
  capsuleRadius: 0.15,
  // ... 20+ more parameters
}
```

2. **Add to poolSizes**:
```javascript
CONFIG.poolSizes.newspecies = 20
```

3. **Create mesh & pool in main.js**:
```javascript
const newspeciesPool = new ObjectPool({
  factory: () => {
    const mesh = makeCreatureMesh('newspecies')
    const creature = new Creature(mesh, 'newspecies')
    return creature
  },
  initialSize: CONFIG.poolSizes.newspecies,
  canGrow: true
})
allCreaturePools.push({ pool: newspeciesPool, type: 'newspecies' })
```

4. **Add swim animation config** in `/src/rendering/SwimMaterial.js`:
```javascript
SWIM_CONFIGS.newspecies = {
  frequency: 1.5,
  amplitude: 0.005,
  idleAmplitude: 0.014,
  thrustAmplitude: 0.0022,
  // ... more params
}
```

5. **Test**: Spawn one manually via dev tools:
```javascript
__debug.spawnCreature('newspecies', new THREE.Vector3(0, -6, 0))
```

### Tune Creature Behavior

Most behavior is controlled by CONFIG:

- **Speed**: Increase `speed` → move faster
- **Hunger**: Increase `energyUsedPerMinute` → need to eat more often
- **Reproduction rate**: Decrease `foodToReproduce` → breed faster
- **Swim animation**: Adjust `thrustAmplitude`, `idleAmplitude` in `SWIM_CONFIGS`
- **Size**: Tweak `capsuleRadius`, `capsuleHalfHeight`

After changing CONFIG, either:
- Restart the ecosystem (Backspace key)
- Or manually call `restartEcosystem()` from dev console

### Add a New Food Source

Plants produce food via `SpawnerSystem`. Each plant registers a spawner on activate:

```javascript
// In Plant.js
spawnerSystem.addSpawner(this.mesh.position, {
  rate: this.foodRateYoung,
  radius: CONFIG.spawner.radius,
  type: 'food'
})
```

To add a **second food type** (e.g., "algae"):

1. Add to config:
```javascript
CONFIG.poolSizes.algae = 50
CONFIG.foodColor_algae = 0x33ff77
```

2. Create algae pool in main.js:
```javascript
algaePool = new ObjectPool({
  factory: () => new Food(makeFoodMesh('algae')),
  initialSize: CONFIG.poolSizes.algae
})
```

3. Update spawning callback:
```javascript
onSpawnFood: (pos, force, foodType='food') => {
  const pool = foodType === 'algae' ? algaePool : foodPool
  const food = pool.get()
  if (food) food.activate(pos, force)
}
```

### Enable/Disable Debug Colliders

Toggle wireframe visualization:

```javascript
// Console
debugColliders.toggle()
debugColliders.show()   // force on
debugColliders.hide()   // force off
```

Or press backtick.

### Access Simulation State from Dev Tools

All global state is exposed on `window.__debug`:

```javascript
__debug.fishPool.getActiveCount()
__debug.fishPool.active  // array of active creatures
__debug.stageTimer       // elapsed time in narrative mode
__debug.timeScale        // current time multiplier
__debug.animDiag()       // sample creature animation state for 5s

// Documentary camera system (screensaver mode only):
__debug.cameraController.ss.director    // current phase, shot history, timing
__debug.cameraController.ss.scout       // active scout report, excitement level
__debug.cameraController.ss.cinematographer  // shot state, orbit angle
__debug.cameraController.ss.currentShot     // active shot: type, subject, duration
__debug.cameraController._dofEnabled        // DOF toggle state
__debug.cameraController._vignetteEnabled   // vignette toggle state
```

## Known Gotchas & Pitfalls

### 1. Shader Uniform Caching (Material Reuse)

**Problem**: Three.js caches compiled shader programs. If you create new uniforms after a material is first used, the shader ignores them.

**Solution**: Store uniforms on the material object and reuse them:

```javascript
// WRONG (uniforms orphaned):
const uniforms = { uPhase: { value: 0 } }
material.onBeforeCompile = (shader) => {
  shader.uniforms = { ...shader.uniforms, ...uniforms }
}
// Next activate() creates new uniforms → shader ignores them

// RIGHT (uniforms persist):
if (!material._swimUniforms) {
  material._swimUniforms = { uPhase: { value: 0 } }
  material.onBeforeCompile = (shader) => {
    shader.uniforms = { ...shader.uniforms, ...material._swimUniforms }
  }
}
// Reuse material._swimUniforms on next activate()
```

### 2. Material Cloning (GLB Models)

**Problem**: `getModelClone()` returns a shallow scene graph. Materials are **shared** across clones (not cloned).

**Gotcha**: If you modify one clone's material, ALL clones see the change.

**Solution**: Manually clone materials when you need unique variants:

```javascript
creature.mesh.traverse(child => {
  if (child.isMesh) {
    child.material = child.material.clone()
  }
})
```

### 3. Object Pool Lifecycle

**Problem**: Calling `deactivate()` doesn't automatically clear the object's state. Old data persists.

**Solution**: Always reset state in `activate()`:

```javascript
activate() {
  this.foodTarget = null     // clear old target
  this.metabolism = baseEnergy  // reset energy
  this.lifeTimer = 0         // reset age
  // ...
}
```

### 4. Jolt Physics Body Reuse

**Problem**: Jolt body IDs are WASM pointers. Reusing the same ID across different objects causes undefined behavior.

**Solution**: Always create a new body in `activate()` and destroy it in `deactivate()`:

```javascript
activate() {
  this.joltBodyID = joltWorld.createBody(...)
}

deactivate() {
  if (this.joltBodyID !== null) {
    joltWorld.removeBody(this.joltBodyID)
    this.joltBodyID = null
  }
}
```

### 5. Collision Layer Configuration

**Problem**: Creatures don't collide with plants (expected). But if you add a new entity type, collision filtering is easy to misconfigure.

**Solution**: Check `JoltWorld.js`:
- `LAYER_STATIC` (0): Terrain, plants (static objects)
- `LAYER_MOVING` (1): Creatures, seeds, food (dynamic objects)
- Filter: `STATIC ↔ MOVING` and `MOVING ↔ MOVING` enabled; `STATIC ↔ STATIC` disabled

New entity type → which layer? If it moves and should collide with creatures, use `LAYER_MOVING`.

### 6. Verlet Chain Creature Collision

**Problem**: Plants don't use Jolt. Creature-plant collisions are manually computed in `main.js` game loop.

**Gotcha**: Only checks XZ distance (horizontal), not full 3D distance. This is intentional (stalk is vertical), but can miss collisions with creatures at stalk height.

**Interaction radius**: `cfg.capsuleRadius * cfg.scale * 0.5` — uses half the physics capsule radius so kelp interaction matches the visual body, not the oversized physics shell. Config values are model-space; must multiply by `cfg.scale` for world-space.

**Drag-along collision**: Nodes are nudged in the creature's velocity direction (wrap/drape effect) with direct position displacement for localized bending. A small impulse component spreads gently to neighbors for trailing wake. Squared falloff (`closeness²`) keeps most force on the closest nodes.

**Tuning**: Adjust `plant.collisionRadius` (broad-phase, default 0.5) and creature capsule values in config.

### 7. Spawn Scale-in Timing

**Problem**: Creatures scale from 0.01x to 1.0x over 4 seconds. During this time, the Jolt body doesn't exist yet.

**Why**: Scaled collider would be tiny and cause physics glitches.

**Solution**: Jolt body is created AFTER scale-in completes (line 286 in Creature.js). Until then, collision is disabled (acceptable for spawning in open water).

### 8. Time Scale Doesn't Affect Jolt Directly

**Problem**: `timeScale` variable multiplies `dt` for creature logic, but Jolt physics uses raw `dt`.

**Result**: Physics ticks at real-time, creature AI runs at 10x speed → creature moves 10x faster but collisions feel weird.

**Solution**: If you change time scale, also scale Jolt's gravity & damping proportionally, or scale `dt` passed to `joltWorld.step()`:

```javascript
const clampedDt = Math.max(1/240, Math.min(1/20, dt * timeScale))
joltWorld.step(clampedDt)
```

## Testing

### Unit Tests

```bash
npm run test        # run once
npm run test:watch  # re-run on changes
```

Tests are in `/tests/`. Example:

```javascript
import { ObjectPool } from '../src/core/ObjectPool.js'

describe('ObjectPool', () => {
  it('should get and release items', () => {
    const pool = new ObjectPool({ initialSize: 5 })
    const item = pool.get()
    expect(item.active).toBe(true)

    pool.release(item)
    expect(item.active).toBe(false)
  })
})
```

### E2E Tests

```bash
npm run test        # Vitest runs e2e tests too (with Playwright)
```

E2E tests in `/e2e/` simulate user interactions and verify the app loads & runs.

## Performance Tips

1. **Reduce pool sizes** in CONFIG if you're running on low-end hardware
2. **Lower particle count** in MarineSnow config
3. **Disable debug colliders** (press backtick) when not debugging
4. **Use Model Viewer mode** to inspect creatures without ecosystem running
5. **Profile with DevTools**: Performance tab → record → look for long frames

## Contributing Guidelines

When making changes:

1. **Test locally**: `npm run dev`, verify no console errors
2. **Keep config.js as source of truth**: Don't hardcode creature parameters
3. **Use object pools**: Don't create/destroy entities every frame
4. **Reuse temp objects**: Pre-allocate vectors/quaternions at module scope (see Creature.js lines 15–29)
5. **Document gotchas**: If you find a surprising behavior, add a comment
6. **Run tests**: `npm run test` before submitting

## Testing Strategy

### Unit Tests (Vitest)

Tests live in `/tests/`. Run with `npm run test` (once) or `npm run test:watch` (re-run on changes).

**What's tested**:
- Config validation (creature parameters, pool sizes, boundary values)
- Object pool lifecycle (get, release, forEachActive, destroyAll)
- Creature AI edge cases (metabolism drain, reproduction thresholds, oxygen depletion)
- Population monitor restart logic
- Narration system trigger timing
- Procedural animation state machine transitions
- Thrust smoothing and engine burn cycle behavior

**Writing new tests**:
- Import directly from `src/` - Vitest resolves ES modules natively
- Mock Jolt physics when testing AI logic (creature tests stub out `joltWorld`)
- Use CONFIG values rather than hardcoded numbers so tests stay resilient to tuning changes
- Example: `CONFIG.restartDelay * 0.5` instead of `15` for timing assertions

```javascript
import { describe, it, expect } from 'vitest'
import { CONFIG } from '../src/config.js'

describe('MySystem', () => {
  it('should respect configured timing', () => {
    const system = new MySystem()
    system.update(CONFIG.someDelay * 0.5)
    expect(system.triggered).toBe(false)
    system.update(CONFIG.someDelay * 0.6)
    expect(system.triggered).toBe(true)
  })
})
```

### E2E Tests (Playwright)

E2E tests in `/e2e/` verify the app loads, renders, and responds to input in a real browser. Playwright is configured via `playwright.config.js`.

### Debug URL Parameters

Toggle features via query string for testing and performance profiling:

```
?useCaustics=0     Disable underwater caustics
?useGodrays=0      Disable volumetric god rays
?useDOF=0          Disable depth of field
?useSnow=0         Disable marine snow particles
?useInstancing=0   Disable GPU instancing
?debug             Enable debug logging across all modules
```

These are parsed in `main.js` and passed to subsystems. The `?debug` flag is the primary mechanism for enabling verbose console output - all debug logs across the codebase are gated behind this flag (either via a module-level `_DEBUG` constant or a per-instance `_debugLog` property).

## XR Development

### Overview

WebXR support is handled by `/src/input/XRManager.js` with several companion rendering modules. The system targets Meta Quest 3 as the primary headset but follows standard WebXR APIs.

### Architecture

- **XRManager** - Session lifecycle, controller tracking, thumbstick locomotion, food throwing
- **XRHandGestures** - Hand tracking input (pinch-to-grab, throw gestures)
- **VRComfortVignette** - Tunneling vignette during locomotion to reduce motion sickness
- **VRHud** - Head-locked HUD elements for VR
- **VRDebugPanel** - In-VR debug overlay (build version, frame timing)
- **VRControllerHints** - Visual controller mapping hints

### Key Concepts

**Camera Rig**: The XR camera is a child of a `THREE.Group` rig. Locomotion moves the rig, not the camera directly. This is the standard Three.js WebXR pattern.

**Controller Input**: Controllers are indexed by Three.js controller index (0, 1), not by handedness. Each controller tracks trigger, grip, face button, and pinch states independently. "Held" is the OR of all input channels.

**Food Throwing**: In VR, food throwing uses the controller's linear velocity (from `XRFrame` pose data) for natural throw physics. The throw force is the controller velocity plus an upward float component.

**SharedArrayBuffer Requirement**: Jolt Physics runs on a Web Worker using SharedArrayBuffer. This requires specific HTTP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`). The deployed site sends only `Cross-Origin-Opener-Policy: same-origin-allow-popups` (`assets/_headers`), with no COEP, so in production Jolt falls back to the main thread. Local dev via Vite also sets them. All cross-thread control flags (step requested, step complete) must use `Atomics.store`/`Atomics.load` — never plain array writes — to guarantee correct ordering on ARM (Quest). See `PhysicsBuffers.js` for the buffer layout and `PhysicsProxy.js` / `physics.worker.js` for the synchronization protocol.

### Testing XR

- Use a Quest headset connected to the dev server over local network
- Or use Chrome's WebXR emulator extension for basic testing
- The VR button only appears when `navigator.xr.isSessionSupported('immersive-vr')` resolves true

## Debugging Tips

### Console Debugging

All debug logs are gated behind the `?debug` URL parameter. Add it to your dev URL:
```
http://localhost:3000/?debug
```

This enables verbose logging across:
- Camera system (profile transitions, shot changes, DOF state)
- HUD system (periodic population counts)
- Creature oxygen events (low, critical, refilled)
- Mode transitions

### Visual Debugging

Press **backtick** to toggle debug colliders:
- Red capsules: creature physics bodies
- Green spheres: food colliders
- Orange octahedra: seed colliders
- Yellow lines: creature-to-target tracking
- Cyan/yellow/green/red arrows on kelp: Verlet force visualization per node

### Dev Console Globals

Everything is exposed on `window.__debug`:

```javascript
// Population
__debug.fishPool.getActiveCount()
__debug.dolphinPool.getActiveCount()

// Time control
__debug.timeScale  // read/write: 1, 3, 5, or 10

// Creature diagnostics
__debug.animDiag()  // samples creature animation state for 5 seconds

// Camera system (screensaver mode)
__debug.cameraController.ss.director     // phase, shot history
__debug.cameraController.ss.scout        // event detection state
__debug.cameraController.ss.currentShot  // active shot details
```

### Common Issues

**Entities teleport to (0,0,0)**: Check for `joltBodyID === -1`. Physics body creation failed (out of slots). All entity code must treat `createBody()` returning `< 0` as `null`.

**Shader uniforms ignored after recompile**: Three.js caches shader programs. Store uniforms on the material object and reuse them across activate cycles. See the "Shader Uniform Caching" gotcha above.

**Creature AI doesn't respond to config changes**: Most CONFIG values are read at `activate()` time, not continuously. Restart the ecosystem (Backspace key) after changing config.

## Useful References

- **Jolt Physics Docs**: https://jrouwe.nl/Jolt/Jolt-Documentation-v4.1.pdf
- **Three.js Docs**: https://threejs.org/docs/

## Asking for Help

If something is confusing:

1. Check `/src/main.js` game loop (comprehensive comments)
2. Check the entity class (Creature.js, Plant.js, etc.) for your entity type
3. Check config.js for all tunable parameters
4. Add `?debug` to your URL for verbose logging
5. Use `__debug.animDiag()` to sample creature state over time

