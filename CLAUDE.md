# PolyFish Remastered

Underwater ecosystem simulation built with Three.js and WebXR. Supports desktop, mobile, and VR (Quest).

## Versioning

This project uses **semantic versioning** (semver): `MAJOR.MINOR.PATCH`

- **MAJOR** — breaking changes, full rewrites, or milestone releases (e.g. 1.0 → 2.0)
- **MINOR** — new features, new modes, significant UX changes (e.g. 1.0 → 1.1)
- **PATCH** — bug fixes, tuning, small polish (e.g. 1.0.0 → 1.0.1)

### When to bump

| Change type | Bump | Example |
|---|---|---|
| New creature type, new game mode | MINOR | 1.0.0 → 1.1.0 |
| New credits entry, new sound effect | PATCH | 1.0.0 → 1.0.1 |
| VR interaction fix, mobile bug fix | PATCH | 1.0.0 → 1.0.1 |
| Physics engine rewrite, renderer swap | MAJOR | 1.0.0 → 2.0.0 |
| Config tuning (speeds, scales, colors) | PATCH | 1.0.0 → 1.0.1 |

### Where to update

Version lives in two places — keep them in sync:

1. **`package.json`** → `"version"` field
2. **`src/rendering/VRDebugPanel.js`** → `VR_BUILD_VERSION` constant (displayed in VR debug overlay and title screen footer)

Format: package.json uses `"1.0.0"`, VR_BUILD_VERSION uses `"v1.0.0"` (prefixed with v).

## Architecture overview

- **Rendering**: Three.js with instanced meshes for food/seeds/creatures (1 draw call per type). Plants use a DataTexture for per-instance bone matrices.
- **Physics**: Jolt WASM via SharedArrayBuffer worker (`PhysicsProxy`). Falls back to synchronous main-thread Jolt if SAB is unavailable. Simple `PhysicsBody` Euler integration for distant food (LOD).
- **XR**: WebXR with smooth locomotion (left stick), smooth turn (right stick), trigger-based feeding. Both controllers independent.
- **Food in VR**: Lerp-based hold (not scene-graph parented) for weighted feel, rendered via the shared food `InstancedMesh`.
- **End credits**: DOM-based for all platforms; VR exits session first, then plays DOM credits on flat screen.
- **State**: Centralized in `GameState.js` (GS). All systems read/write mutable state through GS — no scattered singletons.
- **Modes**: NarrativeMode (default), ModelViewerMode, EditorMode. Switching deactivates ALL entities (clean slate).
- **Capture mode** (`?capture=1`, `src/capture/CaptureMode.js`): freezes the world and exposes
  `window.__capture` so the sibling splat tool can drive an emulated headset and read frames back.
  Inert otherwise. If you change what animates, or the renderer's size or alpha, read that file
  first — a capture depends on the frozen scene being genuinely still and on the canvas being
  readable, and both fail silently.

## Dev server

```
npm run dev
```

Requires HTTPS for WebXR testing (`@vitejs/plugin-basic-ssl` handles this).

## Critical values

- **`CONFIG.surfaceY = 8.0`** — single source of truth for the water line. Used by dolphin breathing, kelp clamping, boundary system, ocean surface mesh, creature hard-clamp. Changing it breaks all vertical boundaries.
- **`VR_FOOD_GRIP_OFFSET = (0, 0.02, -0.18)`** — local offset for food relative to controller grip.
- **Pool sizes** in `CONFIG.poolSizes` — pre-allocated counts. Pools can grow but initial sizes prevent GC pauses.

## Entity lifecycle

All entities (Creature, Food, Plant, Seed) follow the same pattern:

1. **Create**: factory in ObjectPool. Mesh at (0, -9999, 0), `active = false`.
2. **Activate**: `entity.activate(position, ...)` — set active, position mesh BEFORE setting visible (prevents 1-frame flash), init physics body.
3. **Update**: called each frame by `SimulationSystem`. Entities can self-deactivate by setting `active = false`; `ObjectPool.forEachActive()` lazily cleans up.
4. **Deactivate**: hide mesh, move to -9999, destroy Jolt body, clear debug visuals.

Items can self-deactivate without calling `pool.release()`. The pool handles it.

## Instanced rendering

Individual entity meshes are NOT added to the scene. All rendering goes through shared `InstancedMesh` objects (1 draw call per entity type). Instance matrices are composed each frame in `SimulationSystem` from mesh position/rotation/scale.

**Consequence**: if you parent a mesh to something else (like a controller grip), it won't render — it must go through the instanced mesh path. VR held food was previously invisible because of this (fixed by keeping food in scene + lerp, not parenting to grip).

