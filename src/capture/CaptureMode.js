/**
 * Capture mode — PolyFish as a subject for splat capture.
 *
 * A sibling tool (`splattool`, working name Snowglobe) captures a bounded volume of a rendered world
 * as a Gaussian splat. It needs to command a camera to exact poses and read back the frames, and the
 * one interface every VR application already accepts an absolute pose through is its VR runtime. So
 * the tool pretends to be the headset: it installs an emulated WebXR device in this page, drives its
 * pose from outside the browser, and grabs the canvas.
 *
 * This module is everything that requires of PolyFish. It is inert unless `?capture=1` is on the
 * URL, and the twelve lines it adds to `main.js` are all guarded by that. Nothing here changes how
 * the app behaves for a visitor.
 *
 *     ?capture=1&w=1024&h=768&warmup=25&ipd=0.063&fovy=90&depth=1
 *
 * Three things make this app worth capturing, and all three are the reason it goes before a game:
 *
 *   1. **The rendered pose is readable.** `readViews()` returns the view transforms and projections
 *      WebXR handed us for the frame that was just drawn, not the pose anyone asked for. That lets
 *      the tool prove the frame it grabbed was rendered from the pose it sent, which is the one
 *      thing no screenshot-mod route can offer.
 *   2. **The scene can be frozen.** A splat trainer needs every view to agree about where things
 *      are, and this app has fish that swim, kelp that sways and a water surface that moves.
 *   3. **The floor is a formula.** `getTerrainHeight` is closed-form, so a reconstruction can be
 *      measured against truth rather than against a screenshot of itself.
 *
 * The frame convention matches the tool's manifest exactly with no conversion: metres, Y up,
 * right-handed, camera looking down its own -Z. That is WebXR's tracking space, three.js's world,
 * and glTF's camera, so a pose crosses this boundary untouched.
 */

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { getTerrainHeight } from '../utils/Terrain.js';
import { VR_BUILD_VERSION } from '../rendering/VRDebugPanel.js';

const params = new URLSearchParams(window.location.search);

/** Capture mode is off unless asked for, and `?capture=0` turns it off again. */
export const CAPTURE = params.has('capture') && params.get('capture') !== '0';

function number(name, fallback) {
  if (!params.has(name)) return fallback;
  const value = Number(params.get(name));
  return Number.isFinite(value) ? value : fallback;
}

/**
 * What the capture was asked for. Every one of these ends up in the manifest the tool writes, so a
 * capture can be reproduced from its own record.
 *
 * `near` and `far` are not PolyFish's own (0.08 and 800). A depth buffer spends its precision on the
 * near plane, and a 10000:1 range wastes almost all of it, so capture pulls the range in to what a
 * room-sized volume actually needs. Both are overridable because a capture of something further off
 * needs a different answer.
 */
export const captureConfig = {
  width: Math.max(16, Math.round(number('w', 1024))),
  height: Math.max(16, Math.round(number('h', 768))),
  /** Stereo baseline in metres. Zero captures one mono view per pose instead of a pair. */
  ipd: Math.max(0, number('ipd', 0.063)),
  /** Vertical field of view in degrees. */
  fovy: number('fovy', 90),
  /** Seconds of simulation to run before freezing, so kelp and creatures exist. */
  warmup: Math.max(0, number('warmup', 25)),
  near: number('near', 0.1),
  far: number('far', 200),
  depth: params.get('depth') !== '0',
  /**
   * Multisampling. On by default because an aliased edge trains into a splat as a hard artefact,
   * and off is worth having because the MSAA resolve is where this renderer's per-frame
   * nondeterminism comes from: see `stillnessProbe`.
   */
  antialias: params.get('aa') !== '0',
};

/** The effects a capture has to have off, and the names the manifest records them under. */
export const LOCKED_EFFECTS = [
  'simulation', 'fog', 'caustics', 'godrays', 'dof', 'marine-snow', 'water-animation',
  'adaptive-resolution', 'vr-vignette', 'vr-hud', 'title-screen',
];

