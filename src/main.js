/**
 * PolyFish — Three.js Port
 * Main entry point: initializes all systems, creates entity pools, runs the game loop.
 * Supports 3 scene modes: Narrative, Model Viewer, Editor.
 */
import * as THREE from "three";
import { CONFIG } from "./config.js";
// MathUtils: randomRange/randomInsideSphere used by SimulationSystem, not needed here
import { ObjectPool } from "./core/ObjectPool.js";
import {
	preloadModels,
	getModelClone,
	hasModel,
	getSourceModel,
} from "./core/ModelLoader.js";
import { proceduralRerig } from "./core/ProceduralRig.js";
import sceneManager from "./rendering/SceneManager.js";
import {
	createColorMaterial,
	createIBLMaterial,
} from "./rendering/IBLMaterial.js";
import marineSnow from "./rendering/MarineSnow.js";
import fadeOverlay from "./rendering/FadeOverlay.js";
import waterSurface from "./rendering/WaterSurface.js";
import VFXManager from "./rendering/VFXManager.js";
import { Creature } from "./entities/Creature.js";
import { Food, createPlanktonGeometry } from "./entities/Food.js";
import { Seed } from "./entities/Seed.js";
import { Plant } from "./entities/Plant.js";
import { SpawnerSystem } from "./systems/SpawnerSystem.js";
import { PopulationMonitor } from "./systems/PopulationMonitor.js";
import { NarrationSystem } from "./systems/NarrationSystem.js";
import { HUDSystem } from "./systems/HUDSystem.js";
import { CameraController } from "./input/CameraController.js";
import { FeedingInput } from "./input/FeedingInput.js";
import { XRManager } from "./input/XRManager.js";
import { VR_BUILD_VERSION } from "./rendering/VRDebugPanel.js";
import { CinematicDOF } from "./camera/CinematicDOF.js";
import { applyCaustics, updateCausticTime } from "./rendering/CausticShader.js";
import { GodRayRenderer } from "./rendering/GodRayRenderer.js";
import { AdaptiveResolution } from "./rendering/AdaptiveResolution.js";
import { VRGodRays } from "./rendering/VRGodRays.js";
import { VREndScreen } from "./rendering/VREndScreen.js";
import { createCreatureInstanced } from "./rendering/InstancedCreatures.js";
import { createPlantInstanced } from "./rendering/InstancedPlants.js";
import { AudioManager } from "./audio/AudioManager.js";
import joltWorld from "./core/JoltWorld.js";
import { PhysicsProxy } from "./core/PhysicsProxy.js";
import debugColliders from "./core/DebugColliders.js";
import { DebugForceHUD } from "./core/DebugForceHUD.js";
import {
	getTerrainHeight,
	TERRAIN_SIZE,
	TERRAIN_CENTER_X,
	TERRAIN_CENTER_Z,
} from "./utils/Terrain.js";

// Mode system
import { SceneModeManager } from "./modes/SceneModeManager.js";
import { NarrativeMode } from "./modes/NarrativeMode.js";
import { ModelViewerMode } from "./modes/ModelViewerMode.js";
import { EditorMode } from "./modes/EditorMode.js";
import { DesktopHints } from "./input/DesktopHints.js";
import { TitleScreen } from "./systems/TitleScreen.js";
import { CAPTURE, captureMode } from "./capture/CaptureMode.js";
import { buildDevPanel } from "./systems/DevPanel.js";
import { PerfMonitor } from "./systems/PerfMonitor.js";
import { PopulationGraph } from "./systems/PopulationGraph.js";
import GS from "./core/GameState.js";
import {
	initSimulation,
	simulationStep as runSimulationStep,
} from "./systems/SimulationSystem.js";
import {
	createPlaceholderTerrain,
	createWaterSurface,
} from "./rendering/SceneSetup.js";

