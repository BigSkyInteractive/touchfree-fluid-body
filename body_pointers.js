/*
Body-driven fluid pointers.

Paints the fluid simulation from the TouchFree body tracker instead of (well,
in addition to) the mouse: both wrists and both shoulders each act as their
own cursor, so the whole upper body stirs the fluid.

Design notes:
  - This file does NOT modify script.js. The upstream simulation declares
    splat() and generateColor() as top-level function declarations, which
    makes them global, so a body pointer is just "call splat with a texcoord
    and a velocity". Keeping upstream untouched is deliberate — splicing into
    it is what broke this page twice on 2026-08-03. (script.js now carries
    deletions of upstream's promo material, nothing more.)
  - ALL tuning lives in fluid_config.json: the landmark list, the particle
    behaviour, and the simulation dials. The page refuses to run without it.
  - Splats are QUEUED here and drained inside a requestAnimationFrame tick,
    so every GL call happens in the render frame rather than in a WebSocket
    callback.
  - body_state arrives at body cadence (~15 Hz) while the sim renders at ~60.
    Positions are interpolated toward the newest sample each frame, so a
    fast-moving wrist paints a smooth stroke rather than 15 discrete blobs.

Data contract (see docs/v5/V5_UI_PROTOCOL.md):
  body_state.payload.keypoints = [[x_px, y_px, z_rel, visibility] x 17]
  COCO-17 indices, MIRRORED pixel space, sized by payload.frame_w/frame_h.
  Empty list when no primary body is selected.
*/
'use strict';

