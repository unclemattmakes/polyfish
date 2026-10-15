/**
 * VREndScreen - End-of-simulation credits sequence.
 *
 * When the fish population reaches 0, this shows a cinematic ending:
 *   1. The scene fades to near-black (tint sphere for 3D, DOM fade for screen)
 *   2. "The PolyFish have died." fades in
 *   3. Credits scroll upward (like film credits)
 *   4. Fade to full black, then reload
 *
 * Desktop/mobile: DOM overlay with CSS-based scrolling credits.
 * VR: Fades the scene to full black via the tint sphere, then ends the
 *     XR session so the same polished DOM credits play on the flat screen.
 */
import * as THREE from 'three';

// ── Credits content ──

const CREDITS_HTML = `
<div class="end-death-msg">The PolyFish have died.</div>
<div class="end-death-line"></div>
<div class="end-credits-spacer-xl"></div>
<div class="end-credits-spacer-xl"></div>
<div class="end-credits-spacer-xl"></div>
<div class="end-logo">PolyFish</div>
<div class="end-subtitle">REMASTERED</div>
<div class="end-credits-spacer-xl"></div>
<div class="end-role">Created by</div>
<div class="end-name">Matt Scott</div>
<div class="end-credits-spacer-lg"></div>
<div class="end-role">Narrated by</div>
<div class="end-name">Phil Scott</div>
<div class="end-credits-spacer-lg"></div>
<div class="end-role">Music</div>
<div class="end-credits-spacer-sm"></div>
<div class="end-music-title">\u201CField of Fireflies\u201D</div>
<div class="end-music-artist">Purrple Cat</div>
<div class="end-music-license">purrplecat.com \u00B7 CC BY-SA 3.0</div>
<div class="end-credits-spacer-sm"></div>
<div class="end-music-title">\u201CWonders\u201D</div>
<div class="end-music-artist">Alex-Productions</div>
<div class="end-music-license">onsound.eu \u00B7 CC BY 3.0</div>
<div class="end-credits-spacer-sm"></div>
<div class="end-music-title">\u201COnce Upon a Time\u201D</div>
<div class="end-music-artist">Alex-Productions</div>
<div class="end-music-license">onsound.eu \u00B7 CC BY 3.0</div>
<div class="end-credits-spacer-lg"></div>
<div class="end-role">Sound Design & Ambience</div>
<div class="end-name">GameMaster Audio</div>
<div class="end-credits-spacer-lg"></div>
<div class="end-role">Built with</div>
<div class="end-credits-spacer-sm"></div>
<div class="end-built-with">Three.js &nbsp;\u00B7&nbsp; Jolt Physics &nbsp;\u00B7&nbsp; Blender &nbsp;\u00B7&nbsp; Claude</div>
<div class="end-credits-spacer-xl"></div>
<div class="end-thanks">Thank you for playing.</div>
<div class="end-credits-spacer-lg"></div>
<div class="end-copyright">\u00A9 2026 Uncle Matt Makes</div>
<div class="end-credits-spacer-xl"></div>
`;

// ── DOM CSS ──