class CaptureMode {
  constructor() {
    this.frame = 0;
    this.frozen = false;
    this.xrDevice = null;
    this.views = [];
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.rig = null;
    this._elapsedSinceStart = 0;
    this._warmupDone = false;
    this._depth = null;
    this._notes = [];
  }

  /**
   * Installs the emulated WebXR runtime, replacing `navigator.xr`.
   *
   * Has to run before anything reads `navigator.xr`, which in this app means before `XRManager` is
   * constructed, because three.js's `VRButton` queries session support as soon as it is built.
   *
   * `iwer` is a dev dependency and is imported dynamically, so a production build never pulls the
   * emulator in: this call is behind `CAPTURE`, and the import is inside it.
   */
  async installRuntime() {
    const { XRDevice, metaQuest3 } = await import('iwer');
    // The package's index does not re-export its version, and the manifest records which build of the
    // emulator produced a capture, so this reaches for the module that does hold it and shrugs if the
    // layout changes.
    this.iwerVersion = await import('iwer/lib/version.js').then((m) => m.VERSION).catch(() => 'unknown');
    const stereo = captureConfig.ipd > 0;
    this.xrDevice = new XRDevice(metaQuest3, {
      stereoEnabled: stereo,
      ipd: captureConfig.ipd,
      // IWER wants radians; the URL is in degrees because every other field here is human units.
      fovy: (captureConfig.fovy * Math.PI) / 180,
    });
    // `forceInstall` is not optional here, and finding that out cost an afternoon. A real browser
    // already has `navigator.xr`, and IWER declines to replace a native runtime unless forced: it
    // warns to the console and returns, leaving the page talking to the browser's own WebXR. That
    // then refuses an immersive session because there is no headset attached, and the error names
    // the session configuration rather than the runtime, which points in the wrong direction.
    // Replacing the native runtime is the entire point of capture mode, so it is forced.
    this.xrDevice.installRuntime({ forceInstall: true });

    // And then checked, because the failure above was silent. This asks the question we actually
    // need answered rather than comparing identities: can we open an immersive session at all?
    const supported = await navigator.xr?.isSessionSupported?.('immersive-vr');
    if (!supported) {
      throw new Error(
        'capture: the emulated runtime did not take. navigator.xr reports immersive-vr is not ' +
        'supported, which means the page is still talking to the browser\'s own WebXR.',
      );
    }

    this._note(
      `emulated runtime installed: ${stereo ? 'stereo' : 'mono'}, ipd ${captureConfig.ipd} m, ` +
      `fovy ${captureConfig.fovy} deg`,
    );
    return this.xrDevice;
  }

  /**
   * The canvas size a capture needs: both eyes side by side, at the requested per-eye resolution.
   *
   * The driver has to make the *browser viewport* this size, and cannot simply ask the renderer for
   * it. When a session starts, the emulated runtime moves the canvas into a container of its own and
   * sets `canvas.width = window.innerWidth; canvas.height = window.innerHeight`, overwriting whatever
   * the renderer had set. It then builds the projection and the per-eye viewports from that canvas.
   * So the window is what decides the capture resolution, and a driver that sets one and not the
   * other gets frames at a size its manifest does not describe.
   *
   * `status().canvasMatchesRequest` reports whether the two agree, and the driver refuses if not.
   * The intrinsics are read from the viewport that actually came back either way, so the manifest is
   * never wrong about the frames beside it, only possibly not the size that was asked for.
   */
  canvasSize() {
    return {
      width: captureConfig.width * (captureConfig.ipd > 0 ? 2 : 1),
      height: captureConfig.height,
    };
  }