// ── Platform detection ────────────────────────────────────────
const isMobile = "ontouchstart" in window || navigator.maxTouchPoints > 0;
const isIOS =
	/iPad|iPhone|iPod/.test(navigator.userAgent) ||
	(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS
// VR headsets (Quest 3) register as mobile via ontouchstart but have
// desktop-class GPUs — give them a VR-specific quality tier.
const isVRCapable = "xr" in navigator;
const isVRDevice = isMobile && isVRCapable; // Quest 3, etc.
const useMobileDefaults = isMobile && !isVRCapable;

// ── Feature flags (toggle via URL params) ────────────────────
// Three tiers: desktop (all ON), VR headset (selective), phone (all OFF).
// Override any flag: ?useCaustics (enable) or ?useCaustics=0 (disable).
const _params = new URLSearchParams(window.location.search);
// Effects a splat capture cannot have on, whatever the platform defaults say. Two of them blur the
// image (depth of field, god rays), one puts particles between the camera and the subject (marine
// snow), one animates the lighting (caustics), and one changes the framebuffer size mid-run
// (adaptive resolution), which would silently change the intrinsics partway through a capture.
// An explicit URL parameter still wins, so a capture can turn one back on deliberately.
const CAPTURE_FORCES_OFF = new Set([
	"useCaustics",
	"useGodrays",
	"useDOF",
	"useSnow",
	"useFullSnow",
	"adaptiveRes",
]);
function flag(
	name,
	desktopDefault = true,
	mobileDefault = false,
	vrDefault = undefined,
) {
	if (_params.has(name)) return _params.get(name) !== "0";
	if (CAPTURE && CAPTURE_FORCES_OFF.has(name)) return false;
	if (isVRDevice && vrDefault !== undefined) return vrDefault;
	return useMobileDefaults ? mobileDefault : desktopDefault;
}
// Visual features — ON everywhere (lightweight shaders)
const USE_CAUSTICS = flag("useCaustics", true, true);
const USE_SWIM = flag("useSwim", true, true);
const USE_WATER_ANIM = flag("useWaterAnim", true, true);
const USE_SNOW = flag("useSnow", true, true);
// Scaled-down on mobile, full on desktop/VR
const USE_FULL_SNOW = flag("useFullSnow"); // desktop + VR ON, phone OFF
const USE_FULL_POOLS = flag("useFullPools", true, false, false); // VR: smaller pools (stereo doubles draw calls)
// Heavy GPU features
const USE_HIRES_TERRAIN = flag("useHiResTerrain"); // VR: full resolution terrain (fine)
const USE_HI_DPR = flag("useHiDPR", true, false, false); // VR: WebXR controls framebuffer size
const USE_INSTANCING = flag("useInstancing"); // VR: critical for draw-call reduction
const USE_DOF = flag("useDOF", true, false, false); // VR: stereo post-processing too heavy
const USE_GODRAYS = flag("useGodrays", true, false, false); // VR: fullscreen post too heavy in stereo
const USE_ADAPTIVE_RES = flag("adaptiveRes", true, false, false); // Dynamic DPR scaling based on frame time
if (isMobile || isVRDevice || _params.toString()) {
	console.log("[PolyFish] Feature flags:", {
		isMobile,
		isVRDevice,
		isIOS,
		USE_CAUSTICS,
		USE_SNOW,
		USE_FULL_SNOW,
		USE_FULL_POOLS,
		USE_HIRES_TERRAIN,
		USE_HI_DPR,
		USE_INSTANCING,
		USE_DOF,
		USE_GODRAYS,
		USE_SWIM,
		USE_WATER_ANIM,
	});
}

// ── Mobile viewport zoom guard ───────────────────────────────
// iOS Safari can accidentally zoom the visual viewport despite
// user-scalable=no (orientation changes, focus events, accessibility,
// or restoring a tab that was previously zoomed). When this happens,
// position:fixed elements appear at a fraction of their intended size
// because they anchor to the layout viewport while content is zoomed.
// Instead of rewriting the meta tag (which can kill the WebGL context),
// we compensate by applying inverse CSS zoom.
// Selector covers every fixed UI overlay that players need to read/tap.
const _zoomFixSelector = "#feed-btn, #gyro-toggle, #cinema-toggle, #hud";
if (window.visualViewport) {
	const vv = window.visualViewport;
	const compensateZoom = () => {
		const zoomed = Math.abs(vv.scale - 1) > 0.01;
		document.querySelectorAll(_zoomFixSelector).forEach((el) => {
			el.style.zoom = zoomed ? 1 / vv.scale : "";
		});
	};
	// Listen for resize AND scroll - iOS fires scroll when the viewport
	// pans due to zoom, and resize when the scale factor changes.
	vv.addEventListener("resize", compensateZoom);
	vv.addEventListener("scroll", compensateZoom);
	// Run immediately in case the viewport is already zoomed on load
	// (e.g. Safari restoring a previously-zoomed tab, or HTTPS triggering
	// a different initial scale than HTTP).
	compensateZoom();
}

// ── State ──────────────────────────────────────────────────────
let clock, cameraController, feedingInput, xrManager, desktopHints;
let audioManager, narrationSystem, spawnerSystem, populationMonitor;
let modeManager;
let physicsProxy;
let cinematicDOF;
let godRayRenderer;
let adaptiveResolution;
let vrGodRays;
let vrEndScreen;
let vfxManager;
let playerBodySlot = -1; // Kinematic capsule for the player/camera

// Entity pools
let fishPool, dolphinPool, manateePool, foodPool, seedPool, plantPool;

// HUD system
let hudSystem;

// Food-throwing state
let heldFood = null; // desktop/mobile: single held food
let _vrHeldFood = [null, null]; // VR: per-controller held food
let _vrFoodSpawned = [false, false]; // VR: per-controller spawn debounce
let _vrFoodParentedTo = [null, null]; // VR: which grip each food is parented to
const _vrFoodWorldPos = new THREE.Vector3(); // reusable temp for world pos readback
const _vrFoodTarget = new THREE.Vector3(); // reusable temp for lerp target
const _vrFoodTargetQuat = new THREE.Quaternion(); // reusable temp for grip quaternion
const _vrFoodSpawnPos = new THREE.Vector3(0, -99999, 0); // offscreen position for new held food

// Local offset for food relative to grip (slightly forward and above grip origin)
const VR_FOOD_GRIP_OFFSET = new THREE.Vector3(0, 0.02, -0.18);

// Dev mode — enabled via ?dev=true URL parameter.
// Shows perf HUD, mode selector links, timescale controls, and debug toggle.
const devMode =
	new URLSearchParams(window.location.search).get("dev") === "true";

// Debug mode (toggle with backtick key, only in dev mode)
let debugMode = false;
let debugForceHUD = null;

// Title screen state
const titleScreen = new TitleScreen();

// endSequenceActive lives in GS (read/written by SimulationSystem + main.js)

// Time scale (cycle with + key: 1x → 3x → 5x → 10x → 1x) — dev mode only
let timeScale = 1;
const TIME_SCALES = [1, 3, 5, 10];

// Aggregate lists for fast iteration
const allCreaturePools = [];

// ── Instanced Mesh rendering (Food + Seed + Creatures) ──────────
// One InstancedMesh per type replaces N individual meshes → 1 draw call each.
let foodInstancedMesh = null;
let seedInstancedMesh = null;
// Creature instanced meshes: 85+ draw calls → 3 draw calls
let fishInstanced = null; // { mesh, phaseAttr, ampAttr, offsetQuat }
let dolphinInstanced = null;
let manateeInstanced = null;
// Instance scratch objects live in GS (used by SimulationSystem)
const MAX_FOOD_INSTANCES = USE_FULL_POOLS ? 2000 : 60;
const MAX_SEED_INSTANCES = USE_FULL_POOLS ? 2000 : 20;
const MAX_FISH_INSTANCES = USE_FULL_POOLS ? 2000 : 30;
const MAX_DOLPHIN_INSTANCES = USE_FULL_POOLS ? 2000 : 8;
const MAX_MANATEE_INSTANCES = USE_FULL_POOLS ? 2000 : 6;
// Plant instanced mesh: 200+ draw calls → 1 draw call
let plantInstanced = null;
const MAX_PLANT_INSTANCES = USE_FULL_POOLS ? 2000 : 30;

// Staged-spawn state lives in GS (read/written by SimulationSystem + stageManager proxies)

// ── Mode Context ──────────────────────────────────────────────
/** Shared context object passed to all modes. Built after init. */
let modeContext = null;

function buildModeContext() {
	return {
		scene: sceneManager.getScene(),
		camera: sceneManager.getCamera(),
		renderer: sceneManager.getRenderer(),
		cameraController,
		narrationSystem,
		spawnerSystem,
		populationMonitor,
		fadeOverlay,
		audioManager,
		allCreaturePools,
		fishPool,
		dolphinPool,
		manateePool,
		foodPool,
		seedPool,
		plantPool,
		// Spawn helpers
		spawnCreature,
		spawnFood,
		spawnSeed,
		spawnPlant,
		restartEcosystem,
		spawnInitialSeed,
		// Staged spawn state (read/write through GS so SimulationSystem sees changes)
		get stageTimer() {
			return GS.stageTimer;
		},
		set stageTimer(v) {
			GS.stageTimer = v;
		},
		get stageRunning() {
			return GS.stageRunning;
		},
		set stageRunning(v) {
			GS.stageRunning = v;
		},
		stageEvents: GS.stageEvents,
	};
}
/**
 * Build context object for title screen initialization
 * Contains all dependencies the TitleScreen system needs
 */
function updateModeUIVisibility() {
	const modeEl = document.getElementById("mode-selector");
	if (modeEl) {
		modeEl.style.display = debugMode ? "flex" : "none";
	}
}

function buildTitleContext() {
	return {
		getModelClone,
		applyCaustics,
		sceneManager,
		audioManager,
		narrationSystem,
		cameraController,
		desktopHints: DesktopHints,
		xrManager,
		isMobile,
		spawnerSystem: SpawnerSystem,
		populationMonitor,
		stageManager: {
			get stageTimer() {
				return GS.stageTimer;
			},
			set stageTimer(v) {
				GS.stageTimer = v;
			},
			get stageRunning() {
				return GS.stageRunning;
			},
			set stageRunning(v) {
				GS.stageRunning = v;
			},
			stageEvents: GS.stageEvents,
			desktopHints: null,
		},
		modeManager,
		feedingInput,
		seedPool,
		buildModeContext,
		updateModeUIVisibility,
	};
}

// ── Mobile Diagnostic Overlay ─────────────────────────────────
// Visible on-screen log for debugging on devices without devtools.
// Enabled via ?diag=true URL param.
const _diagMode =
	new URLSearchParams(window.location.search).get("diag") === "true";
let _diagEl = null;

function diagLog(msg) {
	console.log(`[diag] ${msg}`);
	if (!_diagMode) return;
	if (!_diagEl) {
		_diagEl = document.createElement("pre");
		_diagEl.style.cssText =
			"position:fixed;top:0;left:0;right:0;z-index:99999;background:rgba(0,0,0,0.85);" +
			"color:#0f0;font:11px/1.4 monospace;padding:8px;max-height:50vh;overflow-y:auto;" +
			"pointer-events:none;white-space:pre-wrap;word-break:break-all;";
		document.body.appendChild(_diagEl);
	}
	_diagEl.textContent += msg + "\n";
	_diagEl.scrollTop = _diagEl.scrollHeight;
}
// Expose globally so other modules (e.g. SceneManager) can log to diag overlay
window.diagLog = diagLog;

// Catch unhandled errors and show them in the overlay
if (_diagMode) {
	window.addEventListener("error", (e) =>
		diagLog(`ERROR: ${e.message} @ ${e.filename}:${e.lineno}`),
	);
	window.addEventListener("unhandledrejection", (e) =>
		diagLog(`REJECT: ${e.reason}`),
	);
}

// ── Bootstrap ──────────────────────────────────────────────────
const MINIMAL = _params.has("minimal"); // bare scene: terrain + water + lights only

// ── Loading screen progress ─────────────────────────────────
const _loadingStatusEl = document.getElementById("loading-status");
const _loadingBarEl = document.getElementById("loading-bar");
function loadingProgress(message, percent) {
	if (_loadingStatusEl) _loadingStatusEl.textContent = message;
	if (_loadingBarEl) _loadingBarEl.style.width = `${percent}%`;
}
function dismissLoadingScreen() {
	const el = document.getElementById("loading-screen");
	if (el) {
		el.classList.add("fade-out");
		el.addEventListener("transitionend", () => el.remove(), { once: true });
	}
}

async function init() {
	diagLog(`UA: ${navigator.userAgent.slice(0, 80)}`);
	diagLog(`screen: ${screen.width}x${screen.height} dpr:${devicePixelRatio}`);
	diagLog(
		`SAB: ${typeof SharedArrayBuffer !== "undefined"} iOS:${isIOS} mobile:${isMobile} noSim:${_params.has("noSim")} minimal:${MINIMAL}`,
	);

	// 0. Dev mode — initialize perf monitor and population graph
	if (devMode) {
		perfMonitor = new PerfMonitor();
		// The perf monitor DOM will be inserted into the dev panel once it's built

		populationGraph = new PopulationGraph();
		document.body.appendChild(populationGraph.dom);
		populationGraph.setVisible(true); // visible by default in dev mode
	}

	// Show VR build version in the copyright footer so we can verify code freshness
	const copyrightEl = document.querySelector("#title-screen .copyright");
	if (copyrightEl) {
		copyrightEl.textContent += ` |     ${VR_BUILD_VERSION}`;
	}

	// 0b. Capture mode: install the emulated WebXR runtime first of all. three.js's VRButton asks
	//     navigator.xr whether immersive-vr is supported the moment it is constructed, so anything
	//     later than this is too late.
	if (CAPTURE) {
		loadingProgress("Installing emulated headset", 3);
		await captureMode.installRuntime();
	}

	// 1. Scene, renderer, camera
	loadingProgress("Setting up scene", 5);
	diagLog("1. SceneManager.init...");
	const renderer = sceneManager.init(
		document.body,
		CAPTURE ? captureMode.rendererOverrides() : null,
	);
	const scene = sceneManager.getScene();
	const camera = sceneManager.getCamera();

	// 2. Camera controls
	cameraController = new CameraController(camera, renderer.domElement);
	GS.cameraController = cameraController;

	if (!MINIMAL && !isIOS) {
		// 2b. WebXR VR support (skip on iOS — no headset support, avoids useless button)
		xrManager = new XRManager(renderer, scene, camera, { devMode });
		GS.xrManager = xrManager;
		xrManager.init();
		// Set initial VR rig position to match camera — in XR mode the camera's own
		// local position is ignored, only the rig's world transform matters.
		// Without this, entering VR before clicking "Start" puts you at (0,0,0).
		if (CAPTURE) {
			// Leaving this null keeps the rig at the origin, so a pose the driver sends is the pose
			// the scene is rendered from with no offset in between. The driver refuses to capture
			// unless the rig's world matrix is the identity, so this is checked rather than trusted.
			xrManager._startPos = null;
		} else {
			xrManager._startPos = camera.position.clone();
			xrManager._startPos.y -= 1.6; // approximate eye height offset for local-floor
		}

		// Auto-start the experience when entering VR while the title screen is showing.
		// The 2D HTML title overlay is invisible in VR, so we bypass it automatically.
		// skipFade: the logo fade uses window.requestAnimationFrame which may not sync
		// with the XR render loop on Quest, so we remove it instantly in VR.
		renderer.xr.addEventListener("sessionstart", () => {
			if (titleScreen.active) {
				titleScreen.handleClick(false, buildTitleContext(), { skipFade: true });
			}
			// Always force-hide logo in VR (belt-and-suspenders - the desktop fade
			// uses opacity which can still render on Quest even at 0)
			titleScreen.hideLogo();
			// Disable desktop god rays in VR (screen-space post doesn't work in stereo)
			if (godRayRenderer) godRayRenderer.enabled = false;
		});
		renderer.xr.addEventListener("sessionend", () => {
			// Re-enable desktop god rays
			if (godRayRenderer) godRayRenderer.enabled = true;
		});
	}

	// 3. Marine snow particles
	if (!MINIMAL) {
		marineSnow.init(scene, camera);
	}

	if (!MINIMAL && xrManager) {
		// 3a. Register performance targets for VR optimization
		xrManager.registerPerformanceTargets(sceneManager, marineSnow);
	}

	// 3b. Particle burst effects (VFX Manager) — initialize if not MINIMAL
	if (!MINIMAL) {
		vfxManager = new VFXManager(scene);
		GS.vfxManager = vfxManager;
		if (xrManager) {
			xrManager.vfxManager = vfxManager;
		}
	}

	// 4. Fade overlay
	fadeOverlay.init();

	// 4b. Cinematic DOF (initialized but not yet in use — will activate in screensaver)
	// Skipped on mobile — BokehPass + EffectComposer allocate float render targets
	// that can cause iOS Safari to produce a black framebuffer.
	if (USE_DOF && !MINIMAL) {
		cinematicDOF = new CinematicDOF(renderer, scene, camera);
		GS.cinematicDOF = cinematicDOF;
	}
	// God rays: screen-space volumetric light shafts (shares caustic pattern)
	// Skipped on mobile/VR — fullscreen post-processing is too heavy,
	// and stereo rendering would double the cost.
	if (USE_GODRAYS && !MINIMAL) {
		godRayRenderer = new GodRayRenderer(renderer, scene, camera);
		GS.godRayRenderer = godRayRenderer;
	}
	// Adaptive resolution: dynamically adjusts pixel ratio based on frame time.
	// Smoothly reduces DPR when GPU is struggling (e.g., fullscreen 4K) and
	// recovers when headroom is available. Desktop only — VR framebuffer is
	// managed by the WebXR runtime.
	if (USE_ADAPTIVE_RES && !MINIMAL) {
		adaptiveResolution = new AdaptiveResolution(renderer);
		GS.adaptiveResolution = adaptiveResolution;
	}
	// VR god rays: DISABLED - perf hit without visible benefit in stereo rendering.
	// Kept as dead code for future re-enabling once we diagnose the rendering issue.
	// if (!MINIMAL) { vrGodRays = new VRGodRays(scene); GS.vrGodRays = vrGodRays; }

	// VR end screen (tinted scene + world-space death message + credits)
	if (!MINIMAL) {
		vrEndScreen = new VREndScreen(scene, camera, renderer);
		GS.vrEndScreen = vrEndScreen;
	}

	diagLog("2-4. Camera/XR/snow/DOF OK");

	if (!MINIMAL) {
		// 5. Audio
		loadingProgress("Initializing audio", 20);
		audioManager = new AudioManager();
		await audioManager.init();
		GS.audioManager = audioManager;
		diagLog("5. Audio OK");

		// 6. Narration
		narrationSystem = new NarrationSystem();
		narrationSystem.init(audioManager);
		GS.narrationSystem = narrationSystem;

		// 7. Population monitor
		populationMonitor = new PopulationMonitor();
		GS.populationMonitor = populationMonitor;

		// 8. Spawner system
		spawnerSystem = new SpawnerSystem();
		GS.spawnerSystem = spawnerSystem;

		// 9a. Initialise Physics (Web Worker with SharedArrayBuffer, sync fallback)
		loadingProgress("Loading physics", 30);
		diagLog("9. Physics init...");
		physicsProxy = new PhysicsProxy();
		await physicsProxy.init();
		GS.physicsProxy = physicsProxy;
		diagLog(`9. Physics OK (worker: ${physicsProxy.useWorker})`);
		Creature.setPhysicsProxy(physicsProxy);
		Food.setPhysicsProxy(physicsProxy);
		Seed.setPhysicsProxy(physicsProxy);

		// 9b. Debug collider visualization
		debugColliders.init(scene);
		debugColliders.setPhysicsProxy(physicsProxy);

		// 9c. Debug force HUD (camera-attached global force indicator)
		debugForceHUD = new DebugForceHUD(camera);
		GS.debugForceHUD = debugForceHUD;

		// 9. Preload GLB models (fish, dolphin, manatee, food, kelp)
		loadingProgress("Loading models", 45);
		diagLog("10. Loading models...");
		await preloadModels([
			"fish",
			"dolphin",
			"manatee",
			"kelp",
			"food",
			"foodAlt",
			"logo",
		]);
		diagLog("10. Models OK");

		// 9b. Re-rig kelp with more bones for smoother Verlet-driven bending
		const kelpSource = getSourceModel("kelp");
		if (kelpSource) {
			proceduralRerig(kelpSource, CONFIG.plant.ragdollSegments);
		}
	} // end !MINIMAL

	// 10. Create a low-poly reef ground (placeholder until real mesh is loaded)
	loadingProgress("Building terrain", 60);
	diagLog("11. Terrain + water...");
	createPlaceholderTerrain(scene, USE_HIRES_TERRAIN);

	// 10a. Create the ocean surface — visible as a bright, rippling plane from below
	createWaterSurface(scene, USE_HIRES_TERRAIN, USE_WATER_ANIM);

	if (!MINIMAL) {
		// 10b. Create terrain physics collider (matches visual terrain)
		// Generate terrain height data for physics
		const terrainSamples = USE_HIRES_TERRAIN ? 257 : 129;
		const terrainHeightData = new Float32Array(terrainSamples * terrainSamples);
		const halfSize = TERRAIN_SIZE / 2;
		for (let row = 0; row < terrainSamples; row++) {
			for (let col = 0; col < terrainSamples; col++) {
				const worldX =
					TERRAIN_CENTER_X -
					halfSize +
					(col / (terrainSamples - 1)) * TERRAIN_SIZE;
				const worldZ =
					TERRAIN_CENTER_Z -
					halfSize +
					(row / (terrainSamples - 1)) * TERRAIN_SIZE;
				terrainHeightData[row * terrainSamples + col] = getTerrainHeight(
					worldX,
					worldZ,
				);
			}
		}
		physicsProxy.createTerrainBody(
			terrainHeightData,
			terrainSamples,
			TERRAIN_SIZE,
			TERRAIN_CENTER_X,
			TERRAIN_CENTER_Z,
		);

		// 10c. Player kinematic capsule — pushes food/creatures/seeds aside
		{
			const capsuleRadius = 0.35;
			const capsuleHalfHeight = 0.6; // total ~1.9m tall (2*0.6 + 2*0.35)
			const cam = camera.position;
			playerBodySlot = physicsProxy.createBody(
				{
					type: "capsule",
					halfHeight: capsuleHalfHeight,
					radius: capsuleRadius,
				},
				{ x: cam.x, y: cam.y - 0.9, z: cam.z }, // center at torso, not eyes
				{ x: 0, y: 0, z: 0, w: 1 },
				"kinematic",
				1, // LAYER_MOVING — collides with all dynamic bodies
				{ mass: 80, restitution: 0.0, friction: 0.2 },
			);
			GS.playerBodySlot = playerBodySlot;
			diagLog(`10c. Player body slot: ${playerBodySlot}`);
		}

		// 11. Create entity pools
		loadingProgress("Spawning creatures", 75);
		diagLog("12. Entity pools...");
		initPools(scene);
		diagLog("12. Pools OK");

		// Mirror pool state to GS
		GS.fishPool = fishPool;
		GS.dolphinPool = dolphinPool;
		GS.manateePool = manateePool;
		GS.foodPool = foodPool;
		GS.seedPool = seedPool;
		GS.plantPool = plantPool;
		GS.allCreaturePools = allCreaturePools;
		GS.foodInstancedMesh = foodInstancedMesh;
		GS.seedInstancedMesh = seedInstancedMesh;
		GS.fishInstanced = fishInstanced;
		GS.dolphinInstanced = dolphinInstanced;
		GS.manateeInstanced = manateeInstanced;
		GS.plantInstanced = plantInstanced;

		// Wire simulation system spawn functions
		initSimulation({ spawnCreature, spawnFood, spawnSeed, spawnPlant });

		// Set titleScreen reference for simulation
		GS.titleScreen = titleScreen;

		// 11a. Initialize HUD system
		hudSystem = new HUDSystem();
		GS.hudSystem = hudSystem;

		// Wire creature pools into camera controller for screensaver hotspot tracking
		cameraController.setCreaturePools(allCreaturePools);

		// Food comes from plants, not a fixed spawner.
		// Players can also throw food with LMB.

		// 12. Feeding input — hold LMB to summon food, release to lob it forward
		feedingInput = new FeedingInput(camera, scene);
		GS.feedingInput = feedingInput;
		feedingInput.init(renderer.domElement);
		feedingInput.onHold = (position) => {
			if (GS.endSequenceActive) return;
			if (modeManager.currentMode?.name !== "narrative") return;
			const food = foodPool.get();
			if (!food) return;
			food.activateHeld(position);
			// Held food is skipped by instanced rendering (early-return in SimulationSystem).
			// The individual mesh must be in the scene so it's visible while held.
			if (!food.mesh.parent) scene.add(food.mesh);
			heldFood = food;
			audioManager.playSFXVariant("spawn");
		};
		feedingInput.onRelease = (force) => {
			if (GS.endSequenceActive) return;
			if (modeManager.currentMode?.name !== "narrative") return;
			if (heldFood && heldFood.active) {
				// Remove from scene before release — instanced mesh takes over rendering
				if (heldFood.mesh.parent === scene) scene.remove(heldFood.mesh);
				heldFood.release();
				heldFood.body.addImpulse(force);
				audioManager.playSFXVariant("throw");
			}
			heldFood = null;
		};
	} // end !MINIMAL

	// 13. Clock
	clock = new THREE.Clock();
	GS.clock = clock;

	if (!MINIMAL) {
		// 14. Build mode context and register modes
		modeContext = buildModeContext();

		modeManager = new SceneModeManager();
		GS.modeManager = modeManager;
		modeManager.register(new NarrativeMode());
		modeManager.register(new ModelViewerMode());
		modeManager.register(new EditorMode());

		// Build dev panel now that modeManager and modeContext are ready
		if (devMode) {
			buildDevPanel({ modeManager, modeContext, perfMonitor });
		}

		// 15. Mode switching: buttons + keyboard (1/2/3)
		document.querySelectorAll("#mode-selector button").forEach((btn) => {
			btn.addEventListener("click", () => {
				modeManager.switchMode(btn.dataset.mode, modeContext);
			});
		});

		window.addEventListener("keydown", (e) => {
			// Ignore keyboard during title screen
			if (titleScreen.active) return;

			// ── Dev-only shortcuts ──
			if (devMode) {
				// Debug toggle (backtick)
				if (e.key === "`") {
					debugMode = !debugMode;
					debugColliders.toggle();
					if (debugForceHUD) debugForceHUD.setVisible(debugMode);
					updateModeUIVisibility();
					console.log(`[PolyFish] Debug mode: ${debugMode ? "ON" : "OFF"}`);
					return;
				}

				// Population graph toggle (G key)
				if (e.key === "g" || e.key === "G") {
					if (populationGraph) populationGraph.toggle();
					return;
				}

				// Time scale cycle (+ or = key)
				if (e.key === "+" || e.key === "=") {
					const idx = TIME_SCALES.indexOf(timeScale);
					timeScale = TIME_SCALES[(idx + 1) % TIME_SCALES.length];
					console.log(`[PolyFish] Time scale: ${timeScale}x`);
					return;
				}

				// Trigger end sequence (0 key — dev only)
				if (e.key === "0" && !GS.endSequenceActive) {
					console.log("[PolyFish] DEV: Triggering end sequence");
					GS.endSequenceActive = true;
					GS.stageRunning = false;
					if (audioManager) {
						audioManager.playSFXVariant("gameOver");
						audioManager.fadeMusic(0, 3);
						audioManager.stopAmbience();
					}
					const popCounter = document.getElementById("population-counter");
					if (popCounter) popCounter.classList.add("hud-hidden");
					if (vrEndScreen) {
						vrEndScreen.start();
						setTimeout(() => audioManager?.playCreditsTrack(), 11000);
					}
					// Desktop: release pointer lock but keep camera still so
					// the VR end screen panel stays in view
					if (cameraController) {
						if (document.pointerLockElement) document.exitPointerLock();
					}
					return;
				}

				// Mode switching — skip if user is typing in an input field
				if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
					if (e.key === "1") {
						if (populationGraph) populationGraph.mark();
						modeManager.switchMode("narrative", modeContext);
						return;
					}
					if (e.key === "2") {
						if (populationGraph) populationGraph.mark();
						modeManager.switchMode("model-viewer", modeContext);
						return;
					}
					if (e.key === "3") {
						if (populationGraph) populationGraph.mark();
						modeManager.switchMode("editor", modeContext);
						return;
					}
				}
			} // end devMode shortcuts

			// Delegate to active mode
			if (modeManager.currentMode) {
				modeManager.currentMode.handleKeyDown(e, modeContext);
			}
		});
	} // end !MINIMAL

	// 15b. Capture mode: hand the module the objects it drives, and suppress the VR chrome. The
	//      fade-to-black on session start is the one that matters: it is animated out by
	//      XRManager.update, which the frozen render path never calls, so a capture would otherwise
	//      grab a hundred black frames.
	let loopFn = gameLoop;
	if (CAPTURE) {
		captureMode.attach({
			renderer,
			scene,
			camera,
			rig: xrManager?.rig ?? null,
			sceneManager,
		});
		if (xrManager) captureMode.suppressVrChrome(xrManager);
		loopFn = captureMode.wrapLoop(gameLoop);
	}

	// 16. Start render loop BEFORE title screen so VR/AR sessions can render
	//     while the title overlay is still showing (Quest: user taps ENTER VR first).
	diagLog("16. Starting render loop (pre-title)...");
	renderer.setAnimationLoop(loopFn);

	// 16b. Title screen — show logo, wait for click before starting narrative
	if (!MINIMAL) {
		diagLog("16b. Title screen...");
		await titleScreen.setup(scene, camera, buildTitleContext());
	} else {
		diagLog("16b. MINIMAL — skipping title screen");
	}

	// 17b. Auto-restart loop if WebGL context is restored after a loss
	renderer.domElement.addEventListener("webglcontextrestored", () => {
		sceneManager.restoreAnimationLoop(loopFn);
	});

	// 17c. Diag watchdog — detect if render loop silently dies
	if (_diagMode) {
		let lastFrameCount = _diagFrameCount;
		setInterval(() => {
			const gl = renderer.getContext();
			if (_diagFrameCount === lastFrameCount) {
				diagLog(
					`WATCHDOG: loop stalled at f${_diagFrameCount} ctxLost=${gl.isContextLost()}`,
				);
			}
			lastFrameCount = _diagFrameCount;
		}, 2000);
	}

	// 17d. The test hook. Thirteen Playwright specs in e2e/ read window.__debug and every one of
	//      them has been failing on a hook nothing defined any more. The live values are getters, so
	//      a spec that polls stageTimer sees it move rather than reading a snapshot from startup.
	window.__debug = {
		scene: sceneManager.getScene(),
		camera: sceneManager.getCamera(),
		renderer,
		cameraController,
		modeManager,
		fishPool,
		dolphinPool,
		manateePool,
		foodPool,
		seedPool,
		plantPool,
		get stageTimer() {
			return GS.stageTimer;
		},
		get timeScale() {
			return timeScale;
		},
		GS,
	};

	// 18. Dismiss loading screen, then fade in from black
	loadingProgress("Ready", 100);
	dismissLoadingScreen();
	// Brief pause so loading screen fade-out overlaps with the scene fade-in
	await new Promise((r) => setTimeout(r, 400));
	fadeOverlay.fadeIn(2000);

	// 19. Load audio clips AFTER all heavy init (models, WASM, pools) is done
	// so decoding doesn't compete with startup and cause frame drops.
	if (!CAPTURE) audioManager.loadClips();

	console.log("[PolyFish] Initialized — click to begin.");
}

