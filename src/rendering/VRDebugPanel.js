/**
 * VRDebugPanel - A floating text panel visible in VR for debugging.
 *
 * Renders console-log-style messages onto a canvas texture, displayed
 * on a plane mesh attached as a child of the camera (like VRHud) so it
 * automatically follows the user's head. Also provides small colored
 * cubes on each controller as a visual feed-state indicator.
 *
 * Usage:
 *   const panel = new VRDebugPanel(camera);
 *   panel.log('Hello VR!');
 *   // In render loop: panel.update();  (just redraws texture if dirty)
 *   // Cleanup: panel.dispose();
 */
import * as THREE from 'three';

export const VR_BUILD_VERSION = 'v1.1.0';

const MAX_LINES = 16;
const CANVAS_W = 512;
const CANVAS_H = 320;

export class VRDebugPanel {
  constructor(camera) {
    this.camera = camera;
    this.lines = [];
    this._visible = false;

    // Canvas for text rendering
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d');

    // Texture + material
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;

    const geo = new THREE.PlaneGeometry(0.5, 0.32);
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0.9,
      depthTest: true,   // world-space depth (not always-on-top)
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 100;
    this.mesh.frustumCulled = false; // always render
    this.mesh.visible = false;

    // Position relative to camera: chest level (below and forward)
    // 0.6m forward, 0.4m down from eye level
    this.mesh.position.set(0, -0.35, -0.6);

    // Attach to camera so it follows the view (same pattern as VRHud)
    camera.add(this.mesh);

    // ── Feed state indicators (small cubes on controllers) ──
    this._feedIndicators = [];

    this._dirty = true;
  }

  /**
   * Create small indicator cubes attached to controllers.
   * Call after controllers are set up.
   */
  attachIndicators(controllers) {
    for (let i = 0; i < controllers.length; i++) {
      const ctrl = controllers[i];
      if (!ctrl) continue;

      const cubeGeo = new THREE.BoxGeometry(0.04, 0.04, 0.04);
      const cubeMat = new THREE.MeshBasicMaterial({
        color: 0x00ff00, // green = idle
        depthTest: true,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      });
      const cube = new THREE.Mesh(cubeGeo, cubeMat);
      cube.renderOrder = 100;
      cube.position.set(0, 0.05, -0.08); // above and in front of controller
      ctrl.add(cube);
      this._feedIndicators[i] = cube;
    }
  }

  /**
   * Set indicator color for a controller.
   * @param {number} index - controller index
   * @param {number} color - hex color
   */
  setIndicatorColor(index, color) {
    const ind = this._feedIndicators[index];
    if (ind) ind.material.color.setHex(color);
  }

  /** Add a log line. Newer messages appear at the bottom. */
  log(msg) {
    const ts = performance.now().toFixed(0);
    this.lines.push(`${ts} ${msg}`);
    if (this.lines.length > MAX_LINES) {
      this.lines.shift();
    }
    this._dirty = true;
    // Also console.log for desktop debugging
    console.log(`[VRDebug] ${msg}`);
  }

  /** Show/hide the panel */
  setVisible(visible) {
    this._visible = visible;
    this.mesh.visible = visible;
  }

  /**
   * Call each frame to redraw texture if dirty.
   * Panel positioning is automatic (child of camera).
   */
  update() {
    if (!this._visible) return;

    // Redraw texture if dirty
    if (!this._dirty) return;
    this._dirty = false;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Border
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, CANVAS_W - 2, CANVAS_H - 2);

    // Header
    ctx.fillStyle = '#00ff00';
    ctx.font = 'bold 16px monospace';
    ctx.fillText(`-- VR DEBUG ${VR_BUILD_VERSION} --`, 8, 20);

    // Log lines
    ctx.font = '13px monospace';
    const lineH = 18;
    const startY = 40;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      // Color code: errors in red, warnings in yellow
      if (line.includes('ERR') || line.includes('FAIL') || line.includes('EMPTY')) {
        ctx.fillStyle = '#ff4444';
      } else if (line.includes('WARN')) {
        ctx.fillStyle = '#ffaa00';
      } else if (line.includes('SPAWN') || line.includes('FEED START')) {
        ctx.fillStyle = '#44ffff';
      } else {
        ctx.fillStyle = '#00ff00';
      }
      ctx.fillText(line, 8, startY + i * lineH);
    }

    this.texture.needsUpdate = true;
  }

  dispose() {
    if (this.camera) {
      this.camera.remove(this.mesh);
    }
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    // Clean up indicators
    for (const ind of this._feedIndicators) {
      if (ind) {
        ind.parent?.remove(ind);
        ind.geometry.dispose();
        ind.material.dispose();
      }
    }
  }
}