  /**
   * The renderer options a capture needs, for `SceneManager.init` to merge in.
   *
   * `preserveDrawingBuffer` is what makes `toDataURL` return the frame that was just drawn rather
   * than a cleared buffer. `alpha: false` matters more than it looks: with an alpha channel the
   * canvas is composited and `toDataURL` unpremultiplies, which shifts every colour slightly, and a
   * trainer fed slightly wrong colours produces a slightly wrong splat with nothing to point at.
   */
  rendererOverrides() {
    return {
      alpha: false,
      preserveDrawingBuffer: true,
      antialias: captureConfig.antialias,
      // A capture is a fixed number of pixels, decided by the operator and recorded in the
      // manifest. Device pixel ratio and adaptive resolution both have to stay out of it.
      pixelRatio: 1,
      // Stereo puts the two eyes side by side in one canvas, so the backing store is double width.
      // The emulated runtime overwrites this on session start; see canvasSize().
      ...this.canvasSize(),
      fixedSize: true,
    };
  }

  /** Wires the module to the app's objects. Call once, after `XRManager.init`. */
  attach({ renderer, scene, camera, rig, sceneManager }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.rig = rig ?? null;
    this.sceneManager = sceneManager ?? null;

    // The clip range the XR projection is built from: three.js pushes the app camera's near and far
    // into the session's render state, and the emulated runtime builds its projection from those.
    camera.near = captureConfig.near;
    camera.far = captureConfig.far;
    camera.updateProjectionMatrix();

    // Fog is distance-dependent haze. Every view of the same surface from a different range would
    // disagree about its colour, which a trainer resolves by inventing geometry that is not there.
    scene.fog = null;

    this.publish();
  }

  /**
   * Enters an immersive session without a click.
   *
   * Whether the emulated runtime demands a user gesture was an open question, so this reports what
   * happened rather than assuming: on failure the driver falls back to clicking the app's own VR
   * button, which is a real gesture.
   */
  async enterXR() {
    if (this.renderer.xr.isPresenting) return { entered: true, how: 'already' };
    try {
      // Required rather than optional. `local-floor` puts the tracking origin on the floor, which is
      // the space every pose in the capture is expressed in. Asked for optionally and not granted,
      // three.js would fall back to `local` and every pose would be offset by an eye height that
      // nothing records.
      const session = await navigator.xr.requestSession('immersive-vr', {
        requiredFeatures: ['local-floor'],
      });
      await this.renderer.xr.setSession(session);
      return { entered: true, how: 'requestSession' };
    } catch (error) {
      return { entered: false, how: 'requestSession', error: String(error?.message ?? error) };
    }
  }

  /**
   * Wraps the app's animation loop.
   *
   * Two things have to happen around each frame and neither can be done from outside it. The view
   * data is read at the top, because an `XRFrame` is only valid inside its own callback and asking
   * it for a pose later throws. The frame counter is bumped at the bottom, after the render, so that
   * "the counter advanced by two" means two frames were actually drawn rather than two were started.
   * The driver's settle wait depends on that distinction being right.
   */
  wrapLoop(loop) {
    return (time, frame) => {
      this._beginFrame(frame);
      try {
        loop(time, frame);
      } finally {
        this.frame++;
      }
    };
  }

  _beginFrame(frame) {
    if (!frame) return;
    const xr = this.renderer?.xr;
    const referenceSpace = xr?.getReferenceSpace?.();
    if (!referenceSpace) return;

    let pose;
    try {
      pose = frame.getViewerPose(referenceSpace);
    } catch {
      // A frame with no pose is a frame the runtime could not locate the headset for. Keeping the
      // previous views would let the driver record a stale pose beside a fresh image, so drop them.
      this.views = [];
      return;
    }
    if (!pose) {
      this.views = [];
      return;
    }

    const layer = frame.session.renderState.baseLayer;
    // A view with an empty viewport was not drawn and has no pixels to read. The emulated runtime
    // always reports both eyes, and in mono it gives the right one a width of zero rather than
    // leaving it out, so this is an ordinary case and not an error: `?ipd=0` produces one rendered
    // view and one placeholder. Dropping it here makes `readViews()` mean "the views this frame was
    // actually rendered from", which is what every caller wants and what makes the count worth
    // checking.
    this.views = pose.views.filter((view) => {
      const viewport = layer ? layer.getViewport(view) : null;
      return viewport != null && viewport.width > 0 && viewport.height > 0;
    }).map((view) => {
      const viewport = layer.getViewport(view);
      return {
        eye: view.eye,
        // Column-major, exactly as WebXR hands them over. The tool transposes on the way into its
        // manifest, in one place, rather than anyone here guessing which convention it wants.
        transform: Array.from(view.transform.matrix),
        projection: Array.from(view.projectionMatrix),
        viewport: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
      };
    });
  }

