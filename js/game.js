(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // Visible area in world units; canvas scales to fit while keeping aspect ratio.
  const VIEW_W = 800;
  const VIEW_H = 600;
  // Explorable world: 3x the view (assumption; MDD gives no size). Turtle is clamped to its edges.
  const WORLD_W = 2400;
  const WORLD_H = 1800;
  // Island layout (MDD s3): beach/home ring around a woods interior, ocean beyond.
  // Home is on the south beach, woods to the north. Zone checks are ellipse tests.
  const ISLAND = { x: 1200, y: 900, rx: 1000, ry: 700 };
  const WOODS = { x: 1200, y: 740, rx: 680, ry: 400 };
  const HOME = { x: 1200, y: 1380 };

  const TURTLE_RADIUS = 36;
  const MAX_SPEED = 180;   // px/s
  const ACCEL = 700;       // px/s^2 toward target velocity
  const DECEL = 500;       // px/s^2 when input released
  const JOY_RADIUS = 60;   // CSS px: drag distance for full speed
  const JOY_DEADZONE = 0.12;

  const turtle = { x: HOME.x, y: HOME.y - 90, vx: 0, vy: 0, angle: 0 };

  // ---- Input -> normalized direction vector (length 0..1) ----
  const keys = new Set();
  // Turtle state: 'normal' | 'stunned' | 'sleeping' | 'shell'. Non-normal states can't move.
  // TODO: real triggers (bird hit, hunger/night, hide button); keys 1-4 are a debug switch for now.
  let state = 'normal';
  let stateTime = 0;
  const DEBUG_STATES = { 1: 'normal', 2: 'stunned', 3: 'sleeping', 4: 'shell' };
  const joy = { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0 };

  const KEY_MAP = { w: 'up', a: 'left', s: 'down', d: 'right' };
  window.addEventListener('keydown', e => {
    if (DEBUG_STATES[e.key]) { state = DEBUG_STATES[e.key]; stateTime = 0; return; }
    const k = KEY_MAP[e.key.toLowerCase()];
    if (k) { keys.add(k); e.preventDefault(); }
  });
  window.addEventListener('keyup', e => {
    const k = KEY_MAP[e.key.toLowerCase()];
    if (k) keys.delete(k);
  });
  window.addEventListener('blur', () => keys.clear());

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    if (joy.active) return;
    const t = e.changedTouches[0];
    joy.active = true; joy.id = t.identifier;
    joy.ox = joy.x = t.clientX; joy.oy = joy.y = t.clientY;
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (joy.active && t.identifier === joy.id) { joy.x = t.clientX; joy.y = t.clientY; }
    }
  }, { passive: false });
  const endTouch = e => {
    for (const t of e.changedTouches) {
      if (joy.active && t.identifier === joy.id) joy.active = false;
    }
  };
  canvas.addEventListener('touchend', endTouch);
  canvas.addEventListener('touchcancel', endTouch);

  function getDirection() {
    let dx = 0, dy = 0;
    if (keys.has('left')) dx -= 1;
    if (keys.has('right')) dx += 1;
    if (keys.has('up')) dy -= 1;
    if (keys.has('down')) dy += 1;
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      return { x: dx / len, y: dy / len };
    }
    if (joy.active) {
      const jx = joy.x - joy.ox, jy = joy.y - joy.oy;
      const len = Math.hypot(jx, jy);
      const mag = Math.min(len / JOY_RADIUS, 1);
      if (mag > JOY_DEADZONE) return { x: (jx / len) * mag, y: (jy / len) * mag };
    }
    return { x: 0, y: 0 };
  }

  // ---- Update ----
  function update(dt) {
    stateTime += dt;
    const dir = state === 'normal' ? getDirection() : { x: 0, y: 0 };
    const tvx = dir.x * MAX_SPEED, tvy = dir.y * MAX_SPEED;
    const hasInput = dir.x !== 0 || dir.y !== 0;
    const rate = (hasInput ? ACCEL : DECEL) * dt;

    // Move velocity toward target by at most `rate` (smooth accel/decel, any angle).
    const dvx = tvx - turtle.vx, dvy = tvy - turtle.vy;
    const dl = Math.hypot(dvx, dvy);
    if (dl <= rate) { turtle.vx = tvx; turtle.vy = tvy; }
    else { turtle.vx += (dvx / dl) * rate; turtle.vy += (dvy / dl) * rate; }

    // Advance walk animation by distance moved; idle holds frame 0.
    const speed = Math.hypot(turtle.vx, turtle.vy);
    if (speed > 5) walkFrame += speed * dt * FRAMES_PER_SPEED;
    else walkFrame = 0;

    turtle.x += turtle.vx * dt;
    turtle.y += turtle.vy * dt;

    const r = TURTLE_RADIUS;
    if (turtle.x < r) { turtle.x = r; turtle.vx = 0; }
    if (turtle.x > WORLD_W - r) { turtle.x = WORLD_W - r; turtle.vx = 0; }
    if (turtle.y < r) { turtle.y = r; turtle.vy = 0; }
    if (turtle.y > WORLD_H - r) { turtle.y = WORLD_H - r; turtle.vy = 0; }

    // Face movement direction, turning smoothly.
    if (Math.hypot(turtle.vx, turtle.vy) > 10) {
      const target = Math.atan2(turtle.vy, turtle.vx);
      let diff = target - turtle.angle;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      turtle.angle += diff * Math.min(1, 10 * dt);
    }
  }

  // ---- Render ----
  let scale = 1, offX = 0, offY = 0, dpr = 1;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    scale = Math.min(w / VIEW_W, h / VIEW_H);
    offX = (w - VIEW_W * scale) / 2;
    offY = (h - VIEW_H * scale) / 2;
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- World art (placeholder flat shapes, pre-rendered once to an offscreen canvas) ----
  // Simple seeded RNG so the layout is the same every load.
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const inEllipse = (e, x, y, pad = 0) =>
    ((x - e.x) / (e.rx + pad)) ** 2 + ((y - e.y) / (e.ry + pad)) ** 2 <= 1;
  const inWoods = (x, y) => inEllipse(WOODS, x, y); // TODO: used by bird/collectible zone logic

  function blob(g, e, pad, color) {
    g.beginPath(); g.ellipse(e.x, e.y, e.rx + pad, e.ry + pad, 0, 0, Math.PI * 2);
    g.fillStyle = color; g.fill();
  }

  function buildWorld() {
    const c = document.createElement('canvas');
    c.width = WORLD_W; c.height = WORLD_H;
    const g = c.getContext('2d');
    g.fillStyle = '#1c8ea6'; g.fillRect(0, 0, WORLD_W, WORLD_H);   // open ocean
    blob(g, ISLAND, 180, '#2fb3bd');                                // shallows
    blob(g, ISLAND, 90, '#7fd6d0');                                 // foam-ish shallow edge
    blob(g, ISLAND, 0, '#f2dfa7');                                  // sand
    blob(g, WOODS, 60, '#e6cf8f');                                  // dry sand fringe / tree line edge
    blob(g, WOODS, 0, '#4f8f4a');                                   // woods floor

    // Dunes on the beach: soft darker sand bumps.
    for (let i = 0, n = 0; n < 24 && i < 500; i++) {
      const x = rand() * WORLD_W, y = rand() * WORLD_H;
      if (!inEllipse(ISLAND, x, y, -60) || inEllipse(WOODS, x, y, 90)) continue;
      g.beginPath(); g.ellipse(x, y, 40 + rand() * 30, 14 + rand() * 8, 0, 0, Math.PI * 2);
      g.fillStyle = '#e8d391'; g.fill(); n++;
    }
    // Tide pools on the beach.
    for (let i = 0, n = 0; n < 6 && i < 500; i++) {
      const x = rand() * WORLD_W, y = rand() * WORLD_H;
      if (!inEllipse(ISLAND, x, y, -120) || inEllipse(WOODS, x, y, 120) || Math.hypot(x - HOME.x, y - HOME.y) < 200) continue;
      g.beginPath(); g.ellipse(x, y, 34, 22, 0, 0, Math.PI * 2);
      g.fillStyle = '#c9b57a'; g.fill();
      g.beginPath(); g.ellipse(x, y, 26, 15, 0, 0, Math.PI * 2);
      g.fillStyle = '#5ec8d0'; g.fill(); n++;
    }
    // Woods: dense round-canopy trees (drawn back to front by y).
    const trees = [];
    for (let i = 0; i < 260; i++) {
      const x = WOODS.x + (rand() * 2 - 1) * WOODS.rx, y = WOODS.y + (rand() * 2 - 1) * WOODS.ry;
      if (inEllipse(WOODS, x, y, -20)) trees.push({ x, y, r: 26 + rand() * 18 });
    }
    // A few palms on the beach.
    for (let i = 0, n = 0; n < 12 && i < 500; i++) {
      const x = rand() * WORLD_W, y = rand() * WORLD_H;
      if (!inEllipse(ISLAND, x, y, -80) || inEllipse(WOODS, x, y, 70) || Math.hypot(x - HOME.x, y - HOME.y) < 160) continue;
      trees.push({ x, y, r: 22, palm: true }); n++;
    }
    trees.sort((a, b) => a.y - b.y);
    for (const t of trees) {
      g.fillStyle = 'rgba(0,0,0,0.15)';
      g.beginPath(); g.ellipse(t.x + 6, t.y + t.r * 0.6, t.r, t.r * 0.6, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = t.palm ? '#7a5a34' : '#2f6b34';
      g.beginPath(); g.arc(t.x, t.y, t.palm ? 5 : t.r, 0, Math.PI * 2); g.fill();
      if (t.palm) {
        g.fillStyle = '#3f9a45';
        for (let a = 0; a < 6; a++) {
          g.beginPath();
          g.ellipse(t.x + Math.cos(a * 1.05) * 16, t.y + Math.sin(a * 1.05) * 16, 18, 6, a * 1.05, 0, Math.PI * 2);
          g.fill();
        }
      } else {
        g.fillStyle = '#3f8a42';
        g.beginPath(); g.arc(t.x - t.r * 0.2, t.y - t.r * 0.2, t.r * 0.65, 0, Math.PI * 2); g.fill();
      }
    }
    // Home: rock pile (fixed landmark; level art comes with upgrades).
    for (const [dx, dy, r] of [[-34, 6, 26], [8, 14, 30], [40, 0, 22], [-8, -22, 24], [22, -20, 18]]) {
      g.fillStyle = '#7d7d82'; g.beginPath(); g.arc(HOME.x + dx, HOME.y + dy, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#9a9aa0'; g.beginPath(); g.arc(HOME.x + dx - 4, HOME.y + dy - 5, r * 0.6, 0, Math.PI * 2); g.fill();
    }
    return c;
  }
  const worldArt = buildWorld();

  // Camera: centers on the turtle, clamped so the view never shows past the world edge.
  let camX = 0, camY = 0;
  function updateCamera() {
    camX = Math.max(0, Math.min(WORLD_W - VIEW_W, turtle.x - VIEW_W / 2));
    camY = Math.max(0, Math.min(WORLD_H - VIEW_H, turtle.y - VIEW_H / 2));
  }

  // Walk cycle = first 4 cells of row 0 in the sheet (8 cols x 5 rows); sprite faces up.
  // Other rows: 2 asleep+zzz (cols 0-3), 3 stun (cols 2-3 blink the dizzy dashes), 4 closed shell (col 0).
  const sprite = new Image();
  sprite.src = 'assets/turtle-sheet.png';
  const FRAMES = 4;
  const SHEET_COLS = 8, SHEET_ROWS = 5;
  const SPRITE_H = 100;          // drawn height in world px
  const FRAMES_PER_SPEED = 0.03; // frames per px traveled (~5 fps at full speed)
  let walkFrame = 0;

  function drawTurtle() {
    if (!sprite.complete || !sprite.naturalWidth) return;
    const fw = sprite.naturalWidth / SHEET_COLS, fh = sprite.naturalHeight / SHEET_ROWS;
    const dw = SPRITE_H * fw / fh;
    let row = 0, f = Math.floor(walkFrame) % FRAMES;
    if (state === 'sleeping') { row = 2; f = Math.floor(stateTime * 2) % FRAMES; }
    else if (state === 'stunned') { row = 3; f = 2 + Math.floor(stateTime * 4) % 2; }
    else if (state === 'shell') { row = 4; f = 0; }
    ctx.save();
    ctx.translate(turtle.x, turtle.y);
    ctx.rotate(turtle.angle + Math.PI / 2); // art faces up, angle 0 = right
    if (state === 'normal' && f === 3) ctx.scale(-1, 1); // mirror the last frame so the head swings left (sheet only has right)
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sprite, f * fw, row * fh, fw, fh, -dw / 2, -SPRITE_H / 2, dw, SPRITE_H);
    ctx.restore();
  }

  function drawJoystick() {
    if (!joy.active) return;
    const dx = joy.x - joy.ox, dy = joy.y - joy.oy;
    const len = Math.hypot(dx, dy) || 1;
    const c = Math.min(len, JOY_RADIUS);
    const kx = joy.ox + (dx / len) * c, ky = joy.oy + (dy / len) * c;
    ctx.beginPath(); ctx.arc(joy.ox, joy.oy, JOY_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); ctx.arc(kx, ky, 26, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fill();
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b3d4f';
    ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    ctx.save();
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);
    ctx.beginPath(); ctx.rect(0, 0, VIEW_W, VIEW_H); ctx.clip();
    updateCamera();
    ctx.translate(-camX, -camY);
    ctx.drawImage(worldArt, 0, 0);
    drawTurtle();
    ctx.restore();

    drawJoystick(); // screen space
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