// ── Object Pools ───────────────────────────────────────────────
function initPools(scene) {
	function makeCreatureMesh(creatureType) {
		const cfg = CONFIG.creatures[creatureType];
		const clone = getModelClone(creatureType);
		if (clone) {
			clone.scale.setScalar(cfg.scale);
			clone.visible = false;
			// On mobile, skip creature shadow casting to save the extra shadow pass geometry.
			// Plants + terrain still cast/receive shadows for grounding.
			if (useMobileDefaults) {
				clone.traverse((c) => {
					if (c.isMesh) c.castShadow = false;
				});
			}
			return clone;
		}

		// Fallback: placeholder geometry
		console.warn(`[PolyFish] Using placeholder for: ${creatureType}`);
		const bodyGeo = new THREE.ConeGeometry(0.3 * cfg.scale, 1.2 * cfg.scale, 5);
		bodyGeo.rotateX(Math.PI / 2);
		const mat = createColorMaterial(cfg.color);
		const body = new THREE.Mesh(bodyGeo, mat);

		const tailGeo = new THREE.ConeGeometry(0.2 * cfg.scale, 0.5 * cfg.scale, 3);
		tailGeo.rotateX(-Math.PI / 2);
		const tail = new THREE.Mesh(tailGeo, mat.clone());
		tail.position.z = -0.7 * cfg.scale;
		tail.name = "tail";
		body.add(tail);

		const finGeo = new THREE.ConeGeometry(0.08 * cfg.scale, 0.3 * cfg.scale, 3);
		const fin = new THREE.Mesh(finGeo, mat.clone());
		fin.position.y = 0.25 * cfg.scale;
		fin.name = "fin";
		body.add(fin);

		body.visible = false;
		return body;
	}

	function makeFoodMesh() {
		// Procedural plankton shape — stellated octahedron
		const geo = createPlanktonGeometry(0.12, 0.1);
		const mat = createColorMaterial(0x88ffaa, { flatShading: true });
		const mesh = new THREE.Mesh(geo, mat);
		mesh.castShadow = true;
		mesh.scale.setScalar(CONFIG.foodScale);
		mesh.visible = false;
		return mesh;
	}

	function makePlantMesh() {
		const clone = getModelClone("kelp");
		if (clone) {
			clone.scale.setScalar(CONFIG.kelpScale);
			clone.visible = false;
			return clone;
		}
		return null;
	}

	// Helper: apply caustics to all materials on a creature after storeMaterials()
	function patchCreatureCaustics(creature) {
		creature.originalMaterials.forEach(({ material }) =>
			applyCaustics(material, 2.0),
		);
	}

	// When instancing is ON, creature meshes are NOT added to the scene — the
	// InstancedMesh handles all rendering. Mesh objects are kept as position/rotation
	// holders that physics writes to and syncCreatureInstances reads from.
	// When instancing is OFF (mobile/iOS), meshes must be in the scene to render.
	fishPool = new ObjectPool({
		factory: () => {
			const mesh = makeCreatureMesh("fish");
			const creature = new Creature(mesh, "fish");
			creature.storeMaterials();
			patchCreatureCaustics(creature);
			if (!USE_INSTANCING) scene.add(mesh);
			return creature;
		},
		initialSize: USE_FULL_POOLS ? CONFIG.poolSizes.fish : 15,
		canGrow: true,
	});

	dolphinPool = new ObjectPool({
		factory: () => {
			const mesh = makeCreatureMesh("dolphin");
			const creature = new Creature(mesh, "dolphin");
			creature.storeMaterials();
			patchCreatureCaustics(creature);
			if (!USE_INSTANCING) scene.add(mesh);
			return creature;
		},
		initialSize: USE_FULL_POOLS ? CONFIG.poolSizes.dolphin : 4,
		canGrow: true,
	});

	manateePool = new ObjectPool({
		factory: () => {
			const mesh = makeCreatureMesh("manatee");
			const creature = new Creature(mesh, "manatee");
			creature.storeMaterials();
			patchCreatureCaustics(creature);
			if (!USE_INSTANCING) scene.add(mesh);
			return creature;
		},
		initialSize: USE_FULL_POOLS ? CONFIG.poolSizes.manatee : 3,
		canGrow: true,
	});

	allCreaturePools.push(
		{ pool: fishPool, type: "fish" },
		{ pool: dolphinPool, type: "dolphin" },
		{ pool: manateePool, type: "manatee" },
	);

	// ── Instanced creature meshes (85+ draw calls → 3) ──
	// Each creature type gets one InstancedMesh with shared material + instanced swim.
	// Individual creature meshes are hidden for alive creatures; dead creatures
	// render via their own mesh (death material override).
	// Toggle: ?noInstancing disables instanced rendering (falls back to per-mesh)
	if (USE_INSTANCING) {
		const fishSource = getModelClone("fish");
		if (fishSource) {
			fishSource.scale.setScalar(1); // raw model scale; creature scale goes into instance matrix
			fishInstanced = createCreatureInstanced(
				fishSource,
				"fish",
				MAX_FISH_INSTANCES,
			);
			if (fishInstanced) scene.add(fishInstanced.mesh);
		}
		const dolphinSource = getModelClone("dolphin");
		if (dolphinSource) {
			dolphinSource.scale.setScalar(1);
			dolphinInstanced = createCreatureInstanced(
				dolphinSource,
				"dolphin",
				MAX_DOLPHIN_INSTANCES,
			);
			if (dolphinInstanced) scene.add(dolphinInstanced.mesh);
		}
		const manateeSource = getModelClone("manatee");
		if (manateeSource) {
			manateeSource.scale.setScalar(1);
			manateeInstanced = createCreatureInstanced(
				manateeSource,
				"manatee",
				MAX_MANATEE_INSTANCES,
			);
			if (manateeInstanced) scene.add(manateeInstanced.mesh);
		}
	}

	foodPool = new ObjectPool({
		factory: () => {
			const modelMesh = makeFoodMesh();
			const food = new Food(modelMesh);
			// NOTE: Individual food meshes are NOT added to scene.
			// Rendering is handled by foodInstancedMesh (1 draw call for all food).
			return food;
		},
		initialSize: USE_FULL_POOLS ? CONFIG.poolSizes.food : 20,
		canGrow: true,
	});

	// Create shared InstancedMesh for all food particles
	{
		const foodGeo = createPlanktonGeometry(0.12, 0.1);
		const foodMat = createColorMaterial(0x88ffaa, { flatShading: true });
		applyCaustics(foodMat, 2.0);
		foodInstancedMesh = new THREE.InstancedMesh(
			foodGeo,
			foodMat,
			MAX_FOOD_INSTANCES,
		);
		foodInstancedMesh.castShadow = true;
		foodInstancedMesh.count = 0; // start empty
		foodInstancedMesh.frustumCulled = false; // instances span the whole scene
		scene.add(foodInstancedMesh);
	}

	seedPool = new ObjectPool({
		factory: () => {
			const seed = new Seed();
			// NOTE: Individual seed meshes are NOT added to scene.
			// Rendering is handled by seedInstancedMesh (1 draw call for all seeds).
			return seed;
		},
		initialSize: USE_FULL_POOLS ? CONFIG.poolSizes.seed : 10,
		canGrow: true,
	});

	// Create shared InstancedMesh for all seeds
	{
		const seedGeo = new THREE.OctahedronGeometry(0.1, 0);
		const seedMat = createColorMaterial(CONFIG.seedColor, {
			flatShading: true,
		});
		applyCaustics(seedMat, 2.0);
		seedInstancedMesh = new THREE.InstancedMesh(
			seedGeo,
			seedMat,
			MAX_SEED_INSTANCES,
		);
		seedInstancedMesh.castShadow = true;
		seedInstancedMesh.count = 0;
		seedInstancedMesh.frustumCulled = false;
		scene.add(seedInstancedMesh);
	}

	plantPool = new ObjectPool({
		factory: () => {
			const modelMesh = makePlantMesh();
			// Apply caustics and shadows to plant materials
			if (modelMesh) {
				modelMesh.traverse((child) => {
					if (child.isMesh) {
						if (child.material) applyCaustics(child.material, 4.0);
						child.castShadow = true;
						child.receiveShadow = true;
					}
				});
			}
			const plant = new Plant(modelMesh);
			// When instancing is ON, plant meshes are NOT added to the scene — they
			// exist only as transform holders for instanced rendering.
			// When instancing is OFF (mobile/iOS), we must add them to the scene
			// so they render as individual meshes.
			if (!USE_INSTANCING && modelMesh) scene.add(modelMesh);
			return plant;
		},
		initialSize: USE_FULL_POOLS ? CONFIG.poolSizes.plant : 15,
		canGrow: true,
	});

	// ── Instanced plant mesh (200+ draw calls → 1) ──
	// Uses bone DataTexture for per-instance skeletal animation from VerletChain.
	// Gated by USE_INSTANCING — RGBA32F DataTexture can cause iOS context loss.
	if (USE_INSTANCING) {
		const kelpSourceForInstancing = getSourceModel("kelp");
		if (kelpSourceForInstancing) {
			plantInstanced = createPlantInstanced(
				kelpSourceForInstancing,
				MAX_PLANT_INSTANCES,
			);
			if (plantInstanced) scene.add(plantInstanced.mesh);
		}
	}
}