  /**
   * Advances the warmup clock, and freezes when it runs out. Called from the game loop.
   *
   * The ecosystem has to run before it is worth capturing: kelp grows from seeds and creatures spawn
   * in stages, so a scene frozen at zero seconds is an empty seabed.
   */
  tick(dt) {
    if (this._warmupDone) return;
    // The clock starts when the session does, not when the page loads. The ecosystem only begins
    // spawning once the title screen is dismissed, which happens on session start, so counting from
    // page load would spend the warmup on an empty seabed.
    if (!this.renderer?.xr?.isPresenting) return;
    this._elapsedSinceStart += dt;
    if (this._elapsedSinceStart >= captureConfig.warmup) {
      this._warmupDone = true;
      this.freeze();
    }
  }

  /**
   * Stops everything that moves.
   *
   * The mechanism is the game loop's existing render-only path, the one `?noSim` uses, which skips
   * the simulation step and every time-driven visual update: the caustic clock, the water surface,
   * marine snow, the particle effects and adaptive resolution. Reusing it rather than writing a
   * second freeze means there is one code path that has to be still, not two.
   *
   * Whether it is *actually* still is not something to reason about. `stillnessProbe()` measures it.
   */
  freeze() {
    this.frozen = true;
    this._note(`frozen after ${this._elapsedSinceStart.toFixed(1)} s of warmup`);
  }

  /**
   * Hides everything the VR path draws that is not the world.
   *
   * The fade quad is the one that would ruin a capture outright. `XRManager` sets it fully opaque on
   * session start and holds it there for half a second, then fades it out from `update()` — which the
   * frozen render path never calls. So a capture would grab frame after frame of solid black, and
   * nothing about the manifest would look wrong.
   *
   * The rest is comfort and diagnostic furniture: a vignette on the camera, a population HUD, the
   * controller hints, the build-version panel, and the controller models themselves. All of it sits
   * between the eye and the scene and all of it would train into the splat as geometry.
   *
   * This runs on session start as well as now, because `XRManager` re-shows several of these there.
   * Its listener is registered in `init()`, which runs before this, and listeners fire in order, so
   * ours undoes what theirs did.
   */
  suppressVrChrome(xrManager) {
    const hide = () => {
      // The fade quad, both ways: invisible, and transparent in case something makes it visible.
      if (xrManager._fadeMesh) {
        xrManager._fadeMesh.visible = false;
        const uniforms = xrManager._fadeMesh.material?.uniforms;
        if (uniforms?.opacity) uniforms.opacity.value = 0;
      }
      xrManager._fadeTimer = 0;

      for (const part of [xrManager.vignette, xrManager.hud, xrManager.controllerHints, xrManager.debugPanel]) {
        if (!part) continue;
        if (typeof part.setVisible === 'function') part.setVisible(false);
        if (part.mesh) part.mesh.visible = false;
        if (part.group) part.group.visible = false;
      }

      // Controller rays, grip models and hand meshes, all parented to the rig.
      for (const list of [xrManager.controllers, xrManager.controllerGrips, xrManager.hands]) {
        if (!Array.isArray(list)) continue;
        for (const item of list) if (item) item.visible = false;
      }
    };

    hide();
    this.renderer.xr.addEventListener('sessionstart', () => {
      hide();
      // Once more after a frame, because the hints and the HUD are built lazily on the first update
      // in some paths and would appear after this listener has run.
      requestAnimationFrame(hide);
      this._note('vr chrome suppressed');
    });
    this._suppressChrome = hide;
  }