let _cssInjected = false;
function _injectCSS() {
  if (_cssInjected) return;
  _cssInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .end-overlay {
      position: fixed;
      inset: 0;
      z-index: 1000;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      align-items: center;
      overflow: hidden;
      font-family: "Helvetica Neue", "SF Pro Display", system-ui, -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    .end-fade {
      position: absolute;
      inset: 0;
      background: #000;
      opacity: 0;
      transition: none;
    }

    .end-scroll-container {
      position: relative;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-top: 45vh;
      opacity: 0;
    }

    .end-death-msg {
      font-size: clamp(24px, 4vw, 48px);
      font-weight: 200;
      color: rgba(255, 255, 255, 0.78);
      letter-spacing: 0.08em;
      text-align: center;
      padding: 0 20px;
    }

    .end-death-line {
      width: 60px;
      height: 1px;
      background: rgba(255, 255, 255, 0.15);
      margin: 28px auto 0;
    }

    .end-logo {
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(36px, 6vw, 64px);
      font-weight: 500;
      color: #d4a04a;
      text-align: center;
    }

    .end-subtitle {
      font-size: clamp(12px, 1.8vw, 20px);
      font-weight: 300;
      color: rgba(255, 255, 255, 0.3);
      letter-spacing: 0.4em;
      text-align: center;
      margin-top: 4px;
    }

    .end-role {
      font-size: clamp(11px, 1.4vw, 16px);
      font-weight: 400;
      color: rgba(180, 195, 220, 0.5);
      letter-spacing: 0.25em;
      text-transform: uppercase;
      text-align: center;
    }

    .end-name {
      font-size: clamp(20px, 3.2vw, 34px);
      font-weight: 300;
      color: rgba(255, 255, 255, 0.88);
      text-align: center;
      margin-top: 6px;
    }

    .end-music-title {
      font-size: clamp(16px, 2.4vw, 26px);
      font-weight: 300;
      font-style: italic;
      color: rgba(255, 255, 255, 0.7);
      text-align: center;
    }

    .end-music-artist {
      font-size: clamp(12px, 1.6vw, 18px);
      font-weight: 300;
      color: rgba(255, 255, 255, 0.4);
      text-align: center;
      margin-top: 2px;
    }

    .end-music-license {
      font-size: clamp(9px, 1.1vw, 13px);
      font-weight: 300;
      color: rgba(255, 255, 255, 0.2);
      text-align: center;
      margin-top: 2px;
    }

    .end-built-with {
      font-size: clamp(14px, 2vw, 22px);
      font-weight: 300;
      color: rgba(255, 255, 255, 0.55);
      text-align: center;
    }

    .end-thanks {
      font-size: clamp(22px, 3.6vw, 40px);
      font-weight: 200;
      color: rgba(255, 255, 255, 0.65);
      text-align: center;
    }

    .end-copyright {
      font-size: clamp(10px, 1.2vw, 15px);
      font-weight: 300;
      color: rgba(255, 255, 255, 0.2);
      text-align: center;
    }

    .end-credits-spacer-sm { height: clamp(12px, 2vh, 20px); }
    .end-credits-spacer    { height: clamp(24px, 4vh, 40px); }
    .end-credits-spacer-lg { height: clamp(36px, 6vh, 60px); }
    .end-credits-spacer-xl { height: clamp(50px, 8vh, 80px); }
  `;
  document.head.appendChild(style);
}

export class VREndScreen {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(scene, camera, renderer) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer || null;
    this.active = false;
    this._phase = 'idle';
    this._isVR = false;

    // ── Scene tint: inside-out sphere darkens the 3D world ──
    const tintGeo = new THREE.SphereGeometry(0.5, 32, 16);
    const tintMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    this.tintSphere = new THREE.Mesh(tintGeo, tintMat);
    this.tintSphere.renderOrder = 900;
    this.tintSphere.visible = false;
    camera.add(this.tintSphere);

    // ── DOM overlay ──
    _injectCSS();
    this._overlay = null;
    this._fade = null;
    this._scrollContainer = null;
    this._scrollY = 0;

    this._timer = 0;
  }

  /**
   * Start the end sequence.
   */
  start() {
    if (this.active) return;
    this.active = true;
    this._phase = 'stopping';
    this._timer = 0;
    this._isVR = !!(this.renderer?.xr?.isPresenting);

    console.log(`[VREndScreen] start – isVR=${this._isVR}`);

    // Hide mobile/desktop HUD elements so they don't show over credits
    this._hideHUD();

    if (!this._isVR) {
      // Desktop/mobile: create DOM overlay immediately
      this._createDOMOverlay();
    }
    // VR: tint sphere fades to black first, then we exit XR and show DOM credits
  }

  /** Hide all game HUD elements (mobile controls, feed button, etc.) */
  _hideHUD() {
    const ids = [
      'joystick-container', 'feed-btn', 'gyro-toggle', 'cinema-toggle',
      'hud', 'mode-selector',
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    // VR enter button (created by Three.js VRButton, no stable ID — find by class/text)
    const vrBtn = document.getElementById('VRButton');
    if (vrBtn) vrBtn.style.display = 'none';
  }

  // ── DOM overlay setup ──

  _createDOMOverlay() {
    this._overlay = document.createElement('div');
    this._overlay.className = 'end-overlay';

    this._fade = document.createElement('div');
    this._fade.className = 'end-fade';
    this._overlay.appendChild(this._fade);

    this._scrollContainer = document.createElement('div');
    this._scrollContainer.className = 'end-scroll-container';
    this._scrollContainer.innerHTML = CREDITS_HTML;
    this._overlay.appendChild(this._scrollContainer);

    document.body.appendChild(this._overlay);
    this._scrollY = 0;
  }

  // ── Update ──

  update(dt) {
    if (!this.active) return false;
    this._timer += dt;

    if (this._isVR) {
      return this._updateVR(dt);
    }
    return this._updateDOM(dt);
  }

  // ── DOM update (desktop / post-VR credits) ──

  _updateDOM(dt) {
    switch (this._phase) {
      case 'stopping':
        if (this._timer > 0.8) {
          this._phase = 'fading';
          this._timer = 0;
        }
        return false;

      case 'fading': {
        const progress = Math.min(this._timer / 3.0, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        this._fade.style.opacity = eased * 0.88;

        this.tintSphere.visible = true;
        this.tintSphere.material.opacity = eased * 0.88;

        if (this._timer > 3.0) {
          this._fade.style.opacity = 0.88;
          this.tintSphere.material.opacity = 0.88;
          this._phase = 'reveal';
          this._timer = 0;
        }
        return false;
      }

      case 'reveal': {
        const t = Math.min(this._timer / 2.0, 1);
        this._scrollContainer.style.opacity = t * t;
        if (this._timer > 3.0) {
          this._scrollContainer.style.opacity = 1;
          this._phase = 'scrolling';
          this._timer = 0;
          this._scrollY = 0;
        }
        return false;
      }

      case 'scrolling': {
        const scrollSpeed = 38;
        this._scrollY += scrollSpeed * dt;
        this._scrollContainer.style.transform = `translateY(-${this._scrollY}px)`;

        const contentHeight = this._scrollContainer.scrollHeight;
        const viewHeight = window.innerHeight;
        if (this._scrollY > contentHeight - viewHeight * 0.3) {
          this._phase = 'finale';
          this._timer = 0;
        }
        return false;
      }

      case 'finale': {
        const fadeOutDur = 2.0;
        const holdDur = 2.0;
        const blackDur = 3.0;

        if (this._timer < fadeOutDur) {
          const t = this._timer / fadeOutDur;
          this._scrollContainer.style.opacity = 1 - t;
        } else if (this._timer < fadeOutDur + holdDur) {
          this._scrollContainer.style.opacity = 0;
        } else if (this._timer < fadeOutDur + holdDur + blackDur) {
          const t = (this._timer - fadeOutDur - holdDur) / blackDur;
          this._fade.style.opacity = 0.88 + t * 0.12;
          this.tintSphere.material.opacity = 0.88 + t * 0.12;
        } else {
          this._phase = 'done';
          console.log('[VREndScreen] End sequence complete - reloading');
          location.reload();
          return true;
        }
        return false;
      }

      case 'done':
        return true;

      default:
        return false;
    }
  }

  // ── VR update: fade to black then exit XR → DOM credits ──

  _updateVR(dt) {
    switch (this._phase) {
      case 'stopping':
        if (this._timer > 0.8) {
          this._phase = 'vr-fading';
          this._timer = 0;
          this.tintSphere.visible = true;
        }
        return false;

      case 'vr-fading': {
        // Fade to full black in VR (not 88% — full opaque so the
        // transition to flat screen is seamless)
        const progress = Math.min(this._timer / 3.0, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        this.tintSphere.material.opacity = eased;

        if (this._timer > 3.0) {
          this.tintSphere.material.opacity = 1.0;
          this._phase = 'vr-exit';
          this._timer = 0;
        }
        return false;
      }

      case 'vr-exit': {
        // Hold black for a beat, then end the XR session
        if (this._timer > 0.5) {
          this._exitVRAndShowCredits();
          this._phase = 'vr-waiting'; // wait for session to end
        }
        return false;
      }

      case 'vr-waiting':
        // Session.end() is async — _exitVRAndShowCredits handles the
        // transition to DOM credits once it resolves.
        return false;

      case 'done':
        return true;

      default:
        // Once we've switched to DOM mode, _updateDOM handles everything
        return false;
    }
  }

  _exitVRAndShowCredits() {
    const session = this.renderer?.xr?.getSession();
    const startCredits = () => {
      // Switch to DOM path: create the overlay, start from the fade/reveal
      // phase (skip the initial fade since the screen is already black)
      this._isVR = false;
      this._createDOMOverlay();
      this._fade.style.opacity = 1.0;
      this.tintSphere.material.opacity = 1.0;
      this._phase = 'reveal';
      this._timer = 0;
      console.log('[VREndScreen] XR session ended — starting DOM credits');
    };

    if (session) {
      session.end().then(startCredits).catch(startCredits);
    } else {
      startCredits();
    }
  }

  dispose() {
    this.tintSphere.geometry.dispose();
    this.tintSphere.material.dispose();
    this.camera.remove(this.tintSphere);

    if (this._overlay && this._overlay.parentNode) {
      this._overlay.parentNode.removeChild(this._overlay);
    }
  }
}