// ── Spawning Helpers ───────────────────────────────────────────
function spawnCreature(type, position, parentSpeed) {
	const poolMap = {
		fish: fishPool,
		dolphin: dolphinPool,
		manatee: manateePool,
	};
	const pool = poolMap[type];
	if (!pool) return;

	const creature = pool.get();
	if (!creature) return;

	creature.activate(position);
	if (parentSpeed !== undefined && CONFIG.geneticMutation) {
		creature.mutateFrom(parentSpeed);
	}
}

function spawnFood(position, force, ageFraction) {
	const food = foodPool.get();
	if (!food) return;
	food.activate(position, force, ageFraction);
}

function spawnSeed(position) {
	const seed = seedPool.get();
	if (!seed) return;
	seed.activate(position);
}

function spawnPlant(position, seed) {
	const plant = plantPool.get();
	if (!plant) return;
	plant.activate(position);
	// Link seed so it stays visible until this plant dies
	plant._linkedSeed = seed || null;
}

function spawnInitialSeed() {
	const pos = new THREE.Vector3(0, -6, -2); // In front of camera (cam at Z=6.44, looks toward -Z)
	const seed = seedPool.get();
	if (!seed) {
		console.warn("[PolyFish] No seed available in pool!");
		return;
	}
	seed.activate(pos);
	seed.forceGerminate = true; // Set AFTER activate so it isn't cleared
}