(function () {
  // All 17 COCO landmarks, each its own pointer.
  //
  // hue: grouped by body region so limbs read as colour families rather than
  //      17 unrelated colours — head warm, arms cool, hips magenta, legs green.
  // force: scaled by how much that part actually MOVES. A landmark that drifts
  //      slowly but continuously (hips, shoulders, head) pumps dye the entire
  //      time somebody stands there, so it gets a low multiplier; extremities
  //      that whip around get the full amount. The five head points sit within
  //      a few pixels of each other, so they are damped hardest — at full
  //      force they merge into one blown-out white blob on the face.
  //
  // Cost note: every moving pointer is one splat = 2 GL passes per frame. All
  // 17 moving at once is ~34 extra passes on a 4-CU GPU. If the frame rate
  // drops, thin this list rather than lowering the simulation quality —
  // see docs/v5/V5_GPU_GRAPHICS.md.
  // Nine landmarks (Tim, 2026-08-03): eyes + nose, shoulders, wrists, hips.
  // Ears, elbows, knees and ankles deliberately excluded — ears add nothing
  // the eyes do not, and the leg chain is usually out of frame at kiosk
  // distance anyway.
  // force = how hard this landmark pushes the VELOCITY field (the flow)
  // dye   = how much COLOUR it deposits (the brightness)
  // These are deliberately SEPARATE. They were one value until 2026-08-03,
  // which meant turning up the flow also turned up the brightness, and nine
  // landmarks depositing continuously saturated every channel to white.
  // Flow can be strong while the dye stays faint.
  // EVERY TUNING VALUE LIVES IN fluid_config.json — which landmarks paint
  // (with the reasoning per group), the particle behaviour, and the
  // simulation dials. This file holds only the mechanics. The page REFUSES
  // to run without the config: a silent built-in default is how a page and
  // its published settings drift apart. The measured history behind the
  // shipped numbers (the 9000-was-a-fire-hose story, the GL cost budget) is
  // recorded in the config's *_doc fields and docs/V5/V5_GPU_GRAPHICS.md.
  var TRACKED = null;         // [{idx, name, hue, force, dye}], from config
  var DYE_BRIGHTNESS, MIN_VISIBILITY, SPLAT_VELOCITY, SUB_SPLATS, JITTER;
  var EMIT_MODE, RING_COUNT, RING_RADIUS, RING_OUTWARD, RING_SPIN;
  var MAX_STEP, SMOOTHING, IDLE_MS;

  // Every landmark on the wire, in edge/body_detector.LANDMARK_NAMES order:
  // COCO-17 first (frozen), then MediaPipe's remaining 16. The settings
  // panel offers ALL of them; fluid_config.json decides which start on.
  var LANDMARK_NAMES = [
    'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
    'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
    'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
    'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
    'left_eye_inner', 'left_eye_outer', 'right_eye_inner', 'right_eye_outer',
    'mouth_left', 'mouth_right', 'left_pinky', 'right_pinky',
    'left_index', 'right_index', 'left_thumb', 'right_thumb',
    'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index',
  ];
  var lmParams = null;        // idx -> {hue, force, dye} from the config
  var enabled = null;         // name -> bool; the panel's checkboxes toggle this
  var loadedDocs = {};        // the config's about/_doc prose, kept across a save

  // The active pointer list, rebuilt whenever a checkbox changes. A landmark
  // the config never described paints with neutral bench defaults (hue
  // spread by index, moderate force, faint dye) until the JSON gives it
  // real values. Cost note: every enabled landmark that moves costs
  // sub_splats x 2 GL passes per frame -- all 33 on at once is a bench
  // experiment, not a show setting.
  function rebuildTracked() {
    var lm = [];
    for (var i = 0; i < LANDMARK_NAMES.length; i++) {
      if (!enabled[LANDMARK_NAMES[i]]) {
        delete state[i];    // a disabled pointer stops painting NOW
        continue;
      }
      var p = lmParams[i] || { hue: i / LANDMARK_NAMES.length,
                               force: 0.8, dye: 0.2 };
      lm.push({ idx: i, name: LANDMARK_NAMES[i],
                hue: p.hue, force: p.force, dye: p.dye });
    }
    TRACKED = lm;
  }

  var lmFolderBuilt = false;
  function buildLandmarkFolder(gui) {
    if (lmFolderBuilt) return;
    lmFolderBuilt = true;
    var folder = gui.addFolder('Body landmarks');
    for (var i = 0; i < LANDMARK_NAMES.length; i++) {
      folder.add(enabled, LANDMARK_NAMES[i]).onChange(rebuildTracked);
    }
  }

  // SAVING SETTINGS. The panel edits live values; this turns them back into
  // fluid_config.json content, so a tuning session survives a reload and the
  // file stays the single source of truth — nothing hides in browser
  // storage. Two paths: Save posts to the TouchFree server, which rewrites
  // the page's own fluid_config.json; Copy puts the same JSON on the
  // clipboard for a static host with no server behind it.
  var SAVED_SIM_KEYS = [
    'DYE_RESOLUTION', 'SIM_RESOLUTION', 'GRAVITY', 'CURL', 'SPLAT_RADIUS',
    'SPLAT_FORCE', 'PRESSURE', 'DENSITY_DISSIPATION', 'VELOCITY_DISSIPATION',
    'SHADING', 'COLORFUL', 'BLOOM', 'BLOOM_INTENSITY', 'BLOOM_THRESHOLD',
    'SUNRAYS', 'SUNRAYS_WEIGHT', 'BACK_COLOR', 'TRANSPARENT',
  ];

  function r3(v) { return Math.round(v * 1000) / 1000; }

  function currentConfig() {
    var out = {};
    if (loadedDocs.about) out.about = loadedDocs.about;
    if (loadedDocs.landmarks_doc) out.landmarks_doc = loadedDocs.landmarks_doc;
    out.landmarks = TRACKED.map(function (t) {
      return { index: t.idx, name: t.name,
               hue: r3(t.hue), force: r3(t.force), dye: r3(t.dye) };
    });
    if (loadedDocs.particles_doc) out.particles_doc = loadedDocs.particles_doc;
    out.particles = {
      splat_velocity: SPLAT_VELOCITY, sub_splats: SUB_SPLATS, jitter: JITTER,
      dye_brightness: DYE_BRIGHTNESS, emit_mode: EMIT_MODE,
      ring_count: RING_COUNT, ring_radius: RING_RADIUS,
      ring_outward: RING_OUTWARD, ring_spin: RING_SPIN,
      max_step: MAX_STEP, smoothing: SMOOTHING, idle_ms: IDLE_MS,
      min_visibility: MIN_VISIBILITY,
    };
    if (loadedDocs.simulation_doc) out.simulation_doc = loadedDocs.simulation_doc;
    var live = window.TF_FLUID_CONFIG;
    out.simulation = {};
    for (var i = 0; i < SAVED_SIM_KEYS.length; i++) {
      var k = SAVED_SIM_KEYS[i];
      out.simulation[k] = typeof live[k] === 'number' ? r3(live[k]) : live[k];
    }
    return out;
  }

  // The page's own folder name under /user/Content/, from its URL. A static
  // host (the public repo served raw) has no such path — then only Copy works.
  function contentPageName() {
    var m = location.pathname.match(/\/user\/Content\/([^/]+)\//);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function note(msg) {
    var teaser = document.getElementById('guiTeaser');
    if (!teaser) return;
    teaser.textContent = msg;
    teaser.style.opacity = '1';
    setTimeout(function () { teaser.style.opacity = '0'; }, 5000);
  }

  function saveConfig() {
    var page = contentPageName();
    if (!page) {
      note('No TouchFree server here — use "copy settings" and paste into fluid_config.json');
      return;
    }
    fetch('/api/kiosk/content-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: page, file: 'fluid_config.json',
                             config: currentConfig() }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        note(d.ok ? 'Saved — these settings now load with the page'
                  : 'Save failed: ' + (d.error || 'unknown'));
      })
      .catch(function (e) { note('Save failed: ' + e); });
  }

  function copyConfig() {
    var text = JSON.stringify(currentConfig(), null, 2) + '\n';
    navigator.clipboard.writeText(text)
      .then(function () { note('Settings copied — paste into fluid_config.json'); })
      .catch(function (e) { note('Copy failed: ' + e); });
  }

  var settingsRowsBuilt = false;
  function buildSettingsRows(gui) {
    if (settingsRowsBuilt) return;
    settingsRowsBuilt = true;
    gui.add({ fun: saveConfig }, 'fun').name('save settings');
    gui.add({ fun: copyConfig }, 'fun').name('copy settings');
  }

  function fail(msg) {
    console.error('[fluid_config] ' + msg);
    if (hint) {
      hint.textContent = 'fluid_config.json problem: ' + msg;
      hint.style.opacity = '1';
    }
  }

  function applyConfig(cfg) {
    if (!cfg || !Array.isArray(cfg.landmarks) || !cfg.landmarks.length) {
      fail('landmarks list missing or empty');
      return false;
    }
    lmParams = {};
    enabled = {};
    for (var n = 0; n < LANDMARK_NAMES.length; n++) enabled[LANDMARK_NAMES[n]] = false;
    for (var i = 0; i < cfg.landmarks.length; i++) {
      var e = cfg.landmarks[i];
      if (typeof e.index !== 'number' || typeof e.hue !== 'number'
          || typeof e.force !== 'number' || typeof e.dye !== 'number') {
        fail('landmark ' + i + ' needs numeric index/hue/force/dye');
        return false;
      }
      if (e.index < 0 || e.index >= LANDMARK_NAMES.length) {
        fail('landmark ' + i + ' index ' + e.index + ' is not on the wire');
        return false;
      }
      lmParams[e.index] = { hue: e.hue, force: e.force, dye: e.dye };
      enabled[LANDMARK_NAMES[e.index]] = true;
    }
    var p = cfg.particles;
    var need = ['splat_velocity', 'sub_splats', 'jitter', 'dye_brightness',
                'emit_mode', 'ring_count', 'ring_radius', 'ring_outward',
                'ring_spin', 'max_step', 'smoothing', 'idle_ms',
                'min_visibility'];
    if (!p) { fail('particles section missing'); return false; }
    for (var k = 0; k < need.length; k++) {
      if (!(need[k] in p)) { fail('particles.' + need[k] + ' missing'); return false; }
    }
    SPLAT_VELOCITY = p.splat_velocity;
    SUB_SPLATS = Math.max(1, p.sub_splats | 0);
    JITTER = p.jitter;
    DYE_BRIGHTNESS = p.dye_brightness;
    EMIT_MODE = p.emit_mode === 'ring' ? 'ring' : 'trail';
    RING_COUNT = Math.max(2, p.ring_count | 0);
    RING_RADIUS = p.ring_radius;
    RING_OUTWARD = p.ring_outward;
    RING_SPIN = p.ring_spin;
    MAX_STEP = p.max_step;
    SMOOTHING = p.smoothing;
    IDLE_MS = p.idle_ms;
    MIN_VISIBILITY = p.min_visibility;

    // Simulation dials, applied onto the sim's live config. Only keys the
    // sim actually has are accepted — a typo fails loudly instead of
    // silently tuning nothing.
    var sim = cfg.simulation || {};
    var live = window.TF_FLUID_CONFIG;
    for (var key in sim) {
      if (!live || !(key in live)) {
        fail('simulation.' + key + ' is not a live simulation setting');
        return false;
      }
      live[key] = sim[key];
    }
    // A saved config can carry keys the sim bakes at startup: the shader
    // keyword set (SHADING/BLOOM/SUNRAYS) and the two resolutions. Rebuild
    // both now so those keys actually take effect — without this a saved
    // resolution would sit in the config doing nothing, silently.
    window.updateKeywords();
    if ('DYE_RESOLUTION' in sim || 'SIM_RESOLUTION' in sim) {
      window.initFramebuffers();
    }

    // Keep the file's prose (about/_doc fields) so a save from the panel
    // rewrites the numbers without erasing the documentation.
    loadedDocs = {};
    for (var dk in cfg) {
      if (dk === 'about' || /_doc$/.test(dk)) loadedDocs[dk] = cfg[dk];
    }

    rebuildTracked();   // arms the tick loop, from the enabled set

    // The settings panel reads its values at creation, before this config
    // was applied — refresh every slider so G shows the truth, not the
    // pre-config numbers. And give the panel its Body landmarks folder,
    // one checkbox per wire landmark.
    var gui = window.TF_FLUID_GUI;
    if (gui) {
      var refresh = function (g) {
        (g.__controllers || []).forEach(function (c) { c.updateDisplay(); });
        Object.keys(g.__folders || {}).forEach(function (k) {
          refresh(g.__folders[k]);
        });
      };
      refresh(gui);
      buildLandmarkFolder(gui);
      buildSettingsRows(gui);
      gui.onResize();   // the rows above changed the panel's height
    }
    return true;
  }

  // THE SETTINGS PANEL SHORTCUT. G toggles the simulation's dat.GUI panel,
  // hidden by default on the kiosk (index.html CSS). The teaser in the
  // corner names the key, then gets out of the way.
  function initGuiToggle() {
    var teaser = document.getElementById('guiTeaser');
    window.addEventListener('keydown', function (e) {
      if (e.key === 'g' || e.key === 'G') {
        var on = document.body.classList.toggle('tf-gui');
        // dat.gui sized itself while the panel was display:none (all
        // offsets zero), so its scroll height is wrong until it measures
        // the panel actually on screen — the last rows clip without this.
        if (on && window.TF_FLUID_GUI) window.TF_FLUID_GUI.onResize();
        if (teaser) teaser.style.opacity = on ? '0' : '1';
        if (!on && teaser) {
          setTimeout(function () { teaser.style.opacity = '0'; }, 4000);
        }
      }
    });
    if (teaser) {
      setTimeout(function () { teaser.style.opacity = '0'; }, 8000);
    }
  }

  var state = {};             // idx -> {tx, ty, targetX, targetY, primed}
  var lastBodyMs = 0;
  var haveBody = false;
  var hint = null;

  function ready() {
    return typeof window.splat === 'function'
        && typeof window.generateColor === 'function';
  }

  // Fixed hue per landmark so each limb keeps its own colour, rather than
  // upstream's random-per-stroke colour. 0.15 is upstream's own dye scale;
  // the landmark's `dye` and the master DYE_BRIGHTNESS scale it down from
  // there. Dye ACCUMULATES where a landmark lingers, so a value that looks
  // reasonable for one splat still clips to white after a few seconds —
  // these are deliberately well under upstream.
  function colorFor(hue, dye) {
    var c = window.HSVtoRGB(hue, 1.0, 1.0);
    var k = 0.15 * dye * DYE_BRIGHTNESS;
    c.r *= k;
    c.g *= k;
    c.b *= k;
    return c;
  }

  function onBodyState(payload) {
    if (!payload) return;
    var kps = payload.keypoints || [];
    var fw = payload.frame_w || 0;
    var fh = payload.frame_h || 0;
    if (!kps.length || !fw || !fh) {
      haveBody = false;
      return;
    }
    haveBody = true;
    lastBodyMs = performance.now();

    for (var i = 0; i < TRACKED.length; i++) {
      var t = TRACKED[i];
      var kp = kps[t.idx];
      // A landmark arrives as NULL when the server's quality filter refuses to
      // send that coordinate; the index is kept so the numbering still holds.
      // Absent and unreliable get the SAME handling, deliberately — drop the
      // pointer, so it does not keep painting at a stale position and then draw
      // a straight line across the screen when the landmark reappears
      // elsewhere. A bare `continue` here would leave the pointer alive, which
      // is the one thing this branch exists to prevent.
      if (!kp || kp[3] < MIN_VISIBILITY) {
        delete state[t.idx];
        continue;
      }
      // Mirrored pixel space -> fluid texcoords. Fluid's y origin is bottom.
      var tx = kp[0] / fw;
      var ty = 1.0 - (kp[1] / fh);
      var s = state[t.idx];
      if (!s) {
        state[t.idx] = { tx: tx, ty: ty, targetX: tx, targetY: ty, primed: false };
        continue;
      }
      if (Math.abs(tx - s.targetX) > MAX_STEP || Math.abs(ty - s.targetY) > MAX_STEP) {
        // Teleport (tracker jumped to a different person or re-acquired):
        // reseat rather than painting the jump.
        s.tx = tx; s.ty = ty; s.primed = false;
      }
      s.targetX = tx;
      s.targetY = ty;
      s.primed = true;
    }
  }

  function tick() {
    requestAnimationFrame(tick);
    if (!TRACKED || !ready()) return;

    if (haveBody && performance.now() - lastBodyMs > IDLE_MS) {
      haveBody = false;
      state = {};
    }
    updateHint();

    // Screen aspect, used to keep ring emission circular rather than an
    // ellipse (texcoords are 0..1 on both axes, but the screen is wider).
    var cv = document.getElementsByTagName('canvas')[0];
    var aspect = (cv && cv.height) ? (cv.width / cv.height) : 1.0;

    for (var i = 0; i < TRACKED.length; i++) {
      var t = TRACKED[i];
      var s = state[t.idx];
      if (!s || !s.primed) continue;
      // Keep the pre-move position: the particle trail is laid along the
      // segment FROM it TO the new one.
      var prevX = s.tx;
      var prevY = s.ty;
      var nx = prevX + (s.targetX - prevX) * SMOOTHING;
      var ny = prevY + (s.targetY - prevY) * SMOOTHING;
      var dx = nx - prevX;
      var dy = ny - prevY;
      s.tx = nx;
      s.ty = ny;
      // Only paint when actually moving — a still limb should not pump dye.
      if (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5) continue;

      // Dye is divided between the particles either way, so more particles
      // never means a brighter scene — only a finer one.
      var vx = dx * SPLAT_VELOCITY * t.force;
      var vy = dy * SPLAT_VELOCITY * t.force;

      if (EMIT_MODE === 'ring') {
        var n = RING_COUNT;
        var cr = colorFor(t.hue, t.dye / n);
        // Rotate each frame's ring so successive puffs do not stack into
        // fixed spokes.
        var phase = Math.random() * Math.PI * 2.0;
        for (var r = 0; r < n; r++) {
          var a = phase + (r / n) * Math.PI * 2.0;
          var ca = Math.cos(a);
          var sa = Math.sin(a);
          // x offset is divided by the aspect ratio so the ring is circular
          // on screen rather than stretched wide.
          window.splat(
            nx + ca * RING_RADIUS / aspect,
            ny + sa * RING_RADIUS,
            vx + ca * RING_OUTWARD * t.force + (-sa) * RING_SPIN * t.force,
            vy + sa * RING_OUTWARD * t.force + (ca) * RING_SPIN * t.force,
            cr);
        }
      } else {
        var c = colorFor(t.hue, t.dye / SUB_SPLATS);
        for (var k = 0; k < SUB_SPLATS; k++) {
          // Position along the segment travelled this frame (0..1), so a fast
          // limb lays a trail instead of jumping.
          var f = (k + 1) / SUB_SPLATS;
          var px = prevX + dx * f + (Math.random() - 0.5) * JITTER;
          var py = prevY + dy * f + (Math.random() - 0.5) * JITTER;
          window.splat(px, py, vx, vy, c);
        }
      }
    }
  }

  function updateHint() {
    if (!hint) return;
    hint.style.opacity = haveBody ? '0' : '1';
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'body_state') onBodyState(msg.payload);
    };
    ws.onclose = function () { setTimeout(connect, 2000); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  // Tell the operator when the data this page needs is switched off, rather
  // than showing a black screen that looks broken.
  function checkControls() {
    fetch('/api/kiosk/status')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var c = d.config || {};
        if (c.body_landmarks_enabled === false && hint) {
          hint.textContent = 'Body landmarks are turned off in Kiosk Manager → Control';
          hint.style.opacity = '1';
        }
      })
      .catch(function (e) { console.error('[body] status read failed:', e); });
  }

  // Bench tuning without a redeploy. Every value is optional; anything not
  // given keeps the file's default.
  //   ?gravity=-8      fall like pouring water (negative = down)
  //   ?gravity=12      rise faster like smoke  (positive = up)
  //   ?gravity=0       upstream behaviour, no vertical force
  //   ?vel=1500&sub=2&curl=40&fade=0.7&radius=0.05
  function applyUrlOverrides() {
    var q = new URLSearchParams(location.search);
    var cfg = window.TF_FLUID_CONFIG;
    if (q.has('vel')) SPLAT_VELOCITY = parseFloat(q.get('vel'));
    if (q.has('sub')) SUB_SPLATS = Math.max(1, parseInt(q.get('sub'), 10));
    if (q.has('dye')) DYE_BRIGHTNESS = parseFloat(q.get('dye'));
    if (q.has('emit')) EMIT_MODE = (q.get('emit') === 'ring') ? 'ring' : 'trail';
    if (q.has('ringn')) RING_COUNT = Math.max(2, parseInt(q.get('ringn'), 10));
    if (q.has('ringr')) RING_RADIUS = parseFloat(q.get('ringr'));
    if (q.has('ringout')) RING_OUTWARD = parseFloat(q.get('ringout'));
    if (q.has('ringspin')) RING_SPIN = parseFloat(q.get('ringspin'));
    if (!cfg) return;
    if (q.has('gravity')) cfg.GRAVITY = parseFloat(q.get('gravity'));
    if (q.has('curl')) cfg.CURL = parseFloat(q.get('curl'));
    if (q.has('radius')) cfg.SPLAT_RADIUS = parseFloat(q.get('radius'));
    if (q.has('fade')) cfg.DENSITY_DISSIPATION = parseFloat(q.get('fade'));
    if (q.has('drift')) cfg.VELOCITY_DISSIPATION = parseFloat(q.get('drift'));
  }

  window.addEventListener('DOMContentLoaded', function () {
    hint = document.getElementById('bodyHint');
    initGuiToggle();
    // Config first, strictly: nothing paints until fluid_config.json loads
    // and validates. URL parameters apply AFTER, so ?vel= bench overrides
    // win over the file.
    fetch('./fluid_config.json')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (cfg) {
        if (!applyConfig(cfg)) return;
        applyUrlOverrides();
        checkControls();
        connect();
      })
      .catch(function (e) { fail(String(e)); });
    requestAnimationFrame(tick);
  });
})();