  /** The views WebXR handed us for the frame just drawn. Empty if the runtime lost tracking. */
  readViews() {
    return this.views;
  }

  /**
   * The rig's world transform, column-major.
   *
   * Locomotion moves this group, and a capture with a moved rig would have every pose offset from
   * what the driver asked for by an amount nothing records. The driver refuses unless it is the
   * identity, so this is reported rather than assumed.
   */
  rigMatrix() {
    if (!this.rig) return null;
    this.rig.updateWorldMatrix(true, false);
    return Array.from(this.rig.matrixWorld.elements);
  }

  /**
   * The canvas as a PNG data URL. Both eyes, side by side, when stereo is on.
   *
   * Needs `preserveDrawingBuffer`, or this returns a cleared buffer on some drivers and, worse,
   * the correct image on others, which is the kind of difference that shows up only on another
   * machine.
   */
  grabFrame() {
    const canvas = this.renderer.domElement;
    return {
      dataUrl: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
    };
  }

  /**
   * How much the canvas changed since the last call. The driver takes two, a second apart, and
   * refuses to capture if the scene is still moving.
   *
   * This measures rather than hashes, and the difference matters. A hash was the first attempt and it
   * was useless: it called this scene moving when nothing in it was. Measuring said why. With
   * multisampling on, consecutive renders of an identical frozen scene differ by one or two units out
   * of 255 on about four pixels in a thousand, scattered over the whole frame. That is the MSAA
   * resolve, and it is proven rather than guessed: two reads with no frame in between are
   * bit-identical, the difference does not grow as the gap widens from 100 ms to 5 s, and with
   * `?aa=0` it is exactly zero at every interval.
   *
   * So the question is not "did any pixel change" but "did anything move", and those need different
   * instruments. Something moving between two frames changes pixels by tens or hundreds; a resolve
   * that rounds differently changes them by one. `maxDelta` separates the two cleanly, and the
   * fraction changed is reported beside it so that a slow drift spread over many pixels is visible
   * too.
   */
  stillnessProbe() {
    const canvas = this.renderer.domElement;
    const gl = this.renderer.getContext();
    const width = canvas.width;
    const height = canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const previous = this._stillPixels;
    const sinceFrame = this._stillFrame ?? this.frame;
    this._stillPixels = pixels;
    this._stillFrame = this.frame;

    const total = width * height;
    if (!previous || previous.length !== pixels.length) {
      return { first: true, width, height, total, frame: this.frame };
    }

    let changed = 0;
    let maxDelta = 0;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const d = Math.max(
        Math.abs(pixels[i] - previous[i]),
        Math.abs(pixels[i + 1] - previous[i + 1]),
        Math.abs(pixels[i + 2] - previous[i + 2]),
      );
      if (d > 0) {
        changed++;
        sum += d;
        if (d > maxDelta) maxDelta = d;
      }
    }
    return {
      first: false,
      width,
      height,
      total,
      changed,
      fraction: changed / total,
      maxDelta,
      meanDelta: changed ? sum / changed : 0,
      framesApart: this.frame - sinceFrame,
      frame: this.frame,
    };
  }

  /**
   * Exact view-space depth for one eye, as a `Float32Array` of metres along the camera's own -Z.
   *
   * Two decisions here are the whole correctness of it.
   *
   * **The depth comes from a real render of the real materials.** An override material that writes
   * depth directly would be simpler and would be wrong: this app displaces fish vertices in a swim
   * shader and drives kelp bones from a texture, so a material that does not reproduce those would
   * describe creatures that are not where the colour frame shows them. Rendering the scene as it is
   * and reading its depth attachment cannot disagree with the colour frame by construction.
   *
   * **The camera is rebuilt from the view data, not borrowed from three.js.** The matrices are set
   * from the same `transform` and `projection` the driver records, with the automatic updates off, so
   * the depth pass and the recorded pose cannot drift apart. Borrowing the renderer's XR camera would
   * work today and would depend on how three.js chooses to decompose a view matrix.
   */
  readDepth(eyeIndex) {
    if (!captureConfig.depth) throw new Error('capture: depth is off; pass ?depth=1');
    const view = this.views[eyeIndex];
    if (!view) throw new Error(`capture: no view ${eyeIndex} to read depth for`);
    const width = view.viewport?.width ?? captureConfig.width;
    const height = view.viewport?.height ?? captureConfig.height;

    const gl = this.renderer.getContext();
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error(
        'capture: EXT_color_buffer_float is missing, so a float depth target cannot be read back. ' +
        'Run headed, or with a GPU-backed headless Chromium.',
      );
    }

    const pass = this._depthPass(width, height);

    // The camera, rebuilt from the recorded view so the depth matches the colour frame exactly.
    const camera = pass.camera;
    camera.matrixWorld.fromArray(view.transform);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    camera.projectionMatrix.fromArray(view.projection);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

    const renderer = this.renderer;
    // three.js replaces the camera it is handed with the session's own while a session is presenting,
    // which would render both eyes into this target instead of the one asked for. Standing the XR
    // path down for the duration is the only way to render an explicit camera, and the session is
    // untouched: this runs between frames, and the flag goes back before the next one.
    const wasEnabled = renderer.xr.enabled;
    const previousTarget = renderer.getRenderTarget();
    renderer.xr.enabled = false;
    try {
      renderer.setRenderTarget(pass.sceneTarget);
      renderer.clear(true, true, true);
      renderer.render(this.scene, camera);

      // The depth attachment holds window-space z in [0, 1]. Turning it into metres needs the same
      // two terms the tool's own inversion uses, so a mismatch would show up as a scaled cloud.
      const projection = view.projection;
      pass.material.uniforms.tDepth.value = pass.sceneTarget.depthTexture;
      pass.material.uniforms.m10.value = projection[10];
      pass.material.uniforms.m14.value = projection[14];

      renderer.setRenderTarget(pass.linearTarget);
      renderer.render(pass.quadScene, pass.quadCamera);

      const rgba = new Float32Array(width * height * 4);
      renderer.readRenderTargetPixels(pass.linearTarget, 0, 0, width, height, rgba);

      // readRenderTargetPixels hands back rows bottom-up. Every image in the tool is top-down, and
      // the EXR it lands in is written top-down, so the flip happens here where the reason is visible.
      const out = new Float32Array(width * height);
      for (let y = 0; y < height; y++) {
        const source = (height - 1 - y) * width * 4;
        const destination = y * width;
        for (let x = 0; x < width; x++) out[destination + x] = rgba[source + x * 4];
      }
      return { width, height, data: out };
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.xr.enabled = wasEnabled;
    }
  }

  _depthPass(width, height) {
    if (this._depth && this._depth.width === width && this._depth.height === height) return this._depth;
    if (this._depth) this._disposeDepthPass();

    const sceneTarget = new THREE.WebGLRenderTarget(width, height);
    sceneTarget.depthTexture = new THREE.DepthTexture(width, height);
    // Twenty-four bits, the same choice GodRayRenderer makes. A shorter depth buffer would put
    // millimetres of quantisation on a floor thirty metres off.
    sceneTarget.depthTexture.type = THREE.UnsignedIntType;

    const linearTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
    });

    const material = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        m10: { value: 0 },
        m14: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D tDepth;
        uniform float m10;
        uniform float m14;
        varying vec2 vUv;
        void main() {
          // Window-space z to normalised device z, then the projection's third row inverted. A texel
          // of exactly 1.0 is the far plane and comes out as the far distance, which is what the
          // manifest's sky cutoff is compared against.
          float ndc = 2.0 * texture2D(tDepth, vUv).x - 1.0;
          gl_FragColor = vec4(m14 / (ndc + m10), 0.0, 0.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    const quadScene = new THREE.Scene();
    quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

    const camera = new THREE.PerspectiveCamera();
    camera.matrixAutoUpdate = false;
    camera.matrixWorldAutoUpdate = false;

    this._depth = {
      width, height, sceneTarget, linearTarget, material, quadScene,
      quadCamera: new THREE.Camera(),
      camera,
    };
    return this._depth;
  }

  _disposeDepthPass() {
    const d = this._depth;
    if (!d) return;
    d.sceneTarget.depthTexture.dispose();
    d.sceneTarget.dispose();
    d.linearTarget.dispose();
    d.material.dispose();
    d.quadScene.traverse((o) => o.geometry?.dispose());
    this._depth = null;
  }

  _note(text) {
    this._notes.push(text);
    console.log(`[capture] ${text}`);
  }

  /** The state the driver checks before it captures anything. */
  status() {
    return {
      frame: this.frame,
      frozen: this.frozen,
      warmupRemaining: Math.max(0, captureConfig.warmup - this._elapsedSinceStart),
      presenting: !!this.renderer?.xr?.isPresenting,
      views: this.views.length,
      rig: this.rigMatrix(),
      config: { ...captureConfig },
      // Recorded in the manifest's `source.tool`, so a capture says which build of what produced it.
      versions: { app: VR_BUILD_VERSION, three: THREE.REVISION, iwer: this.iwerVersion ?? null },
      antialias: captureConfig.antialias,
      lockedEffects: LOCKED_EFFECTS,
      notes: this._notes.slice(),
      fog: !!this.scene?.fog,
      canvas: this.renderer
        ? { width: this.renderer.domElement.width, height: this.renderer.domElement.height }
        : null,
      wanted: this.canvasSize(),
      canvasMatchesRequest: this._canvasMatchesRequest(),
    };
  }

  _canvasMatchesRequest() {
    if (!this.renderer) return false;
    const want = this.canvasSize();
    const canvas = this.renderer.domElement;
    return canvas.width === want.width && canvas.height === want.height;
  }

  /** The scene's own truth, for a check that measures a reconstruction against the formula. */
  truth() {
    return { surfaceY: CONFIG.surfaceY, terrainFormula: 'sin(0.05x) * cos(0.04z) * 2 - 7.81' };
  }

  publish() {
    window.__capture = {
      version: 1,
      config: captureConfig,
      lockedEffects: LOCKED_EFFECTS,
      status: () => this.status(),
      enterXR: () => this.enterXR(),
      readViews: () => this.readViews(),
      rigMatrix: () => this.rigMatrix(),
      grabFrame: () => this.grabFrame(),
      stillnessProbe: () => this.stillnessProbe(),
      readDepth: (eye) => {
        const { width, height, data } = this.readDepth(eye);
        // Structured clone would copy this fine, but the driver reads it over a JSON bridge, so it
        // crosses as base64 rather than as a hundred thousand numbers in an array literal.
        return { width, height, base64: base64OfFloats(data) };
      },
      freeze: () => this.freeze(),
      truth: () => this.truth(),
      terrainHeight: (x, z) => getTerrainHeight(x, z),
      setPose: (position, quaternion) => {
        if (!this.xrDevice) throw new Error('capture: no emulated device; this is a native XR run');
        this.xrDevice.position.set(position[0], position[1], position[2]);
        this.xrDevice.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
        return this.frame;
      },
    };
  }
}

/** Little-endian float32 as base64, which is how a depth image crosses the browser bridge. */
function base64OfFloats(floats) {
  const bytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export const captureMode = new CaptureMode();