// ── Game Loop ──────────────────────────────────────────────────
let _diagFrameCount = 0;
let perfMonitor = null;
let populationGraph = null;
function gameLoop() {
	try {
		if (perfMonitor) perfMonitor.begin();
		const rawDt = Math.min(clock.getDelta(), 0.1);
		const elapsed = clock.elapsedTime;

		_diagFrameCount++;

		// First few frames: log render stats to diagnose black screen on mobile
		if (_diagMode && _diagFrameCount <= 5) {
			const r = sceneManager.getRenderer();
			const gl = r.getContext();
			const glErr = gl.getError();
			diagLog(
				`frame ${_diagFrameCount}: glErr=${glErr} programs=${r.info.programs?.length || 0} ctxLost=${gl.isContextLost()}`,
			);
			if (_diagFrameCount === 1) {
				diagLog(
					`canvas: ${r.domElement.width}x${r.domElement.height} inDOM=${!!r.domElement.parentNode}`,
				);
				diagLog(
					`cam: ${sceneManager
						.getCamera()
						.position.toArray()
						.map((v) => v.toFixed(1))}`,
				);
				diagLog(`scene children: ${sceneManager.getScene().children.length}`);
			}
		}

		// Capture mode: run the ecosystem for its warmup, then freeze. The freeze reuses the
		// render-only path below rather than adding a second one, so there is one code path that
		// has to be still instead of two that have to agree.
		if (CAPTURE) captureMode.tick(rawDt);

		// ?noSim or ?minimal — skip all simulation, just render the static scene (iOS debug)
		if (_params.has("noSim") || MINIMAL || captureMode.frozen) {
			// Render only — no physics, no creature updates, no camera updates
			const renderer = sceneManager.getRenderer();
			const scene = sceneManager.getScene();
			const camera = sceneManager.getCamera();
			renderer.info.reset();
			if (_diagMode && _diagFrameCount <= 5)
				diagLog(`f${_diagFrameCount} render(noSim)...`);
			sceneManager.render();
			if (_diagMode && _diagFrameCount <= 5)
				diagLog(`f${_diagFrameCount} render(noSim) OK`);
			return;
		}

		// ── Always-on visual updates (run before simulation so they animate
		//    even if simulationStep throws or title screen is still active) ──
		updateCausticTime(elapsed);
		if (godRayRenderer) godRayRenderer.update(elapsed);
		if (adaptiveResolution) adaptiveResolution.update(rawDt);
		// VR god rays disabled (vrGodRays is null)
		// VR end screen animation (tint, death message, credits scroll)
		if (vrEndScreen && vrEndScreen.active) {
			vrEndScreen.update(rawDt);
		}
		waterSurface.update(elapsed);
		marineSnow.update(rawDt);
		// Feed creature positions for particle-fish collision, then update VFX
		vfxManager?.setCreaturePositions(
			GS._activeFish,
			GS._activeDolphins,
			GS._activeManatees,
		);
		vfxManager?.update(rawDt);

		// Sub-step simulation: run multiple iterations at normal dt
		// so physics and creature AI stay in sync at higher time scales.
		// At 1x this is a single step; at 5x it's five steps of rawDt each.
		if (_diagMode && _diagFrameCount <= 5)
			diagLog(`f${_diagFrameCount} sim...`);
		for (let i = 0; i < timeScale; i++) {
			runSimulationStep(rawDt, elapsed);
		}
		if (_diagMode && _diagFrameCount <= 5)
			diagLog(`f${_diagFrameCount} sim OK`);

		// ── Always-on updates (once per frame, use scaled dt for visuals) ──
		const dt = rawDt * timeScale;

		// Keep held food pinned in front of camera while LMB is down
		if (heldFood && !heldFood.active) {
			// Food was eaten from hand - haptic feedback (stronger than feed pulse)
			if (xrManager && xrManager.active) {
				xrManager.pulseEatHaptic();
			}
			// Remove from scene if we added it for desktop/mobile held rendering
			if (heldFood.mesh.parent === scene) scene.remove(heldFood.mesh);
			heldFood = null; // food was eaten/expired
		}
		// VR: check per-controller held food for eaten/expired
		for (let ci = 0; ci < 2; ci++) {
			if (_vrHeldFood[ci] && !_vrHeldFood[ci].active) {
				if (xrManager && xrManager.active) xrManager.pulseEatHaptic();
				_vrHeldFood[ci]._vrGrip = null;
				_vrHeldFood[ci] = null;
				_vrFoodParentedTo[ci] = null;
			}
		}

		// ── XR vs flat-screen update path ──
		if (xrManager && xrManager.active) {
			// VR mode: XRManager handles locomotion + per-controller feeding
			const xrResults = xrManager.update(dt, feedingInput, heldFood);
			if (xrResults && Array.isArray(xrResults)) {
				for (let ci = 0; ci < xrResults.length; ci++) {
					const r = xrResults[ci];
					if (!r) continue;

					// ── Per-controller food: scene-graph parenting approach ──
					// Instead of manually computing world positions (stale during callback),
					// we parent food meshes to the grip group. Three.js handles the transform
					// automatically during render - same mechanism as controller hints.

					if (
						r.triggerHeld &&
						!_vrHeldFood[ci] &&
						!_vrFoodSpawned[ci] &&
						r.grip
					) {
						// SPAWN: create food and parent its mesh to the grip
						const food = foodPool.get();
						if (food) {
							// Use a position far from anything so the physics body (and any
							// Jolt collider) doesn't interact with fish before we can sync
							// it to the real grip position.
							food.activateHeld(_vrFoodSpawnPos);
							food._vrHeldScale = food.targetScale;
							food.targetScale *= 0.5;

							// Keep food in scene (not parented to grip) so we can lerp for
							// a weighted feel. Hide it until the grip's matrixWorld is valid
							// (stale for the first 1-2 frames).
							food.mesh.position.set(0, -99999, 0);
							food.body.position.set(0, -99999, 0);
							food.body.velocity.set(0, 0, 0);
							food._vrGripFrames = 0;
							food._vrGrip = r.grip; // reference for lerp target each frame

							_vrHeldFood[ci] = food;
							_vrFoodSpawned[ci] = true;
							_vrFoodParentedTo[ci] = null;
							audioManager?.playSFXVariant("spawn");
						}
					} else if (r.triggerHeld && _vrHeldFood[ci]) {
						// HOLD: lerp food toward grip for a weighted/laggy feel (like desktop).
						const food = _vrHeldFood[ci];
						food._vrGripFrames = (food._vrGripFrames || 0) + 1;

						if (food._vrGripFrames >= 2 && food._vrGrip) {
							// Compute world-space target from grip + local offset
							// (localToWorld calls updateWorldMatrix internally)
							_vrFoodTarget.copy(VR_FOOD_GRIP_OFFSET);
							food._vrGrip.localToWorld(_vrFoodTarget);
							food._vrGrip.getWorldQuaternion(_vrFoodTargetQuat);

							if (food._vrGripFrames === 2) {
								// First valid frame — snap to position (no lerp from -99999)
								food.mesh.position.copy(_vrFoodTarget);
								food.mesh.quaternion.copy(_vrFoodTargetQuat);
							} else {
								// Lerp for weighted feel (tighter than desktop's -12 for snappier VR tracking)
								const lerpFactor = 1 - Math.exp(-20 * (dt || 0.016));
								food.mesh.position.lerp(_vrFoodTarget, lerpFactor);
								food.mesh.quaternion.slerp(_vrFoodTargetQuat, lerpFactor);
							}
							food.body.position.copy(food.mesh.position);
						}
						food.body.velocity.set(0, 0, 0);
					}

					// Trigger released -> throw food
					if (r.triggerReleased) {
						_vrFoodSpawned[ci] = false;
						const food = _vrHeldFood[ci];
						if (food && food.active) {
							// Food is already in the scene with correct world position/rotation
							// from lerp — just sync the physics body.
							food.body.position.copy(food.mesh.position);

							if (food._vrHeldScale) {
								food.targetScale = food._vrHeldScale;
								food._vrHeldScale = null;
							}

							// Release — override random spin with controller angular velocity
							// so the food continues the motion of your hand.
							food.release();
							if (r.throwForce?._angularVelocity) {
								food.spinX = r.throwForce._angularVelocity.x;
								food.spinZ = r.throwForce._angularVelocity.z;
							} else {
								food.spinX = (Math.random() - 0.5) * 2;
								food.spinZ = (Math.random() - 0.5) * 2;
							}

							if (r.throwForce) {
								food.body.addImpulse(r.throwForce);
							}
							audioManager?.playSFXVariant("throw");
							food._vrGrip = null;
							_vrHeldFood[ci] = null;
							_vrFoodParentedTo[ci] = null;
						}
					}
				}
			}

			// Update spatial audio listener position from XR camera
			if (audioManager) {
				const xrCamera = sceneManager.getCamera();
				audioManager.updateListenerPosition(xrCamera);
			}
		} else {
			// Flat-screen mode: desktop/mobile feeding + camera
			feedingInput.updateHeld(heldFood, dt);
			cameraController.update(dt, elapsed);

			// Update spatial audio listener from desktop camera
			if (audioManager) {
				audioManager.updateListenerPosition(sceneManager.getCamera());
			}
		}

		// (visual updates already ran at top of frame)

		// Update HUD and VR HUD with population data
		const camera = sceneManager.getCamera();
		const populationData = hudSystem.update(
			dt,
			{ fishPool, dolphinPool, manateePool, plantPool, foodPool, seedPool },
			camera,
		);
		if (xrManager && xrManager.active && populationData) {
			xrManager.updateHud(populationData);
		}

		// Debug collider wireframes
		debugColliders.update();

		// Debug force HUD (global current / buoyancy compass)
		if (debugForceHUD) debugForceHUD.update(elapsed);

		// Debug visualization — target indicators for all creatures
		const scene = sceneManager.getScene();
		for (const { pool } of allCreaturePools) {
			pool.forEachActive((creature) => {
				creature.updateDebug(scene, debugMode);
			});
		}

		// Mode-specific update (skip during title screen)
		if (!titleScreen.active) {
			modeManager.update(dt, elapsed, modeContext);
		}

		// Reset renderer info before render so counts are per-frame
		const renderer = sceneManager.getRenderer();
		renderer.info.reset();

		// Render — DOF pipeline or standard.
		if (_diagMode && _diagFrameCount <= 5)
			diagLog(`f${_diagFrameCount} render...`);
		if (
			cinematicDOF &&
			cameraController._dofEnabled &&
			cameraController.mode === "screensaver"
		) {
			// DOF pipeline toggled via 'D' key in screensaver mode
			if (cameraController._vignetteEnabled && !cinematicDOF.vignettePass) {
				cinematicDOF.enableVignettePass();
			}
			if (cinematicDOF.vignettePass) {
				cinematicDOF.vignettePass.enabled = cameraController._vignetteEnabled;
			}
			// DOF path: skip god rays (heavy effect already, and DOF manages its own render target)
			cinematicDOF.render();
		} else {
			// Capture depth buffer first, then render scene normally, then overlay god rays.
			// This avoids routing scene colors through an intermediate render target
			// which would alter the color pipeline.
			if (godRayRenderer && godRayRenderer.enabled)
				godRayRenderer.captureDepth();
			sceneManager.render();
			if (godRayRenderer && godRayRenderer.enabled)
				godRayRenderer.renderOverlay();
		}
		if (_diagMode && _diagFrameCount <= 5)
			diagLog(`f${_diagFrameCount} render OK`);

		// After third frame: check for shader errors (common mobile black screen cause)
		if (_diagMode && _diagFrameCount === 3 && !gameLoop._shaderChecked) {
			gameLoop._shaderChecked = true;
			const r = sceneManager.getRenderer();
			const info = r.info.render;
			diagLog(
				`render: calls=${info.calls} tris=${info.triangles} pts=${info.points}`,
			);
			// Check for WebGL shader errors
			const gl = r.getContext();
			const programs = r.info.programs || [];
			diagLog(`compiled shaders: ${programs.length}`);
			let shaderErrors = 0;
			for (const prog of programs) {
				if (prog.diagnostics && !prog.diagnostics.runnable) {
					shaderErrors++;
					diagLog(
						`SHADER FAIL: ${prog.name} — ${prog.diagnostics.fragmentShader?.log || prog.diagnostics.vertexShader?.log || "unknown"}`,
					);
				}
			}
			if (shaderErrors === 0) diagLog("All shaders compiled OK");
		}

		// Performance monitor — stats.js graphs + custom info panel (dev mode only)
		if (perfMonitor) {
			perfMonitor.end(rawDt, renderer, {
				fish: fishPool,
				dolphin: dolphinPool,
				manatee: manateePool,
				plant: plantPool,
				food: foodPool,
				seed: seedPool,
			}, { timeScale, adaptiveResolution });
		}

		// Population graph — live species count chart (dev mode only)
		if (populationGraph) {
			populationGraph.sample(elapsed, {
				fish: fishPool.getActiveCount(),
				dolphin: dolphinPool.getActiveCount(),
				manatee: manateePool.getActiveCount(),
				plant: plantPool.getActiveCount(),
				food: foodPool.getActiveCount(),
			});
		}
	} catch (loopErr) {
		// Catch any uncaught error in the game loop so it surfaces on iOS diag overlay
		console.error("[PolyFish] gameLoop error:", loopErr);
		diagLog(`LOOP ERROR f${_diagFrameCount}: ${loopErr?.message || loopErr}`);
		// Still update visuals + render even if simulation errored —
		// essential for VR (black screen / frozen caustics otherwise)
		try {
			const elapsed = clock ? clock.elapsedTime : 0;
			const dt = Math.min(clock ? clock.getDelta() : 0.016, 0.1);
			updateCausticTime(elapsed);
			if (godRayRenderer) godRayRenderer.update(elapsed);
			waterSurface.update(elapsed);
			marineSnow.update(dt);
			if (godRayRenderer && godRayRenderer.enabled)
				godRayRenderer.captureDepth();
			sceneManager.render();
			if (godRayRenderer && godRayRenderer.enabled)
				godRayRenderer.renderOverlay();
		} catch (_) {
			/* swallow */
		}
	}
}