Plant instancing uses a `DataTexture` for per-instance bone matrices (standard `InstancedMesh` can't do per-instance skinning). Don't set `internalFormat = 'RGBA32F'` explicitly — let Three.js auto-select for iOS compatibility.

## Simulation loop ordering (SimulationSystem.js)

Order matters — don't rearrange:

1. Player kinematic capsule sync (camera → Jolt)
2. Food physics LOD classification + `preStep()` (push to Jolt)
3. **Physics step** (Jolt worker runs)
4. LOD assignment (every 0.25s, distance-based)
5. Build creature lists (alive vs dead/corpse)
6. Spatial hash rebuild + batch flee pass (every 0.033s)
7. **Staggered AI ticks** (3 groups per species, ~10 Hz each)
8. Per-frame motion updates (every frame, all creatures)
9. Creature instanced mesh sync
10. Food update + hash rebuild + instanced sync
11. Seed update + instanced sync
12. Plant update + Verlet collisions + instanced sync
13. Spawner system
14. Narration timeline
15. Population monitor (triggers end sequence when fish = 0)

## Staggered AI

Creatures don't all run AI every frame. Each species is divided into 3 stagger groups; one group runs per sub-tick. Effect: all creatures get AI at ~10 Hz, but only 1/3 run per frame. Motion updates (rotation, forces, mesh sync) run every frame for smoothness.

## Physics architecture

**Dual authority**: Creatures set velocity on main thread via SAB commands. Jolt reads velocity, steps, resolves collisions, writes position back to SAB. Main thread reads position next frame. 1-frame lag is inherent.

**Physics LOD for food**: Food >20m from camera skips Jolt commands entirely, uses simple `PhysicsBody` integration. Fish eating is spatial-hash-based and unaffected.

**PhysicsProxy slot system**: Each body gets a slot (not a Jolt BodyID). Entities store the slot. Body creation is async in worker mode but the slot is returned immediately — commands queue until the body is ready.

## Creature AI

**Two-phase update**: `updateAI()` (10 Hz, heavy: spatial queries, food finding, eating) and `updateMotion()` (every frame, cheap: rotation slerp, forces, mesh sync).

**Fleeing is external**: Creatures don't decide to flee on their own. `SimulationSystem`'s batch flee pass marks fish as fleeing from nearby dolphins. Creatures just read the `isFleeing` flag.

**Food target can go stale**: The target may die or deactivate between AI ticks. `updateMotion()` drops stale targets each frame.

**Oxygen** (dolphins only): 0–1 gauge. Depletes at ~0.017/s underwater (~60s). `_needsAir` triggers surface navigation at 0.3. Refills at 0.25/s at surface (~2–4s).

**Jolt capsule deferred**: Not created until spawn animation finishes (4s). Prevents collisions during scale-in.

## Spatial hash

XZ only (ignores Y). Rebuilt every hash tick (0.033s for creatures, every AI tick for food). O(1) insert, O(nearby) query. Results arrays are pre-allocated — caller passes in the array. Must `clear()` before rebuilding.

## Shader stacking

Caustics are patched into ALL materials via `applyCaustics(material, boost)`. Swim animation is a separate vertex shader patch. When both apply, caustics run first, then swim shader on top. The `onBeforeCompile` chain must be preserved — don't overwrite, chain the previous callback.

## Platform differences

| Feature | Desktop | VR | Mobile |
|---|---|---|---|
| Caustics | ON | ON | OFF |
| God rays | ON (screen-space) | OFF (stereo doubles cost) | OFF |
| DOF | ON (screensaver) | OFF | OFF |
| Instancing | ON | OFF* | OFF* |
| Swim shader | ON | ON | OFF |
| Food interaction | Mouse click+drag | Trigger hold/throw (lerp) | Tap or feed button |
| Camera | FPS + screensaver | XR headset + smooth turn | FPS + gyro + virtual joystick |

*Overridable via URL params (`?useInstancing=1`, etc.)

## VR-specific notes

- **God rays disabled in VR**: Screen-space post-processing runs per-eye in stereo, doubling cost. VRGodRays.js exists as a world-space alternative but is not currently used.
- **Controller grip `matrixWorld` is stale** during the animation callback. Three.js updates local pose from XR data but doesn't recompute `matrixWorld` until `renderer.render()`. Call `grip.updateWorldMatrix(true, false)` or use `localToWorld()` (which calls it internally) before reading world positions.
- **Throw velocity is in XR reference space**, not world space. Smooth turn rotates the Three.js rig, not the reference space, so `velocity.applyQuaternion(this.rig.quaternion)` is required for correct throw direction.
- **VR HUD** is a canvas-textured billboard on the left controller. Material uses `depthTest: false` so terrain can't occlude it.
- **End credits in VR**: Scene fades to black via tint sphere (`depthTest: false`, BackSide), then `session.end()`, then DOM credits on flat screen.
- **Comfort vignette**: Clip-space ring darkens during rapid rotation.
- **dom-overlay**: Requested as optional WebXR feature but NOT reliably granted on Quest. Don't depend on it.

## Adding a new creature type

1. Add config block in `config.js` under `creatures` (copy fish/dolphin/manatee pattern)
2. Add entry in `CONFIG.foodChain` (eatCategory, preyTypes, eatenBy)
3. Create pool + instanced mesh in `main.js` init (follow existing pattern)
4. Add to `GS.allCreaturePools` array
5. Add stagger AI state in `GameState._aiState`
6. Add to SimulationSystem's species AI tick loop + instanced sync
7. Add staged spawn time in NarrativeMode if desired

## Key gotchas

- **Mesh position before visibility**: Always set position BEFORE `mesh.visible = true` to prevent 1-frame flash at origin from pool reuse.
- **Instanced mesh count must match active count**: If you sync 25 fish but set `count = 26`, rendering breaks.
- **Volatile temp vectors**: Module-level reusable vectors (`_tempPos`, `_vrFoodTarget`, etc.) are only valid within a single synchronous call. Never store references to them.
- **Food `held` early return**: `Food.update()` returns early when `this.held === true` — skips position sync and rotation. While held, position is driven externally by main.js (VR lerp or desktop FeedingInput).
- **Creature growth is visual + physics**: `reproFoodCounter` drives both visual scale and Jolt capsule radius. Growth scale = `(reproFoodCounter / foodToReproduce) + 1`.
- **Plant Verlet nodes are world-space**: Creatures lock onto node indices, not fixed XZ positions. Nodes move with sway.
- **`onBeforeCompile` chaining**: When patching materials (caustics + swim), always call the previous `onBeforeCompile` first, then inject your chunk.
- **Mode switching clears everything**: `SceneModeManager._deactivateAll()` deactivates every entity in every pool. No state persists between modes.
