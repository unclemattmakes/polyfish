import * as THREE from 'three';
import { CONFIG } from '../config.js';

/**
 * SceneManager
 * Manages the Three.js scene, camera, and renderer.
 * Singleton instance for centralized scene setup and rendering.
 */
class SceneManager {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.contextLost = false;
    this.vrModeActive = false;
  }

  /**
   * Initialize the scene, camera, and renderer
   * @param {HTMLElement} container - The DOM element to attach renderer to
   * @param {Object} [overrides] - Capture mode's renderer settings. When `fixedSize` is set the
   *   canvas is the size given here and stays that size: a capture is a fixed number of pixels,
   *   recorded in its manifest, so neither device pixel ratio nor a window resize may touch it.
   *   See src/capture/CaptureMode.js.
   */
  init(container, overrides = null) {
    // Create renderer with high-quality settings
    const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    // VR headsets (Quest 3) register as mobile via ontouchstart but have
    // desktop-class GPUs — give them full quality rendering.
    const isVRCapable = 'xr' in navigator;
    const useMobileGfx = isMobile && !isVRCapable;
    // ?useHiDPR enables full DPR. Default: 2 on desktop, 1.0 on mobile.
    const params = new URLSearchParams(window.location.search);
    const useHiDPR = params.has('useHiDPR') ? params.get('useHiDPR') !== '0' : !useMobileGfx;
    this.renderer = new THREE.WebGLRenderer({
      antialias: overrides?.antialias ?? true, // MSAA everywhere — modern mobile GPUs handle it fine
      alpha: overrides?.alpha ?? true,
      preserveDrawingBuffer: overrides?.preserveDrawingBuffer ?? false,
      powerPreference: 'default',
    });
    // Cap pixel ratio based on effective pixel count, not just raw DPR.
    // On a 4K monitor (3840×2160) with DPR 2.0, uncapped rendering would push
    // 7680×4320 = 33M pixels — brutal on any GPU. We cap so the effective
    // framebuffer never exceeds ~4K worth of pixels (MAX_EFFECTIVE_WIDTH).
    // IMPORTANT: setPixelRatio MUST come before setSize so the first frame's
    // canvas buffer matches the intended DPR (avoids iOS layout glitch where
    // the canvas briefly renders at wrong size, causing Safari to rescale the viewport).
    const MAX_EFFECTIVE_WIDTH = 3840; // never exceed ~4K horizontal resolution
    const rawDPR = window.devicePixelRatio || 1;
    const hardCap = useHiDPR ? 2 : 1.0;
    const effectiveCap = MAX_EFFECTIVE_WIDTH / window.innerWidth;
    const maxDPR = Math.min(rawDPR, hardCap, effectiveCap);
    if (overrides?.fixedSize) {
      this.fixedSize = { width: overrides.width, height: overrides.height };
      this.renderer.setPixelRatio(overrides.pixelRatio ?? 1);
      this.renderer.setSize(overrides.width, overrides.height, false);
    } else {
      this.renderer.setPixelRatio(Math.max(maxDPR, 0.75)); // floor at 0.75 to avoid blurriness
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    }
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Handle WebGL context loss gracefully (prevents mobile reload loops)
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      // Stop the animation loop so we don't hammer a dead context
      this.renderer.setAnimationLoop(null);
      console.warn('[SceneManager] WebGL context lost — animation loop stopped');
      // Surface to diag overlay if active (diagLog is a global from main.js)
      if (typeof diagLog === 'function') diagLog('!! WebGL CONTEXT LOST !!');
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      console.log('[SceneManager] WebGL context restored — restarting render');
      // The caller will need to re-set the animation loop via restoreAnimationLoop()
    });
    container.appendChild(this.renderer.domElement);

    // Create camera
    this.camera = new THREE.PerspectiveCamera(
      CONFIG.cameraFOV,
      window.innerWidth / window.innerHeight,
      CONFIG.cameraNearClip,
      CONFIG.cameraFarClip
    );
    // Unity VR player (OVRCameraRig): position (0, 0, -6.441) → Three.js XZ: (0, 6.441)
    // Unity terrain base Y: -7.81.  Camera = terrain surface + 5'11" (1.8m) eye height.
    // Terrain height at player XZ (0, 6.44): sin(0)*cos(...)* 2.0 - 7.81 = -7.81
    // Camera Y = -7.81 + 1.8 = -6.01
    this.camera.position.set(0, -6.01, 6.44);
    this.camera.lookAt(0, -6.01, 0);

    // Create scene
    this.scene = new THREE.Scene();

    // Add camera to scene so camera-parented children (e.g. HUD) render
    this.scene.add(this.camera);

    // Add fog (linear fog to match Unity)
    this.scene.fog = new THREE.Fog(CONFIG.fogColor, CONFIG.fogStart, CONFIG.fogEnd);

    // Add ambient light
    const ambientLight = new THREE.AmbientLight(
      CONFIG.ambientLightColor,
      CONFIG.ambientLightIntensity
    );
    this.scene.add(ambientLight);

    // Add directional light (sun filtering through water from above)
    const directionalLight = new THREE.DirectionalLight(
      CONFIG.directionalLightColor,
      CONFIG.directionalLightIntensity
    );
    directionalLight.position.set(50, 100, 50);
    directionalLight.castShadow = true;
    directionalLight.shadow.intensity = CONFIG.directionalShadowStrength || 0.9;
    // Mobile: 1024 shadow map + tighter 40-unit frustum (less wasted texels)
    // Desktop: 2048 shadow map + 60-unit frustum for full scene coverage
    const shadowRes = useMobileGfx ? 1024 : 2048;
    const shadowExtent = useMobileGfx ? 40 : 60;
    directionalLight.shadow.mapSize.width = shadowRes;
    directionalLight.shadow.mapSize.height = shadowRes;
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far = 200;
    directionalLight.shadow.camera.left = -shadowExtent;
    directionalLight.shadow.camera.right = shadowExtent;
    directionalLight.shadow.camera.top = shadowExtent;
    directionalLight.shadow.camera.bottom = -shadowExtent;
    directionalLight.shadow.bias = -0.0005;
    directionalLight.shadow.normalBias = 0.02;
    this.scene.add(directionalLight);

    // Subtle hemisphere light — blue from above (sky through water), warm from below (seafloor scatter)
    const hemiLight = new THREE.HemisphereLight(0x3366aa, 0x443322, 0.3);
    this.scene.add(hemiLight);

    // Load skybox/cubemap (downscale on mobile to save GPU memory)
    this.isMobile = isMobile;
    this.useMobileGfx = useMobileGfx;
    this.loadSkybox();

    // Handle window resize
    window.addEventListener('resize', () => this.onWindowResize());

    return this.renderer;
  }

  /**
   * Load cubemap skybox from textures directory
   * Falls back to gradient background if textures unavailable
   */
  async loadSkybox() {
    const textureLoader = new THREE.CubeTextureLoader();
    const textureDir = '/textures/skybox/';

    try {
      const cubemap = await textureLoader.loadAsync([
        textureDir + 'right.png',  // +X
        textureDir + 'left.png',   // -X
        textureDir + 'top.png',    // +Y
        textureDir + 'bottom.png', // -Y
        textureDir + 'front.png',  // +Z
        textureDir + 'back.png',   // -Z
      ]);

      // Determine target size based on platform and VR mode
      let targetSize = null;
      if (this.vrModeActive) {
        // VR: 512px faces — more detail than mobile but less than desktop
        targetSize = 512;
      } else if (this.isMobile) {
        // Mobile: downscale to 128×128 to save ~90 MB GPU
        targetSize = 128;
      }

      if (targetSize !== null) {
        for (let i = 0; i < cubemap.images.length; i++) {
          const img = cubemap.images[i];
          if (img.width > targetSize || img.height > targetSize) {
            const canvas = document.createElement('canvas');
            canvas.width = targetSize;
            canvas.height = targetSize;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, targetSize, targetSize);
            cubemap.images[i] = canvas;
          }
        }
        cubemap.needsUpdate = true;
      }

      this.scene.background = cubemap;
      this.scene.environment = cubemap; // Use for IBL
    } catch (error) {
      // Fallback: use gradient background (deep underwater blue)
      console.warn('Skybox textures not found, using fallback gradient background');
      this.scene.background = new THREE.Color(0x001a4d);
      this.scene.environment = null;
    }
  }

  /**
   * Set VR mode active/inactive, triggering skybox reload with appropriate resolution
   * @param {boolean} active - Whether VR mode is active
   */
  setVRMode(active) {
    if (this.vrModeActive === active) return; // no-op if state unchanged

    this.vrModeActive = active;
    // SceneManager VR mode toggled

    // Reload skybox with VR-appropriate resolution (512px)
    this.loadSkybox();
  }

  /**
   * Get the scene
   * @returns {THREE.Scene}
   */
  getScene() {
    return this.scene;
  }

  /**
   * Get the camera
   * @returns {THREE.PerspectiveCamera}
   */
  getCamera() {
    return this.camera;
  }

  /**
   * Get the renderer
   * @returns {THREE.WebGLRenderer}
   */
  getRenderer() {
    return this.renderer;
  }

  /**
   * Render the scene (skips if WebGL context is lost)
   */
  render() {
    if (this.contextLost) return;
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Re-attach the animation loop after a context restore.
   * @param {Function} loopFn — the game loop callback
   */
  restoreAnimationLoop(loopFn) {
    if (!this.contextLost) {
      this.renderer.setAnimationLoop(loopFn);
    }
  }

  /**
   * Handle window resize events
   */
  onWindowResize() {
    // A capture's canvas is the size its manifest says it is. Resizing it mid-run would change the
    // intrinsics for the frames after the resize and nothing would record that it happened.
    if (this.fixedSize) return;
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height);
  }
}

// Export singleton instance
export default new SceneManager();