// ── Restart (full teardown / reconstruct) ─────────────────────
function restartEcosystem() {
	const scene = sceneManager.getScene();

	// ── 0. Reset species discovery ──
	hudSystem.reset();

	// ── 1. TEAR DOWN — destroy all entity pools and remove meshes from scene ──
	debugColliders.removeAll(); // clean up any lingering debug visuals first
	fishPool.destroyAll(scene);
	dolphinPool.destroyAll(scene);
	manateePool.destroyAll(scene);
	foodPool.destroyAll(scene);
	seedPool.destroyAll(scene);
	plantPool.destroyAll(scene);
	allCreaturePools.length = 0;

	// Remove instanced meshes (will be recreated in initPools)
	if (foodInstancedMesh) {
		scene.remove(foodInstancedMesh);
		foodInstancedMesh = null;
	}
	if (seedInstancedMesh) {
		scene.remove(seedInstancedMesh);
		seedInstancedMesh = null;
	}
	if (plantInstanced) {
		scene.remove(plantInstanced.mesh);
		plantInstanced = null;
	}
	if (fishInstanced) {
		scene.remove(fishInstanced.mesh);
		fishInstanced = null;
	}
	if (dolphinInstanced) {
		scene.remove(dolphinInstanced.mesh);
		dolphinInstanced = null;
	}
	if (manateeInstanced) {
		scene.remove(manateeInstanced.mesh);
		manateeInstanced = null;
	}

	// ── 2. RECONSTRUCT — fresh pools, same scene ──
	initPools(scene);

	// Mirror pool state to GS
	GS.fishPool = fishPool;
	GS.dolphinPool = dolphinPool;
	GS.manateePool = manateePool;
	GS.foodPool = foodPool;
	GS.seedPool = seedPool;
	GS.plantPool = plantPool;
	GS.allCreaturePools = allCreaturePools;
	GS.foodInstancedMesh = foodInstancedMesh;
	GS.seedInstancedMesh = seedInstancedMesh;
	GS.fishInstanced = fishInstanced;
	GS.dolphinInstanced = dolphinInstanced;
	GS.manateeInstanced = manateeInstanced;
	GS.plantInstanced = plantInstanced;

	// Re-wire creature pools into camera controller
	cameraController.setCreaturePools(allCreaturePools);

	// ── 3. RESET systems (lightweight, no assets to reload) ──
	populationMonitor.reset();
	narrationSystem.reset();
	spawnerSystem = new SpawnerSystem();
	GS.spawnerSystem = spawnerSystem;

	// Reset staged spawns
	GS.stageTimer = 0;
	GS.stageRunning = true;
	GS.stageEvents.forEach((e) => (e.fired = false));

	// Rebuild mode context so it references the new pools
	modeContext = buildModeContext();
	GS.modeContext = modeContext;

	// ── 4. AUDIO — clean restart ──
	audioManager.restartMusic();
	audioManager.startAmbience();

	// ── 5. Seed first plant (creatures come via staged timers) ──
	spawnInitialSeed();
}

// ── Start ──────────────────────────────────────────────────────
init().catch((err) => {
	console.error("[PolyFish] Fatal error during init:", err);
	diagLog(`FATAL: ${err?.message || err}\n${err?.stack || ""}`);
});
