(() => {
  'use strict';

  // ?test=1: deterministic mode for before/after screenshot comparison (see the TEST block at the
  // bottom). Seeds Math.random here, before any world generation or pickup placement uses it.
  const TEST = new URLSearchParams(location.search).get('test') === '1';
  if (TEST) {
    let s = 0x1234abcd;
    Math.random = () => { // mulberry32
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const DEBUG = new URLSearchParams(location.search).get('debug') === '1'; // perf overlay, hitbox/zone outlines, debug keys

  const canvas = document.getElementById('game');
  // Test mode forces software raster: Chrome otherwise flips a canvas from GPU to CPU mid-run after
  // repeated readbacks, which shifts a few pixels between otherwise identical renders.
  const ctx = canvas.getContext('2d', TEST ? { willReadFrequently: true } : undefined);

  // The canvas fills the window; 1 world unit = 1 CSS px, so the viewport (viewW x viewH,
  // set in resize()) just shows more world on a wide screen and more on a tall one — no letterboxing.

  // ---- World layout (MDD s3, revised 2026-09-28) ----
  // A small home island at the world center, a water ring around it, and a mainland ring beyond
  // that wraps all the way around, split into 4 compass biomes (N beach, E open forest, S dead
  // trees, W thick forest). World is square so all 4 directions have equal room to explore.
  // The original map is the "home zone": WORLD_SIZE square with its original coordinates and layout. The
  // Adventure Zone is all the new land around it, so the world runs from WORLD_MIN to WORLD_MAX on both axes
  // (negative coordinates are fine: nothing below indexes arrays by world position).
  const WORLD_SIZE = 5200;
  const ADVENTURE = {
    worldMult: 2,            // world side = this x the original map's side (2 = 4x the area); the one knob for world size
    fenceInset: 110,         // locked: about this many world px in from the home zone's edge the fence stands and the turtle stops (nudged so whole fence tiles fit)
    fenceTile: 64,           // world px per fence art tile (the art is 64px)
    bumpHintSeconds: 12,     // locked: at most one "fenced off" hint this often when the turtle pushes against the fence
    enterHintSeconds: 20,    // at most one "Entering the Adventure Zone" toast this often
    fogBand: 300,            // locked: world px of fog thickening toward the edge (the baked edge fog hides under the grass)
    fogAlpha: 0.85,          // fog opacity at the very edge
    seed: 7351,              // seeds the zone's scenery, so it's the same every load
    enemies: {               // the zone's own enemy pool; the home zone's enemies (enemies.js CONFIG) are untouched
      countPerType: 16,      // per type (crab/bear/snake/seagull) vs 3 in the home zone; only those near the turtle are simulated
      maxTotal: 64,          // hard cap on live zone enemies
      speedMult: 1.10,
      detectMult: 1.15,      // detection (and the crab's ambush) radius
      cooldownMult: 0.9,     // attack cooldown; damage is unchanged
      maxSpeedFrac: 0.95,    // clamp: a type slower than the player can never get past this fraction of the player's speed (snake is exempt)
    },
    coins: {                 // zone coin pickups: a small pool kept topped up around the turtle (home coins are untouched)
      densityMult: 2,        // x the home zone's coin density (home coins per land area)
      maxActive: 120,        // pool size = hard cap on live zone coins
      ringWidth: 900,        // coins are kept within this many px beyond the screen edge, new ones appear just off-screen
      tickSeconds: 0.25,     // how often the pool is topped up / trimmed (collection is still checked every frame)
      spawnsPerTick: 3,      // new coins per top-up (the first fill on entering the zone is done in one go)
      edgeMargin: 150,       // keep this far from the outer world edge
    },
    chest: {                 // the zone's treasure chest: one at a time, a pickup like a coin (walk over it)
      value: 50,             // coins added to the carried stash (hull limit ignored; must be carried home and banked)
      firstSpawnSeconds: 10, // first chest this long (game time) after the zone is first open
      respawnSeconds: 60,    // game time (paused while inside the hut) from pickup to the next chest; saved with the slot
      minPlayerScreens: 1.2, // a new chest appears at least this many screens (of the larger side) from the turtle
      denPad: 80,            // ...and at least this far outside any live enemy's den (wander/leash area)
      pickupRadius: 34,      // + the turtle's body radius
      drawSize: 72,          // world px
      spawnRetrySeconds: 0.5,// wait between failed spawn searches
      saveEverySeconds: 5,   // how often the respawn countdown is written to the save while it runs
      confettiCount: 70, confettiSeconds: 1.8,
    },
    music: {
      files: ['assets/sfx/adventure1.mp3', 'assets/sfx/adventure2.mp3', 'assets/sfx/adventure3.mp3'], // cycled like the normal music; drop-in: a missing file just keeps the normal music
      fadeSeconds: 2,        // crossfade length between the normal and adventure music
      hysteresis: 150,       // world px past the border before the music switches to adventure, and back inside it before switching back
    },
  };
  // The locked fence is a closed rectangle of whole tiles centered on the home zone: FENCE_N tiles per side, posts on the
  // line FENCE_A px in from each edge (this is also how far the turtle can go while the zone is locked).
  const FENCE_N = Math.round((WORLD_SIZE - 2 * ADVENTURE.fenceInset) / ADVENTURE.fenceTile);
  const FENCE_A = (WORLD_SIZE - FENCE_N * ADVENTURE.fenceTile) / 2;
  const WORLD_PAD = WORLD_SIZE * (ADVENTURE.worldMult - 1) / 2; // new land on each side of the home zone
  const WORLD_MIN = -WORLD_PAD, WORLD_MAX = WORLD_SIZE + WORLD_PAD;
  const CENTER = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
  const ISLAND_R = 260;                             // home island radius: safe area, no obstacles
  const WATER_WIDTH = 300;                          // water ring width beyond the island
  const WATER_OUTER_R = ISLAND_R + WATER_WIDTH;     // mainland starts here
  const EDGE_FOG_WIDTH = 260;                       // darkened fringe at the world border
  // Zone test: one rectangle check against the home square (everything else is the Adventure Zone).
  function inHomeZone(x, y) { return x >= 0 && x < WORLD_SIZE && y >= 0 && y < WORLD_SIZE; }
  // Playable/camera rectangle: just the home zone while the Adventure Zone is locked, the whole world once open.
  // The fog fringe hugs whichever edge is current.
  const bounds = { x0: 0, y0: 0, x1: WORLD_SIZE, y1: WORLD_SIZE };
  let adventureUnlocked = false;
  let inAdventure = false; // the turtle is out in the zone (with hysteresis, see updateZoneFlag)
  const HOME = { x: CENTER.x, y: CENTER.y + 90 };

  // Camera zoom: smaller = more of the map visible. Zoomed out further on narrow/mobile
  // viewports so the phone screen shows a comparable amount of world to desktop.
  let ZOOM = 0.85;
  function updateZoomForViewport() {
    ZOOM = window.innerWidth <= 768 ? 0.6 : 0.85;
  }
  updateZoomForViewport();

  // "TURTLE TIDES / by Wesley Kopp" written in the sand, south outer ring (see drawSandText()
  // below). Defined here, ahead of the shore/grass/scenery generation below, so those can widen the
  // sand patch under the text and keep trees from spawning over it.
  const SAND_TEXT_POS = { x: CENTER.x, y: CENTER.y + WATER_OUTER_R + 50 }; // south, just past the wet band
  const SAND_SUBTEXT_POS = { x: SAND_TEXT_POS.x, y: SAND_TEXT_POS.y + 56 };
  // Generous rectangle around both lines, padded well past the rendered text so the sand clearly
  // extends beyond the letters on all sides rather than just grazing them.
  const SAND_TEXT_ZONE = { x0: CENTER.x - 420, x1: CENTER.x + 420, y0: SAND_TEXT_POS.y - 130, y1: SAND_SUBTEXT_POS.y + 110 };
  const SAND_TEXT_FRINGE = 110; // world px over which the zone's edge fades/wobbles into grass
  // Distance outside the rectangle (0 = inside or on the edge), fed into a noisy fade below so the
  // sand-to-grass transition wanders like a real coastline instead of tracing a straight box.
  function sandTextBoxDist(x, y) {
    const dx = Math.max(SAND_TEXT_ZONE.x0 - x, 0, x - SAND_TEXT_ZONE.x1);
    const dy = Math.max(SAND_TEXT_ZONE.y0 - y, 0, y - SAND_TEXT_ZONE.y1);
    return Math.hypot(dx, dy);
  }
  // 1 = solid sand, 0 = plain grass, with a wobbly noisy fringe in between (uses noise2/smoothstep,
  // both function declarations defined further down but hoisted, so calling them here is safe).
  function sandTextFade(x, y) {
    const wobble = (noise2(x / 90 + 300, y / 90 + 300) - 0.5) * 2 * SAND_TEXT_FRINGE * 0.6;
    return 1 - smoothstep(0, SAND_TEXT_FRINGE, sandTextBoxDist(x, y) + wobble);
  }
  function inSandTextZone(x, y) { return sandTextFade(x, y) > 0.5; }

  // ---- Shoreline rendering (visual only — gameplay still uses the perfect-circle ISLAND_R /
  // WATER_OUTER_R above for collision, speed and biome logic; none of that changes here). ----
  const SHORE_DEEP_COLOR = [20, 90, 160];    // open water fallback color, hidden under Shore.js's water tile
  const SHORE_DRY_SAND_COLOR = [235, 215, 160]; // sand further inland (the island's ground color)
  const SHORE_WET_BAND = 70;    // world px of land past the shoreline that reads as wet sand
  const SHORE_DRY_BAND = 150;   // world px past the wet band that fades wet sand into dry sand/biome
  const SHORE_NOISE_AMPLITUDE = 40; // +/- world px the shoreline wanders from its base radius
  // Two independent angle-noise samples (different frequency + offset into the same seeded noise
  // field) so the island and mainland coastlines wobble differently rather than looking identical.
  const ISLAND_SHORE_FREQ = 3.2, ISLAND_SHORE_SEED_OFFSET = 0;
  const OUTER_SHORE_FREQ = 5.5, OUTER_SHORE_SEED_OFFSET = 97;

  const TURTLE_RADIUS = 36;          // used for world-edge clamping / camera, not obstacle collision
  const TURTLE_BODY_RADIUS = 22;     // smaller, body-only circle used for obstacle collision (excludes flippers/tail)
  const PILE_LIFETIME = 10;          // seconds a knocked-down sandcastle's sand pile stays before vanishing
  const CASTLE_COIN_CHANCE = 0.2;    // chance a knocked-down sandcastle pops out a coin
  const KNOCKBACK_DIST = 16;         // one-time shove away from a sandcastle the instant it's knocked down
  const DEBUG_HITBOXES = false;      // true: draw red outlines for every collision hitbox in view
  const MAX_SPEED = 180;   // px/s, base speed before the water/land multiplier below
  const WATER_SPEED_MULT = 1.15; // turtle swims a bit faster than it walks
  const LAND_SPEED_MULT = 0.9;
  const ACCEL = 700;       // px/s^2 toward target velocity
  const DECEL = 500;       // px/s^2 when input released
  const JOY_RADIUS = 60;   // CSS px: drag distance for full speed
  const JOY_DEADZONE = 0.12;

  // Spawn point in world units (near home); set for real once the canvas has its final size (below),
  // not here at script-parse time, so a slow/first load can never leave the turtle at 0,0.
  const turtle = { x: 0, y: 0, vx: 0, vy: 0, angle: 0 };
  let spawned = false;
  // The player's hut (home.js): solid walls + door trigger on the island, and the interior scene.
  // Interior movement reuses the world's speed/accel numbers, scaled down inside home.js.
  Home.init({
    turtle, center: CENTER, bodyRadius: TURTLE_BODY_RADIUS,
    maxSpeed: MAX_SPEED * LAND_SPEED_MULT, accel: ACCEL, decel: DECEL,
    onEnter: () => { if (window.Enemies) window.Enemies.resetAggro(); }, // chasers give up when the turtle goes inside
    onEnterInterior: () => { window.Progression.setHomeButtonVisible(true); setCompassShown(false); }, // shop (upgrades) icon stays available indoors; only the compass hides
  });
  // ---- Compass: DOM HUD element (in the shop icon's slot) whose turtle needle points at the hut door.
  // Heading is re-checked ~10x/s from update(); the DOM is only touched when the frame or visibility changes.
  const COMPASS_ARRIVE_DIST = 450;   // world units from the hut door: inside this the needle hides ("arrived")
  const COMPASS_CHECK_INTERVAL = 0.1; // seconds between heading checks
  const COMPASS_SIZE = 64; // display px (art is 64px, 1x); change style.css width/height/background-size to match
  const compassDoor = { x: CENTER.x + Home.CONFIG.hutOffset.x, y: CENTER.y + Home.CONFIG.hutOffset.y + Home.CONFIG.exitDropPx };
  const compassFramePos = []; // 'background-position-x' strings, built once (no per-frame strings)
  for (let i = 0; i < 16; i++) compassFramePos.push(-i * COMPASS_SIZE + 'px');
  let compassEl = null, compassNeedle = null, compassShown = false, compassFrame = -1, compassArrived = false, compassTimer = 0;
  let compassImagesLeft = 2;
  for (const f of ['compass_base_64.png', 'compass_needle_16dir_spritesheet.png']) {
    const img = new Image();
    img.onload = img.onerror = () => { compassImagesLeft--; };
    img.src = 'assets/items/' + f + '?v=1';
  }
  function setCompassShown(show) {
    if (show === compassShown) return;
    if (!compassEl) {
      compassEl = document.createElement('div'); compassEl.id = 'tt-compass';
      compassNeedle = document.createElement('div'); compassNeedle.id = 'tt-compass-needle';
      compassEl.appendChild(compassNeedle);
      window.Progression.getIconRow().appendChild(compassEl);
    }
    compassShown = show;
    compassEl.style.display = show ? 'block' : 'none';
    if (show) compassFrame = -1, compassTimer = COMPASS_CHECK_INTERVAL; // force a fresh check right away
  }
  function updateCompass(dt, onIsland) {
    if (onIsland) { setCompassShown(false); return; }
    setCompassShown(true);
    compassTimer += dt;
    if (compassTimer < COMPASS_CHECK_INTERVAL) return;
    compassTimer = 0;
    const dx = compassDoor.x - turtle.x, dy = compassDoor.y - turtle.y;
    const arrived = dx * dx + dy * dy < COMPASS_ARRIVE_DIST * COMPASS_ARRIVE_DIST;
    if (arrived !== compassArrived || compassFrame < 0) { compassArrived = arrived; compassNeedle.style.visibility = arrived ? 'hidden' : 'visible'; }
    if (arrived) return;
    // 0 = up, clockwise; frame 0 points north, each frame is 22.5deg clockwise
    const f = (Math.round(Math.atan2(dx, -dy) * (8 / Math.PI)) + 16) % 16;
    if (f !== compassFrame) { compassFrame = f; compassNeedle.style.backgroundPositionX = compassFramePos[f]; }
  }

  function spawnTurtle() {
    const p = Home.exitPoint(); // just below the hut's porch
    turtle.x = p.x;
    turtle.y = p.y;
    turtle.vx = 0; turtle.vy = 0;
    spawned = true;
    if (window.Enemies) window.Enemies.resetAggro(); // chasers give up when the turtle is back home
  }
  // Heart-loss respawns (Progression.takeHit hitting 0) snap the turtle back to the home spot the
  // same way the initial spawn does. Not exercised yet — no enemies call takeHit() until birds exist.
  window.Progression && window.Progression.setRespawnHandler(spawnTurtle);
  // Death sequence: slow fade to black, a beat of full black, then respawn on the island.
  const DEATH_FADE_SECONDS = 2.5, DEATH_BLACK_SECONDS = 1;
  let deathTimer = -1; // -1 = alive; otherwise seconds since death
  let deathX = 0, deathY = 0; // where the turtle was caught: carried items are dropped here (see the end of the death sequence)
  let deathStartDim = 0; // starvation dim already on screen when death hits, so the fade continues from it
  function startDeath() {
    deathStartDim = window.Progression.getStarveDim();
    state = 'dying'; stateTime = 0; deathTimer = 0;
    deathX = turtle.x; deathY = turtle.y;
    if (window.TT_SOUND) window.TT_SOUND.gameover();
  }
  window.Progression && window.Progression.setDeathHandler(startDeath);
  // Carried items scatter around the death spot as ordinary pickups (they stay until grabbed; not saved across reloads).
  // TODO: persist dropped piles in the save slot if they should survive closing the game.
  function dropLostItems() {
    const lost = window.Progression.takeLostItems();
    if (!lost) return;
    const drops = [];
    for (let i = 0; i < lost.coins; i++) drops.push([coinPickups, 0]);
    for (let i = 0; i < lost.coconuts; i++) drops.push([coconutPickups, 0]);
    for (const k of lost.finds) drops.push([findPickups, k]);
    drops.forEach(([pk, kind], i) => {
      const a = (i / drops.length) * Math.PI * 2, r = 30 + Math.random() * 40;
      pk.dropAt(deathX + Math.cos(a) * r, deathY + Math.sin(a) * r, kind);
    });
  }

  // ---- Input -> normalized direction vector (length 0..1) ----
  const keys = new Set();
  // Turtle state: 'normal' | 'stunned' | 'sleeping' | 'shell'. Non-normal states can't move.
  // TODO: real triggers (bird hit, hunger/night, hide button); keys 1-4 are a debug switch for now.
  let state = 'normal';
  let stateTime = 0;
  const DEBUG_STATES = { 1: 'normal', 2: 'stunned', 3: 'sleeping', 4: 'shell' };
  const joy = { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0 };

  // Any input wakes the (debug-key) sleeping state. Real sleeping is the hut bed (home.js).
  let hideIdleTimer = 0, shellFromToggle = false; // Hide in Shell: idle time so far / whether the current 'shell' state came from the toggle
  function wakeUp() {
    if (state !== 'sleeping') return;
    state = 'normal';
    stateTime = 0;
  }

  // Walk vs swim animation, picked from isWater() each frame rather than a key. Debounced so
  // stepping right at the shoreline doesn't flicker the animation back and forth.
  let moveMode = 'walk';           // 'walk' | 'swim' — only used while state === 'normal'
  let moveModeCandidate = 'walk';
  let moveModeCandidateFrames = 0;
  const MODE_SWITCH_FRAMES = 3;    // consecutive frames on the new terrain before switching

  const KEY_MAP = { w: 'up', a: 'left', s: 'down', d: 'right' };
  // Ignore WASD/debug keys while a text field (e.g. intro.js's save-name input) has focus, or
  // typing a 'w'/'a'/'s'/'d' into it gets eaten as movement input instead of reaching the field.
  function typingInField() {
    const el = document.activeElement;
    return !!el && /^(INPUT|TEXTAREA)$/.test(el.tagName);
  }
  // ?debug=1 shortcuts, shared by the keys above and the on-screen buttons below (phones have no keyboard).
  function debugAction(name) {
    if (name === 'c') { window.Progression.state.banked.coins += 1000; window.Progression.persist(); }
    else if (name === 'u') setAdventureUnlocked(!adventureUnlocked);
    else if (name === 'k' && spawned && !Home.isInterior()) { // chest right here, ahead of the turtle (bypasses the timer and the distance rules)
      setAdventureUnlocked(true);
      for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6, x = turtle.x + Math.cos(a) * 260, y = turtle.y + Math.sin(a) * 260; if (!blockedAt(x, y, 48)) { chest.x = x; chest.y = y; chest.on = true; chest.left = 0; break; } }
      saveChest();
    }
    else if (name === 't' && spawned && !Home.isInterior()) { setAdventureUnlocked(true); turtle.x = WORLD_SIZE + 700; turtle.y = CENTER.y; turtle.vx = turtle.vy = 0; }
  }
  if (DEBUG) {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;right:6px;bottom:calc(6px + env(safe-area-inset-bottom));z-index:99;display:flex;gap:6px;opacity:.85';
    for (const [name, label] of [['u', 'Lock/Unlock'], ['t', 'Warp to zone'], ['c', '+1000 coins'], ['k', 'Chest here']]) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.style.cssText = 'font:600 12px system-ui,sans-serif;padding:8px 10px;border-radius:10px;border:1px solid rgba(0,0,0,.4);background:#fff3c4;color:#222;touch-action:manipulation';
      b.addEventListener('click', () => debugAction(name));
      bar.appendChild(b);
    }
    document.body.appendChild(bar);
  }
  window.addEventListener('keydown', e => {
    if (typingInField()) return;
    if (DEBUG_STATES[e.key]) { state = DEBUG_STATES[e.key]; stateTime = 0; return; }
    if (DEBUG && (e.key === 'c' || e.key === 'u' || e.key === 't' || e.key === 'k')) { debugAction(e.key); return; } // ?debug=1: c = +1000 banked coins, u = lock/unlock the Adventure Zone, t = teleport into it (unlocking it first)
    const k = KEY_MAP[e.key.toLowerCase()];
    if (k) { wakeUp(); keys.add(k); e.preventDefault(); }
  });
  window.addEventListener('keyup', e => {
    if (typingInField()) return;
    const k = KEY_MAP[e.key.toLowerCase()];
    if (k) keys.delete(k);
  });
  window.addEventListener('blur', () => keys.clear());

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    wakeUp();
    const t = e.changedTouches[0];
    if (window.Progression.tryEatFromHud(t.clientX, t.clientY)) return; // tapped the hunger bar, not a joystick drag
    if (joy.active) return;
    joy.active = true; joy.id = t.identifier;
    joy.ox = joy.x = t.clientX; joy.oy = joy.y = t.clientY;
  }, { passive: false });
  canvas.addEventListener('mousedown', wakeUp); // desktop "click" wakes it too (no other click mechanic exists yet)
  canvas.addEventListener('click', e => window.Progression.tryEatFromHud(e.clientX, e.clientY)); // desktop: click the hunger bar to eat a coconut
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

  const dirBuf = { x: 0, y: 0 }; // reused result; update() only reads it right away
  function getDirection() {
    let dx = 0, dy = 0;
    if (keys.has('left')) dx -= 1;
    if (keys.has('right')) dx += 1;
    if (keys.has('up')) dy -= 1;
    if (keys.has('down')) dy += 1;
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      dirBuf.x = dx / len; dirBuf.y = dy / len;
      return dirBuf;
    }
    if (joy.active) {
      const jx = joy.x - joy.ox, jy = joy.y - joy.oy;
      const len = Math.hypot(jx, jy);
      const mag = Math.min(len / JOY_RADIUS, 1);
      if (mag > JOY_DEADZONE) { dirBuf.x = (jx / len) * mag; dirBuf.y = (jy / len) * mag; return dirBuf; }
    }
    dirBuf.x = 0; dirBuf.y = 0;
    return dirBuf;
  }

  // ---- Seeded RNG + value noise (both fixed-seed, so the world is identical every load) ----
  let rngState = 9301;
  const rand = () => (rngState = (rngState * 16807) % 2147483647) / 2147483647;

  const NOISE_SEED = 51;
  function hash2(ix, iy) {
    let h = (ix * 374761393 + iy * 668265263 + NOISE_SEED) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function noise2(x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy); // smoothstep
    const n00 = hash2(x0, y0), n10 = hash2(x0 + 1, y0);
    const n01 = hash2(x0, y0 + 1), n11 = hash2(x0 + 1, y0 + 1);
    return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
  }

  // Generic color-math helpers used by the shoreline gradient below.
  function smoothstep(edge0, edge1, x) {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }
  function lerpColor(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  // ---- Biomes ----
  // Angle from the world center (0 = east, clockwise since screen y grows downward) picks the
  // biome, with low-frequency noise nudging the angle so borders wander instead of cutting
  // straight lines. biomeWeights() then blends the 4 sector colors smoothly across each diagonal
  // (NE/SE/SW/NW) rather than hard-switching at a threshold.
  const DEG = Math.PI / 180;
  const BIOME_CENTER_ANGLE = { forestOpen: 0, deadTrees: 90 * DEG, forestThick: 180 * DEG, beach: -90 * DEG };
  // +-15deg swing (was +-35deg): the old amplitude was enough to flip the argmax winner even 40+deg
  // inside a neighboring sector's own territory (e.g. 'beach' briefly outscoring 'forestThick' in a
  // spot that's 80%+ forestThick by geometry alone), which stamped a stray sand-tile "island" deep
  // in the west forest. +-15deg still wanders the border noticeably without flipping sectors outright.
  const BIOME_ANGLE_NOISE_DEG = 30;
  function biomeAngleNoise(x, y) { return (noise2(x / 480, y / 480) - 0.5) * BIOME_ANGLE_NOISE_DEG * DEG; }
  function biomeWeights(angle, out) {
    const w = out || {}; let sum = 0; // `out` lets per-frame callers reuse one object instead of allocating
    for (const k in BIOME_CENTER_ANGLE) {
      let d = angle - BIOME_CENTER_ANGLE[k];
      d = Math.atan2(Math.sin(d), Math.cos(d)); // wrap to -PI..PI
      const v = Math.max(0, Math.cos(d)) ** 3;  // 1 at sector center, tapering to 0 by +-90deg
      w[k] = v; sum += v;
    }
    for (const k in w) w[k] /= (sum || 1);
    return w;
  }
  function dominantBiome(x, y) {
    const dx = x - CENTER.x, dy = y - CENTER.y;
    const angle = Math.atan2(dy, dx) + biomeAngleNoise(x, y);
    const w = biomeWeights(angle);
    let best = 'forestOpen', bestW = 0;
    for (const k in w) if (w[k] > bestW) { bestW = w[k]; best = k; }
    return { biome: best, weight: bestW };
  }
  function isWater(x, y) {
    const dist = Math.hypot(x - CENTER.x, y - CENTER.y);
    return dist > ISLAND_R && dist <= WATER_OUTER_R;
  }
  // Home/safe zone (MDD s3): the island itself, no birds, hunger doesn't drain, banking happens here.
  function isHomeIsland(x, y) {
    return Math.hypot(x - CENTER.x, y - CENTER.y) <= ISLAND_R;
  }
  // TODO: reuse dominantBiome()/isWater() for future bird patrol & item-spawn zone logic.
  const BIOME_COLOR = {
    beach: [230, 214, 168],       // north
    forestOpen: [138, 196, 108],  // east
    deadTrees: [84, 122, 70],     // south — same tone as the grass ground tile (all 3 tree
                                  // biomes use grass; only the beach uses sand)
    forestThick: [42, 78, 46],    // west
  };

  // ---- Shoreline shape: the island and mainland coasts are each a circle whose radius wanders
  // with seeded noise sampled by angle (cos/sin keeps it seamless at the 0/2*PI wrap), so the
  // coastline reads as a natural wobble instead of a perfect circle. Purely visual — isWater() and
  // biome logic above still use the exact ISLAND_R/WATER_OUTER_R circles, untouched. ----
  function shoreWobble(angle, seedOffset, freq) {
    const nx = Math.cos(angle) * freq + seedOffset, ny = Math.sin(angle) * freq + seedOffset;
    return (noise2(nx, ny) - 0.5) * 2 * SHORE_NOISE_AMPLITUDE;
  }
  // Signed distance from whichever shoreline (island or mainland) is nearer this point — negative
  // on land, positive in water — plus which shore that was. Shared by the color blend below and by
  // buildGrassLayers(), so grass never floats over water on the noisy side of the old perfect-circle
  // radius.
  function shoreSignedDist(x, y) {
    const dx = x - CENTER.x, dy = y - CENTER.y;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const rIsland = ISLAND_R + shoreWobble(angle, ISLAND_SHORE_SEED_OFFSET, ISLAND_SHORE_FREQ);
    const rOuter = WATER_OUTER_R + shoreWobble(angle, OUTER_SHORE_SEED_OFFSET, OUTER_SHORE_FREQ);
    const nearIsland = dist < (rIsland + rOuter) / 2;
    return { d: nearIsland ? dist - rIsland : rOuter - dist, nearIsland }; // negative land, positive water
  }

  // The base ground color at one point, used only as the flat fill underneath Shore.js's real
  // water/sand tiles (and, past the sand band, wherever the grass biome textures fade in). The old
  // hand-blended deep/shallow-water and wet/dry-sand gradient that used to live here is gone —
  // Shore.js now draws the actual shoreline (see the "Shore.js" section below), so this only needs
  // to return water's flat fallback color and each biome's flat land color.
  function shorelineGroundColor(x, y) {
    const { d, nearIsland } = shoreSignedDist(x, y);
    if (d >= 0) return SHORE_DEEP_COLOR;         // water: fully covered by Shore.js's water draw
    if (nearIsland) return SHORE_DRY_SAND_COLOR; // island: fully covered by Shore.js's sand draw
    const dx = x - CENTER.x, dy = y - CENTER.y;
    const w = biomeWeights(Math.atan2(dy, dx) + biomeAngleNoise(x, y));
    const landColor = [0, 0, 0];
    for (const k in w) {
      landColor[0] += BIOME_COLOR[k][0] * w[k];
      landColor[1] += BIOME_COLOR[k][1] * w[k];
      landColor[2] += BIOME_COLOR[k][2] * w[k];
    }
    return landColor;
  }

  // (The ground — terrain colors + grass textures — is baked in lazily built chunks, see "Ground chunks" below.)
  const TERRAIN_CELL = 4;          // world px per terrain grid cell (a chunk's color grid is sampled this finely)
  const FOG_COLOR = [8, 28, 36];

  // None of the tile art (sand3, grass3) tiles cleanly on its own — opposite edges don't match,
  // which showed up as a hard seam line wherever two tiles met. buildSeamlessTile() fixes that per
  // image, once, at load: roll the image by half its width/height (wraparound) so the original edge
  // seam lands in a cross through the middle instead — the new outer edges are just adjacent source
  // pixels, so they already tile. No blur/feather — leave the seam cross sharp like the rest of the
  // texture.
  function buildSeamlessTile(img) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const hw = Math.round(w / 2), hh = Math.round(h / 2);
    const rolled = document.createElement('canvas'); rolled.width = w; rolled.height = h;
    const rctx = rolled.getContext('2d');
    rctx.drawImage(img, -hw, -hh);
    rctx.drawImage(img, w - hw, -hh);
    rctx.drawImage(img, -hw, h - hh);
    rctx.drawImage(img, w - hw, h - hh);
    return rolled;
  }

  // ---- Ground texture tiles: real art laid over the flat-color terrain blend above.
  // sand3 is kept loaded here (not for a beach tile grid anymore — Shore.js below draws the real
  // sand now) because buildIslandDetail() still textures the home island's sand-spot dunes with it.
  const GROUND_TILES = {};
  let sandTileReady = false;
  for (const name of ['sand3']) {
    const img = new Image();
    const entry = { canvas: null };
    img.onload = () => { entry.canvas = buildSeamlessTile(img); sandTileReady = true; refreshIslandSand(); tryInitShore(); };
    img.src = `assets/tiles/${name}.png`;
    GROUND_TILES[name] = entry;
  }
  const GROUND_TILE_FADE = 90; // world px inland over which grass textures fade up to full opacity

  // ---- Shore.js: real animated water/sand tiles + little waves, replacing the old flat-color
  // water/wet-sand gradient and hand-traced foam/shimmer above. This game has no discrete tile map
  // (water/sand are continuous distance fields, see isWater()/shoreSignedDist() above), so we build
  // one synthetic 64px-cell grid once at load by sampling that geometry, and hand it to Shore.create
  // exactly like a real map. 1 = water, 2 = sand, 0 = everything else (the grass biomes texture
  // themselves in bakeChunk() and just need a plain land color underneath, from
  // shorelineGroundColor()). Every coastline gets a sand band before grass takes over — using the
  // same SHORE_WET_BAND+SHORE_DRY_BAND distance buildGrassLayers() already fades grass in past, so
  // the two line up — not just the beach biome's own sector (which stays sand all the way inland).
  const SHORE_SAND_BAND = -(SHORE_WET_BAND + SHORE_DRY_BAND);
  // The grid covers the whole enlarged world; its origin is a multiple of Shore.TILE so the home zone's tiles
  // fall exactly where they always did.
  const SHORE_ORIGIN = -Math.ceil(WORLD_PAD / Shore.TILE) * Shore.TILE;
  const shoreCols = Math.ceil((WORLD_MAX - SHORE_ORIGIN) / Shore.TILE), shoreRows = shoreCols;
  const shoreMap = [];
  for (let ty = 0; ty < shoreRows; ty++) {
    const row = [];
    const y = SHORE_ORIGIN + ty * Shore.TILE + Shore.TILE / 2;
    for (let tx = 0; tx < shoreCols; tx++) {
      const x = SHORE_ORIGIN + tx * Shore.TILE + Shore.TILE / 2;
      if (isWater(x, y)) { row.push(1); continue; }
      const { d, nearIsland } = shoreSignedDist(x, y);
      if (nearIsland) { row.push(2); continue; } // the whole island is sand, not just a coastal band
      // A plain dominantBiome() argmax check here would flip to 'beach' for stray cells well inside
      // another biome's own sector whenever the angle noise nudges it just past the other 3 biomes
      // (the same argmax pitfall groundTileFor's old comment already called out — see biomeWeights
      // above), stamping isolated sand+water patches deep in the forest. Requiring beach's own
      // weight to clearly dominate (not just edge out the others) avoids that.
      const dx = x - CENTER.x, dy = y - CENTER.y;
      const isBeach = biomeWeights(Math.atan2(dy, dx) + biomeAngleNoise(x, y)).beach > 0.5;
      row.push((isBeach || d > SHORE_SAND_BAND || inSandTextZone(x, y)) ? 2 : 0);
    }
    shoreMap.push(row);
  }

  let waterTileReady = false;
  const waterTile = { canvas: null };
  const waterTileImg = new Image();
  waterTileImg.onload = () => { waterTile.canvas = buildSeamlessTile(waterTileImg); waterTileReady = true; tryInitShore(); };
  waterTileImg.src = 'assets/tiles/water1.png';

  let shore = null;
  function tryInitShore() {
    if (shore || !sandTileReady || !waterTileReady) return;
    shore = Shore.create(shoreMap, GROUND_TILES.sand3.canvas, waterTile.canvas, {
      isWater: v => v === 1,
      isSand: v => v === 2,
      sandEdge: 'soft',
      sway: false,     // water texture stays put, waves/foam still animate
      speed: 0.45,     // faster wave cycles = more frequent lapping
      waveDepth: 0.24, // waves reach further out, bigger foam crest
      res: window.innerWidth <= 768 ? 3 : 2, // coarser wave mask on phones
      origin: { x: SHORE_ORIGIN, y: SHORE_ORIGIN },
    });
  }
  // shore.draw() expects a plain, untransformed ctx (1 canvas px = 1 world px, its own camX/camY
  // bookkeeping does the scrolling) — it doesn't know about this game's ZOOM. So it's rendered onto
  // its own world-sized scratch canvas first, then that scratch is drawn into the real ctx with a
  // world-space dest rect, same as drawGround() does, so ZOOM applies to
  // it like everything else.
  let shoreScratch = null;
  function drawShore(t) {
    const vw = Math.ceil(viewW / ZOOM), vh = Math.ceil(viewH / ZOOM);
    if (!shoreScratch) shoreScratch = document.createElement('canvas');
    if (shoreScratch.width !== vw || shoreScratch.height !== vh) { shoreScratch.width = vw; shoreScratch.height = vh; }
    const sctx = shoreScratch.getContext('2d');
    sctx.clearRect(0, 0, vw, vh); // last frame's water/sand would otherwise linger under the new camera position
    shore.draw(sctx, camX, camY, vw, vh, t);
    ctx.drawImage(shoreScratch, camX, camY, vw, vh);
  }

  // ---- Grass biome textures (east/west/south only — north beach keeps sand, untouched above).
  // Per-biome config so each is easy to tweak; grass3.png is reused across all 3 biomes and
  // differentiated with a tint wash + opacity instead of needing 3 distinct source images.
  // grass3.png doesn't tile cleanly on its own (edge pixels don't match their opposite edge) —
  // getGrassPattern() below runs it through buildSeamlessTile() before patterning it.
  const GRASS_BIOMES = {
    forestOpen:  { img: 'assets/tiles/grass3.png', tintColor: null,           tintAlpha: 0,    opacity: 1.0 }, // east: bright, healthy green
    forestThick: { img: 'assets/tiles/grass3.png', tintColor: [12, 46, 18],   tintAlpha: 0.4,  opacity: 1.0 }, // west: darker, denser
    deadTrees:   { img: 'assets/tiles/grass3.png', tintColor: [168, 130, 60], tintAlpha: 0.5,  opacity: 0.8 }, // south: dry, patchy, yellow-brown
  };
  let grassImagesLoaded = 0;
  const GRASS_BIOME_KEYS = Object.keys(GRASS_BIOMES);
  let grassReady = false;
  for (const key of GRASS_BIOME_KEYS) {
    const cfg = GRASS_BIOMES[key];
    const img = new Image();
    img.onload = () => { grassImagesLoaded++; if (grassImagesLoaded >= GRASS_BIOME_KEYS.length) grassReady = true; };
    img.src = cfg.img;
    cfg.imgEl = img;
  }

  // Low-res per-biome mask (alpha = that biome's weight, faded to 0 by the same
  // SHORE_WET_BAND/SHORE_DRY_BAND used below, so grass always stops before the shore) and a
  // matching low-opacity color-variation layer (soft light/dark patches from the seeded noise, to
  // break up the repeating pattern). Built once from world geometry; only world size/seed changing
  // would invalidate it, and neither changes at runtime.
  const GRASS_CELL = 8;
  const GRASS_VARIATION_COLORS = {
    forestOpen:  { dark: [96, 156, 76],  light: [176, 216, 134] },
    forestThick: { dark: [24, 50, 28],   light: [66, 104, 56] },
    deadTrees:   { dark: [110, 88, 48],  light: [200, 172, 104] },
  };
  const grassPatterns = {};
  function getGrassPattern(key) {
    if (grassPatterns[key]) return grassPatterns[key];
    const img = GRASS_BIOMES[key].imgEl;
    if (!img.complete || !img.naturalWidth) return null;
    return (grassPatterns[key] = ctx.createPattern(buildSeamlessTile(img), 'repeat'));
  }

  // ---- Ground chunks: the whole ground (terrain colors + grass textures) is pre-rendered into CHUNK-sized
  // offscreen canvases, built lazily (sliced across frames) for the chunks in or just around the view and
  // dropped again once they're far away. Memory and per-frame cost follow the screen size, not the world
  // size, so the 4x bigger world costs no more than the old one. A chunk is baked once: one drawImage per
  // visible chunk replaces the old per-frame grass compositing. Phones bake at CHUNK_SCALE < 1 to save memory.
  const CHUNK = 512;
  const IS_PHONE = window.innerWidth <= 768 || Math.min(screen.width, screen.height) <= 768;
  const CHUNK_SCALE = IS_PHONE ? 0.75 : 1;   // baked canvas px per world px
  const CHUNK_PX = Math.round(CHUNK * CHUNK_SCALE);
  const CHUNK_KEEP = IS_PHONE ? 1 : 2;       // chunks kept beyond the view on each side before eviction (fewer on phones: memory)
  const CHUNK_PREFETCH = 1;                  // chunks baked ahead beyond the view on each side
  const CHUNK_URGENT_MS = 12, CHUNK_AHEAD_MS = 3; // per-frame bake budgets: visible chunks missing / prefetching
  const TERRAIN_P = CHUNK / TERRAIN_CELL + 2, GRASS_P = CHUNK / GRASS_CELL + 2; // grid sizes, padded 1 cell per side so chunk edges blend
  const chunks = new Map();                  // key -> { cx, cy, canvas, ctx, ready, gen }
  const chunkSpare = [];                     // canvases of evicted chunks, reused instead of reallocated
  const chunkKey = (cx, cy) => (cx + 32) * 64 + (cy + 32);
  const terrainScratch = document.createElement('canvas');
  terrainScratch.width = terrainScratch.height = TERRAIN_P;
  const terrainScratchCtx = terrainScratch.getContext('2d');
  const terrainImg = terrainScratchCtx.createImageData(TERRAIN_P, TERRAIN_P);
  const layerScratch = document.createElement('canvas'); // one biome's grass, masked, before it's laid on the chunk
  layerScratch.width = layerScratch.height = CHUNK_PX;
  const layerScratchCtx = layerScratch.getContext('2d');
  const grassScratch = {};                               // per biome: low-res mask + variation/tint canvases
  for (const key of GRASS_BIOME_KEYS) {
    const mk = () => { const c = document.createElement('canvas'); c.width = c.height = GRASS_P; const g = c.getContext('2d'); return { c, g, img: g.createImageData(GRASS_P, GRASS_P) }; };
    grassScratch[key] = { mask: mk(), vari: mk(), any: false };
  }

  // Bakes one chunk, yielding every few rows so the caller can stop at its frame budget.
  function* bakeChunk(ch) {
    const x0 = ch.cx * CHUNK, y0 = ch.cy * CHUNK, g = ch.ctx, S = CHUNK_SCALE;
    // 1) terrain colors on a TERRAIN_CELL grid, upscaled with smoothing (same look as the old world-wide bitmap)
    const td = terrainImg.data;
    for (let j = 0; j < TERRAIN_P; j++) {
      const y = y0 + (j - 1) * TERRAIN_CELL;
      for (let i = 0; i < TERRAIN_P; i++) {
        const x = x0 + (i - 1) * TERRAIN_CELL;
        let col = shorelineGroundColor(x, y);
        // Deep-water/fog fringe at the playable edge so it reads as a boundary, not a cliff.
        const edgeDist = Math.min(x - bounds.x0, y - bounds.y0, bounds.x1 - x, bounds.y1 - y);
        if (edgeDist < EDGE_FOG_WIDTH) col = lerpColor(col, FOG_COLOR, Math.min(1, 1 - edgeDist / EDGE_FOG_WIDTH));
        const k = (j * TERRAIN_P + i) * 4;
        td[k] = col[0]; td[k + 1] = col[1]; td[k + 2] = col[2]; td[k + 3] = 255;
      }
      if ((j & 15) === 15) yield;
    }
    terrainScratchCtx.putImageData(terrainImg, 0, 0);
    g.setTransform(S, 0, 0, S, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(terrainScratch, -TERRAIN_CELL, -TERRAIN_CELL, TERRAIN_P * TERRAIN_CELL, TERRAIN_P * TERRAIN_CELL);
    yield;
    // 2) grass: per-biome mask (alpha = that biome's weight, fading out before the shore) and variation wash + tint
    const tileStart = -(SHORE_WET_BAND + SHORE_DRY_BAND);
    for (const key of GRASS_BIOME_KEYS) grassScratch[key].any = false;
    for (let j = 0; j < GRASS_P; j++) {
      const y = y0 + (j - 1) * GRASS_CELL;
      for (let i = 0; i < GRASS_P; i++) {
        const x = x0 + (i - 1) * GRASS_CELL;
        const { d, nearIsland } = shoreSignedDist(x, y);
        const k = (j * GRASS_P + i) * 4;
        let w = null;
        if (!nearIsland && d <= tileStart) {
          const landFade = smoothstep(tileStart, tileStart - GROUND_TILE_FADE, d) * (1 - sandTextFade(x, y));
          if (landFade > 0) {
            w = biomeWeights(Math.atan2(y - CENTER.y, x - CENTER.x) + biomeAngleNoise(x, y));
            for (const key in w) w[key] *= landFade;
          }
        }
        const patch = noise2(x / 260 + 500, y / 260 + 500); // soft, large-scale color variation
        for (const key of GRASS_BIOME_KEYS) {
          const gs = grassScratch[key], alpha = w ? w[key] : 0;
          const md = gs.mask.img.data, vd = gs.vari.img.data;
          md[k] = md[k + 1] = md[k + 2] = 255;
          md[k + 3] = Math.round(alpha * 255);
          if (md[k + 3] > 0) gs.any = true;
          const c = GRASS_VARIATION_COLORS[key], col = lerpColor(c.dark, c.light, patch);
          vd[k] = col[0]; vd[k + 1] = col[1]; vd[k + 2] = col[2]; vd[k + 3] = Math.round(0.15 * 255); // low opacity, clipped to the mask later
        }
      }
      if ((j & 15) === 15) yield;
    }
    for (const key of GRASS_BIOME_KEYS) {
      const gs = grassScratch[key], cfg = GRASS_BIOMES[key], pattern = getGrassPattern(key);
      if (!gs.any || !pattern) continue;
      gs.mask.g.putImageData(gs.mask.img, 0, 0);
      gs.vari.g.putImageData(gs.vari.img, 0, 0);
      if (cfg.tintColor) {
        gs.vari.g.fillStyle = `rgba(${cfg.tintColor[0]}, ${cfg.tintColor[1]}, ${cfg.tintColor[2]}, ${cfg.tintAlpha})`;
        gs.vari.g.fillRect(0, 0, GRASS_P, GRASS_P);
      }
      // Same compositing as the old per-frame version: pattern fill -> mask (destination-in) -> wash+tint
      // (source-atop) -> laid over the terrain, now once per chunk.
      const L = layerScratchCtx;
      L.setTransform(S, 0, 0, S, -x0 * S, -y0 * S);
      L.globalCompositeOperation = 'source-over';
      L.clearRect(x0, y0, CHUNK, CHUNK);
      L.fillStyle = pattern;
      L.fillRect(x0, y0, CHUNK, CHUNK);
      L.setTransform(1, 0, 0, 1, 0, 0);
      const off = -GRASS_CELL * S, size = GRASS_P * GRASS_CELL * S;
      L.globalCompositeOperation = 'destination-in';
      L.drawImage(gs.mask.c, off, off, size, size);
      L.globalCompositeOperation = 'source-atop';
      L.drawImage(gs.vari.c, off, off, size, size);
      L.globalCompositeOperation = 'source-over';
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = cfg.opacity;
      g.drawImage(layerScratch, 0, 0);
      g.globalAlpha = 1;
      yield;
    }
    // TODO: if baking a chunk still hitches on slow phones, split the terrain pass finer or lower CHUNK_SCALE.
  }

  function chunkInBounds(cx, cy) {
    const x0 = cx * CHUNK, y0 = cy * CHUNK;
    return x0 < bounds.x1 && x0 + CHUNK > bounds.x0 && y0 < bounds.y1 && y0 + CHUNK > bounds.y0;
  }
  function getChunk(cx, cy) {
    const key = chunkKey(cx, cy);
    let ch = chunks.get(key);
    if (ch) return ch;
    const spare = chunkSpare.pop();
    const canvas = spare ? spare.canvas : document.createElement('canvas');
    if (!spare) { canvas.width = canvas.height = CHUNK_PX; }
    ch = { cx, cy, canvas, ctx: spare ? spare.ctx : canvas.getContext('2d', { alpha: false }), ready: false, gen: null };
    ch.gen = bakeChunk(ch);
    chunks.set(key, ch);
    return ch;
  }
  function dropChunk(key, ch) {
    chunks.delete(key);
    chunkSpare.push({ canvas: ch.canvas, ctx: ch.ctx });
  }
  // Runs the baking generator of one chunk until it's done or the deadline passes (always at least one slice).
  function stepChunk(ch, deadline) {
    do {
      if (ch.gen.next().done) { ch.ready = true; ch.gen = null; return; }
    } while (performance.now() < deadline);
  }
  // Bakes missing/unfinished chunks in cx0..cx1 x cy0..cy1, nearest the camera center first, until the budget is spent.
  function bakeMissing(cx0, cy0, cx1, cy1, budgetMs) {
    if (!grassReady) return;
    const deadline = performance.now() + budgetMs;
    const mx = (cx0 + cx1 + 1) / 2, my = (cy0 + cy1 + 1) / 2;
    for (;;) {
      let best = null, bd = Infinity;
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        if (!chunkInBounds(cx, cy)) continue;
        const ch = chunks.get(chunkKey(cx, cy));
        if (ch && ch.ready) continue;
        const d = (cx + 0.5 - mx) ** 2 + (cy + 0.5 - my) ** 2;
        if (d < bd) { bd = d; best = ch || { cx, cy, fresh: true }; }
      }
      if (!best) return;
      const ch = best.fresh ? getChunk(best.cx, best.cy) : best;
      stepChunk(ch, deadline);
      if (performance.now() >= deadline) return;
    }
  }
  // Chunk index range covering the camera view plus `margin` chunks. Writes into the shared range object.
  const chunkRange = { cx0: 0, cy0: 0, cx1: 0, cy1: 0 };
  function setChunkRange(margin) {
    const vw = viewW / ZOOM, vh = viewH / ZOOM, r = chunkRange;
    r.cx0 = Math.floor(camX / CHUNK) - margin; r.cx1 = Math.floor((camX + vw) / CHUNK) + margin;
    r.cy0 = Math.floor(camY / CHUNK) - margin; r.cy1 = Math.floor((camY + vh) / CHUNK) + margin;
    return r;
  }
  // Called once per frame after the camera is placed: bake what's visible (blocking within a budget), prefetch the
  // ring around it with a small budget, and drop chunks that are far outside the view.
  function serviceGround() {
    let r = setChunkRange(0);
    bakeMissing(r.cx0, r.cy0, r.cx1, r.cy1, TEST ? 1e9 : CHUNK_URGENT_MS);
  }
  function serviceGroundAhead() {
    let r = setChunkRange(CHUNK_PREFETCH);
    bakeMissing(r.cx0, r.cy0, r.cx1, r.cy1, CHUNK_AHEAD_MS);
    r = setChunkRange(CHUNK_KEEP);
    const keepCount = (r.cx1 - r.cx0 + 1) * (r.cy1 - r.cy0 + 1);
    if (chunks.size > keepCount) {
      for (const [key, ch] of chunks) if (ch.cx < r.cx0 || ch.cx > r.cx1 || ch.cy < r.cy0 || ch.cy > r.cy1) dropChunk(key, ch);
    }
  }
  function drawGround() {
    const r = setChunkRange(0);
    for (let cy = r.cy0; cy <= r.cy1; cy++) for (let cx = r.cx0; cx <= r.cx1; cx++) {
      const ch = chunks.get(chunkKey(cx, cy));
      if (ch && ch.ready) ctx.drawImage(ch.canvas, cx * CHUNK, cy * CHUNK, CHUNK + 1, CHUNK + 1); // +1: overlap so no hairline seams between chunks
    }
  }
  // Bakes everything the first frame at world point (x, y) will show, right now (start()); the warm-up below
  // normally has it done already while the intro plays.
  function ensureGroundAt(x, y) {
    const vw = viewW / ZOOM, vh = viewH / ZOOM;
    bakeMissing(Math.floor((x - vw / 2) / CHUNK), Math.floor((y - vh / 2) / CHUNK), Math.floor((x + vw / 2) / CHUNK), Math.floor((y + vh / 2) / CHUNK), 1e9);
  }
  // Warm-up around the spawn point while the intro screens run (a few ms per timer tick, so nothing stutters).
  function warmGround() {
    if (spawned || started) return;
    if (!grassReady) { setTimeout(warmGround, 100); return; }
    const p = Home.exitPoint(), w = Math.max(window.innerWidth, window.innerHeight) / ZOOM / 2 + CHUNK / 2;
    const cx0 = Math.floor((p.x - w) / CHUNK), cx1 = Math.floor((p.x + w) / CHUNK), cy0 = Math.floor((p.y - w) / CHUNK), cy1 = Math.floor((p.y + w) / CHUNK);
    bakeMissing(cx0, cy0, cx1, cy1, 6);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const ch = chunks.get(chunkKey(cx, cy));
      if (chunkInBounds(cx, cy) && !(ch && ch.ready)) { setTimeout(warmGround, 16); return; }
    }
  }
  setTimeout(warmGround, 0);

  // The Adventure Zone is open exactly when the hut's Table & Stools (feature 'adventureZone') is owned, so the save
  // needs no flag of its own: loading a save that has the table opens it, buying the table opens it with a message.
  // Zone check: one rectangle test per frame. Enter only once the turtle is `hysteresis` px past the home square's
  // border, leave only once it is that far back inside, so hovering at the border can't flip the music back and forth.
  function updateZoneFlag() {
    const m = ADVENTURE.music.hysteresis, x = turtle.x, y = turtle.y;
    const now = inAdventure
      ? !(x >= m && x < WORLD_SIZE - m && y >= m && y < WORLD_SIZE - m)
      : (x < -m || x >= WORLD_SIZE + m || y < -m || y >= WORLD_SIZE + m);
    if (now === inAdventure) return;
    inAdventure = now;
    if (window.TT_SOUND) window.TT_SOUND.musicZone(now, ADVENTURE.music.fadeSeconds);
    if (now && gameTime - lastEnterHint > ADVENTURE.enterHintSeconds) { lastEnterHint = gameTime; showToast('Entering the Adventure Zone', 2400); }
  }
  function syncAdventureUnlock(announce) {
    if (adventureUnlocked || !Home.hasFeature('adventureZone')) return;
    setAdventureUnlocked(true);
    if (announce) { showToast('A new area has opened!', 4000); burstConfetti(turtle.x, turtle.y - 10); } // purchase.mp3 already plays with the buy
  }
  window.Progression.setUpgradeHandler(() => syncAdventureUnlock(true));

  // Opening/closing the Adventure Zone moves the playable edge (and its fog fringe), so chunks the fog touches
  // are re-baked; chunks well inside both rectangles are untouched.
  function setAdventureUnlocked(on) {
    on = !!on;
    if (on === adventureUnlocked) return;
    const old = { x0: bounds.x0, y0: bounds.y0, x1: bounds.x1, y1: bounds.y1 };
    adventureUnlocked = on;
    bounds.x0 = bounds.y0 = on ? WORLD_MIN : 0;
    bounds.x1 = bounds.y1 = on ? WORLD_MAX : WORLD_SIZE;
    const inside = (b, x0, y0) => x0 >= b.x0 + EDGE_FOG_WIDTH && y0 >= b.y0 + EDGE_FOG_WIDTH && x0 + CHUNK <= b.x1 - EDGE_FOG_WIDTH && y0 + CHUNK <= b.y1 - EDGE_FOG_WIDTH;
    for (const [key, ch] of chunks) if (!inside(old, ch.cx * CHUNK, ch.cy * CHUNK) || !inside(bounds, ch.cx * CHUNK, ch.cy * CHUNK)) dropChunk(key, ch);
    if (window.Enemies) window.Enemies.setAdventure(on);
    if (!on) clearAdvCoins();
    if (!on && chest.on) { chest.on = false; chest.left = ADVENTURE.chest.firstSpawnSeconds; } // locked: no chest (debug lock only; the table can't be un-bought)
    if (on) { startAdventureScenery(); if (window.TT_SOUND) window.TT_SOUND.musicPrepareAdventure(ADVENTURE.music.files); } // fetch the zone's first track once, now
    else if (inAdventure) { inAdventure = false; if (window.TT_SOUND) window.TT_SOUND.musicZone(false, ADVENTURE.music.fadeSeconds); }
    clampToWorld();
  }
  // ---- "Turtle Tides" written in the sand, south outer ring (the coastal sand band every biome's
  // mainland shore gets, see SHORE_SAND_BAND above) — a static decorative easter egg, not gameplay.
  // Position/zone constants live up top with SAND_TEXT_POS et al., ahead of shore/grass/scenery gen.
  const SAND_TEXT = 'TURTLE TIDES';
  const SAND_SUBTEXT = 'by Wesley Kopp';
  // A dug groove, not printed letters: a wide soft dark stroke (the shadowed underside of the
  // groove), then a thin bright stroke offset up-left (sand pushed up on the near edge), no fill.
  function strokeGroove(text, x, y, weight) {
    ctx.lineWidth = weight;
    ctx.strokeStyle = 'rgba(110, 82, 44, 0.55)';
    ctx.strokeText(text, x + 2, y + 2);
    ctx.lineWidth = Math.max(1, weight * 0.3);
    ctx.strokeStyle = 'rgba(255, 246, 224, 0.5)';
    ctx.strokeText(text, x - 1, y - 1);
  }
  function drawSandText() {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.font = 'italic 72px "Bradley Hand", "Comic Sans MS", cursive';
    strokeGroove(SAND_TEXT, SAND_TEXT_POS.x, SAND_TEXT_POS.y, 10);
    // Smaller subtitle needs a proportionally thinner groove, or the strokes swallow the letterforms.
    ctx.font = 'italic 32px "Bradley Hand", "Comic Sans MS", cursive';
    strokeGroove(SAND_SUBTEXT, SAND_SUBTEXT_POS.x, SAND_SUBTEXT_POS.y, 2);
    ctx.restore();
  }

  // ---- Home island detail: sand dunes — pre-rendered once to a small canvas (island-sized, not
  // world-sized) and stamped at the island's world position. Dune ("sand spot") positions are
  // randomized once and cached, so refreshIslandSand() (called once the sand3 tile image finishes
  // loading) can redraw the same layout with the tile pattern instead of re-rolling new positions. ----
  function buildIslandDetail(cached) {
    const pad = 80;
    const size = (ISLAND_R + pad) * 2;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    const cx = size / 2, cy = size / 2;

    // No base sand fill here: the terrain canvas now paints the island's ground color itself
    // (including its noisy shoreline blend), so this transparent layer only adds texture on top.

    // Dunes ("sand spots"): soft darker sand bumps, textured with the sand3 tile once it's loaded
    // (falls back to a flat color if this runs before the tile image finishes loading).
    const sandPattern = GROUND_TILES.sand3.canvas && g.createPattern(GROUND_TILES.sand3.canvas, 'repeat');
    const dunes = cached ? cached.dunes : [];
    if (!cached) {
      for (let i = 0, n = 0; n < 14 && i < 400; i++) {
        const ang = rand() * Math.PI * 2, rr = rand() * (ISLAND_R - 50);
        dunes.push({ x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr, rx: 26 + rand() * 16, ry: 10 + rand() * 6 });
        n++;
      }
    }
    for (const d of dunes) {
      g.beginPath(); g.ellipse(d.x, d.y, d.rx, d.ry, 0, 0, Math.PI * 2);
      if (sandPattern) {
        g.fillStyle = sandPattern; g.fill();
        g.fillStyle = 'rgba(120, 90, 40, 0.25)'; g.fill(); // darker tint so the bump still reads
      } else {
        g.fillStyle = '#e8d391'; g.fill();
      }
    }
    // TODO: tide pools and home rock pile removed per feedback; landmark art for home comes with upgrades.
    return { canvas: c, worldX: CENTER.x - cx, worldY: CENTER.y - cy, size, dunes };
  }
  let islandDetail = buildIslandDetail();
  function refreshIslandSand() { islandDetail = buildIslandDetail(islandDetail); }

  // ---- Mainland scenery: trees (all 4 biomes) and beach rocks are obstacles (trunk-only circle
  // collision); driftwood is decorative. Placed by dart-throwing so spacing stays natural, with a
  // per-biome minimum distance so the west forest reads dense but the east forest stays open. ----
  const SPACING = { forestThick: 145, forestOpen: 150, deadTrees: 140, beach: 170 };
  const scenery = [];       // { x, y, r, h, sprite, type, collide } — everything drawn
  const obstacleGrid = new Map(); // cell key -> array of scenery indices (collide only), filled as scenery is added
  const OBSTACLE_CELL = 220;
  const drawGrid = new Map();     // cell key -> scenery entries, so render() only visits cells in view instead of every entry
  const DRAW_CELL = 256;
  function addScenery(s) {
    const idx = scenery.length;
    scenery.push(s);
    if (s.collide) {
      const k = Math.floor(s.x / OBSTACLE_CELL) * 65536 + Math.floor(s.y / OBSTACLE_CELL);
      const a = obstacleGrid.get(k); if (a) a.push(idx); else obstacleGrid.set(k, [idx]);
    }
    const dk = Math.floor(s.x / DRAW_CELL) * 65536 + Math.floor(s.y / DRAW_CELL);
    const d = drawGrid.get(dk); if (d) d.push(s); else drawGrid.set(dk, [s]);
  }

  // Pixel-art scenery sprites (sliced from the reference sheet). Each entry is drawn `h` world-px
  // tall, scaled to its own aspect ratio. Collision uses the tight alpha bounding box computed below
  // (SPRITE_BBOX), not the full padded square each source image ships as, so the turtle's hitbox
  // matches the visible art instead of the transparent margin around it.
  const SPRITES = {};
  // name -> { x0, y0, x1, y1 } normalized (0..1) tight box of non-transparent pixels, in the sprite's
  // own natural-pixel space. Computed once per image on load by computeSpriteBBox(); until it's
  // ready, collision falls back to the old r/cr circle on that scenery entry.
  const SPRITE_BBOX = {};
  const ALPHA_THRESHOLD = 10; // pixels with alpha <= this count as transparent padding
  // Reused across all bbox scans — never drawn to the page, just read back with getImageData.
  const bboxScanCanvas = document.createElement('canvas');
  function computeSpriteBBox(img, name) {
    const w = img.naturalWidth, h = img.naturalHeight;
    bboxScanCanvas.width = w; bboxScanCanvas.height = h;
    const g = bboxScanCanvas.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, w, h);
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > ALPHA_THRESHOLD) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    // Fully-transparent image (shouldn't happen for real art) — fall back to the full frame.
    SPRITE_BBOX[name] = maxX < minX
      ? { x0: 0, y0: 0, x1: 1, y1: 1 }
      : { x0: minX / w, y0: minY / h, x1: (maxX + 1) / w, y1: (maxY + 1) / h };
  }
  // Optional per-sprite manual override, in world px, applied after the alpha bbox is scaled to the
  // sprite's drawn size — shrinks (positive) or grows (negative) each edge for fine-tuning a hitbox
  // that still feels off after the automatic trim (e.g. a sprite with faint anti-aliased fringe
  // pixels just above the alpha threshold). Empty by default.
  const HITBOX_INSET = {
    // driftwood_stick: { left: 4, right: 4, top: 2, bottom: 2 },
  };
  let scenerySpritesLeft = 0; // start() waits on this so trees are already there on the first frame
  for (const name of ['pine_tall', 'oak_tree', 'tree_cluster3', 'round_tree_med', 'round_tree_single',
    'pine_sapling', 'dead_tree_med', 'dead_tree_small', 'round_tree_small',
    'driftwood_stick', 'sandcastle_big', 'sandpile', 'rock_beach']) {
    const img = new Image();
    scenerySpritesLeft++;
    img.onload = () => { computeSpriteBBox(img, name); scenerySpritesLeft--; };
    img.onerror = () => { scenerySpritesLeft--; };
    img.src = `assets/scenery/${name}.png`;
    SPRITES[name] = img;
  }
  // Per-biome tree sprite choices, weighted toward the look each biome calls for.
  const BIOME_TREES = {
    forestThick: [{ sprite: 'pine_tall', h: 190 }, { sprite: 'tree_cluster3', h: 150 }, { sprite: 'pine_sapling', h: 110 }],
    forestOpen: [{ sprite: 'oak_tree', h: 140 }, { sprite: 'round_tree_med', h: 115 }, { sprite: 'round_tree_single', h: 110 }],
    deadTrees: [{ sprite: 'dead_tree_med', h: 115 }, { sprite: 'dead_tree_small', h: 95 }],
  };
  function pickTree(biome, rnd = rand) {
    const opts = BIOME_TREES[biome];
    return opts[Math.floor(rnd() * opts.length)];
  }

  // World-space trunk polygon for a circleOnly scenery entry that carries `s.poly` (currently just
  // tree_cluster3 — see the circleOnly comment at placement): an array of {dx, dy} points relative
  // to the sprite's anchor (dx right, dy up), one hitbox shape covering all 3 trunks instead of a
  // circle per trunk.
  function getTrunkPolygon(s) {
    return s.poly.map(p => ({ x: s.x + p.dx, y: s.y + p.dy }));
  }

  // Push circle (cx, cy, radius) out of convex polygon `poly` ({x,y}[], any winding), in place on
  // the passed mutable point `out`. Used for the tree-cluster trunk hitbox above, where a single
  // circle doesn't cover the 3-trunk footprint well.
  function pushCircleOutOfPolygon(out, radius, poly) {
    const n = poly.length;
    // Consistent-winding test: a convex polygon's cross product sign is the same at every vertex
    // for a point strictly inside it.
    let inside = true, sign = 0;
    let closest = null, closestDistSq = Infinity;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const ex = b.x - a.x, ey = b.y - a.y;
      const cross = ex * (out.y - a.y) - ey * (out.x - a.x);
      if (i === 0) sign = Math.sign(cross);
      else if (cross !== 0 && Math.sign(cross) !== sign) inside = false;
      // Closest point on this edge segment to `out`, for both the inside and outside cases below.
      const len2 = ex * ex + ey * ey;
      let t = len2 > 0 ? ((out.x - a.x) * ex + (out.y - a.y) * ey) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + ex * t, py = a.y + ey * t;
      const distSq = (out.x - px) ** 2 + (out.y - py) ** 2;
      if (distSq < closestDistSq) { closestDistSq = distSq; closest = { x: px, y: py }; }
    }
    if (!closest) return;
    const dist = Math.sqrt(closestDistSq);
    if (inside) {
      // Center is inside the triangle (fast movement / corner case): eject it out past the nearest
      // edge plus the radius, in the direction from that edge point toward the center.
      const dx = out.x - closest.x, dy = out.y - closest.y;
      const d = dist || 0.001;
      out.x = closest.x + (dx / d) * (dist + radius);
      out.y = closest.y + (dy / d) * (dist + radius);
    } else if (dist < radius) {
      const dx = out.x - closest.x, dy = out.y - closest.y;
      const d = dist || 0.001;
      out.x = closest.x + (dx / d) * radius;
      out.y = closest.y + (dy / d) * radius;
    }
  }

  // World-space AABB for one scenery sprite's tight alpha bbox, matching exactly how
  // drawScenerySprite() below places it (same dw/dh math, same base-anchored origin) — so the
  // hitbox tracks the visible art regardless of each entry's own `h` (trees vary per instance) or
  // aspect ratio. Returns null if the bbox isn't computed yet (image still loading); callers fall
  // back to the entry's r/cr circle in that case.
  function getSpriteWorldBox(s) {
    if (s.circleOnly) return null; // trees: trunk-base circle only, see the circleOnly comment at placement
    const img = SPRITES[s.sprite];
    const bbox = SPRITE_BBOX[s.sprite];
    if (!img || !bbox || !img.complete || !img.naturalWidth) return null;
    const dh = s.h, dw = dh * (img.naturalWidth / img.naturalHeight);
    const originX = s.x - dw / 2, originY = s.y - dh; // drawImage's top-left, see drawScenerySprite()
    const inset = HITBOX_INSET[s.sprite] || {};
    return {
      x0: originX + bbox.x0 * dw + (inset.left || 0),
      x1: originX + bbox.x1 * dw - (inset.right || 0),
      y0: originY + bbox.y0 * dh + (inset.top || 0),
      y1: originY + bbox.y1 * dh - (inset.bottom || 0),
    };
  }

  // Dart-throws scenery over the square [lo, lo + span)^2, in slices (run(n) = n more throws, true when finished).
  // The home pass uses the game's seeded rand() over the original map, once at load, so its layout never
  // changes. The adventure pass uses its own seeded rng over the whole enlarged map minus the home square, and
  // only runs once the zone has been unlocked.
  function makeScenePlacer(o) {
    const placedGrid = new Map(); // build-time spacing check only
    const cellKey = (x, y, size) => `${Math.floor(x / size)},${Math.floor(y / size)}`;
    function tooClose(x, y, minDist) {
      const cx = Math.floor(x / minDist), cy = Math.floor(y / minDist);
      for (let gy = cy - 1; gy <= cy + 1; gy++) for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const arr = placedGrid.get(`${gx},${gy}`);
        if (!arr) continue;
        for (const p of arr) if (Math.hypot(p.x - x, p.y - y) < minDist) return true;
      }
      return false;
    }
    function markPlaced(x, y, minDist) {
      const k = cellKey(x, y, minDist);
      if (!placedGrid.has(k)) placedGrid.set(k, []);
      placedGrid.get(k).push({ x, y });
    }
    const rnd = o.rnd;
    if (o.seedNearHome) { // keep the new pass spaced from the home zone's outermost scenery too
      for (const s of scenery) {
        if (s.x > -300 && s.x < WORLD_SIZE + 300 && s.y > -300 && s.y < WORLD_SIZE + 300) markPlaced(s.x, s.y, SPACING[dominantBiome(s.x, s.y).biome]);
      }
    }
    function attempt() {
      const x = o.lo + rnd() * o.span, y = o.lo + rnd() * o.span;
      if (o.skip && o.skip(x, y)) return;
      const dist = Math.hypot(x - CENTER.x, y - CENTER.y);
      if (dist <= WATER_OUTER_R + 20) return;               // never on the island or in the water
      if (dist > o.maxR) return;                            // keep the far fog fringe emptier
      if (o.edge && (x < WORLD_MIN + o.edge || x > WORLD_MAX - o.edge || y < WORLD_MIN + o.edge || y > WORLD_MAX - o.edge)) return; // square worlds: fog margin instead of a circle
      if (inSandTextZone(x, y)) return;                     // keep the sand-text patch clear of scenery
      const { biome, weight } = dominantBiome(x, y);
      if (weight < 0.55) return; // blend zone between two biomes: leave it sparser/transitional
      const spacing = SPACING[biome];
      if (tooClose(x, y, spacing)) return;
      markPlaced(x, y, spacing);

      if (biome === 'beach' && rnd() < 0.1) {
        addScenery({ x, y, r: 34, cr: 36, type: 'sprite', sprite: 'rock_beach', h: 76, collide: true });
      } else if (biome === 'beach' && rnd() < 0.14) {
        addScenery({ x, y, r: 12, cr: 18, type: 'sprite', sprite: 'driftwood_stick', h: 60, collide: true });
      } else if (biome === 'beach' && (rnd(), Math.random() < 0.06)) { // unseeded roll: castles land on different beach spots each load (rnd() kept so tree layout is unchanged)
        // rare beach flourish, straight off the reference sheet. knockable: turtle bumping into it
        // flattens it into a walkable rubble pile — see resolveObstacleCollisions/drawScenerySprite.
        addScenery({ x, y, r: 24, cr: 38, type: 'sprite', sprite: 'sandcastle_big', h: 90, collide: true, knockable: true, knocked: false });
      } else if (biome === 'beach') {
        // none of the beach rolls hit for this spot: leave it bare sand, no tree fallback
      } else if (shoreSignedDist(x, y).d > SHORE_SAND_BAND) {
        // Inside the mainland's outer sand ring (every coastline gets one, not just the beach
        // biome) — leave it bare, no trees on sand.
      } else {
        const t = pickTree(biome, rnd);
        const r = biome === 'forestThick' ? 14 : 12;
        // Trees always collide as a small circle at the trunk's base, not the sprite's full alpha
        // bbox — circleOnly skips the tight-bbox hitbox in resolveObstacleCollisions/debug draw
        // below, so the turtle can walk behind the canopy and only bumps where the trunk meets the
        // ground. cy nudges the circle's center up a bit above the anchor point (y), which reads
        // more like the actual trunk width than one centered right at the ground contact line.
        // tree_cluster3 is 3 trunks side by side, not 1 — gets a single triangular `poly` hitbox
        // (see getTrunkPolygon/pushCircleOutOfPolygon) instead of the single cr/cy circle every
        // other tree uses, point facing down toward the sprite's anchor.
        const entry = { x, y, r, type: 'sprite', sprite: t.sprite, h: t.h * (0.85 + rnd() * 0.3), collide: true, circleOnly: true };
        if (t.sprite === 'tree_cluster3') {
          entry.poly = [
            { dx: 0, dy: -r * 1.0 },        // bottom point, facing down toward the anchor
            { dx: -r * 4.1, dy: -r * 4.5 }, // top-left corner of the base
            { dx: r * 4.1, dy: -r * 4.5 },  // top-right corner of the base
          ];
        } else {
          entry.cr = r * 1.15;
          entry.cy = -r * 0.9;
        }
        addScenery(entry);
      }
    }
    let done = 0;
    return { run(n) { const end = Math.min(o.attempts, done + n); for (; done < end; done++) attempt(); return done >= o.attempts; } };
  }
  makeScenePlacer({ rnd: rand, lo: 0, span: WORLD_SIZE, attempts: 30000, maxR: WORLD_SIZE / 2 - EDGE_FOG_WIDTH * 0.4 }).run(30000);

  // Adventure Zone scenery: same rules and density as the home zone, generated in slices the first time the zone
  // opens (a locked game never pays for it), then it stays — the zone's layout is the same every load.
  let adventureSceneryStarted = false;
  function startAdventureScenery() {
    if (adventureSceneryStarted) return;
    adventureSceneryStarted = true;
    let seed = ADVENTURE.seed;
    const span = WORLD_MAX - WORLD_MIN;
    const placer = makeScenePlacer({
      rnd: () => (seed = (seed * 16807) % 2147483647) / 2147483647,
      lo: WORLD_MIN, span, attempts: Math.round(30000 * (span / WORLD_SIZE) ** 2), maxR: Infinity, edge: EDGE_FOG_WIDTH * 0.4, // square world: fill the corners too
      skip: inHomeZone, seedNearHome: true,
    });
    (function step() { if (!placer.run(1500)) setTimeout(step, 0); })();
  }


  const nearbyBuf = []; // reused every call; callers only iterate it before the next call
  function nearbyObstacles(x, y, radius, tight) {
    const out = nearbyBuf; out.length = 0;
    const cx = Math.floor(x / OBSTACLE_CELL), cy = Math.floor(y / OBSTACLE_CELL);
    const span = Math.ceil(radius / OBSTACLE_CELL) + (tight ? 0 : 1); // tight: 3x3 cells instead of 5x5 (enemies call this many times a frame)
    for (let gy = cy - span; gy <= cy + span; gy++) for (let gx = cx - span; gx <= cx + span; gx++) {
      const arr = obstacleGrid.get(gx * 65536 + gy);
      if (arr) for (const idx of arr) out.push(scenery[idx]);
    }
    return out;
  }

  // Resolve turtle-vs-obstacle collision by pushing the turtle's body circle out of each obstacle's
  // tight alpha-bbox rectangle (see getSpriteWorldBox) along the shortest contact vector — standard
  // closest-point circle-vs-AABB. Falls back to the old circle-vs-circle test (using the entry's r/cr)
  // for a sprite whose bbox hasn't finished loading yet, so nothing is collision-free on first frame.
  function resolveObstacleCollisions() {
    for (const s of nearbyObstacles(turtle.x, turtle.y, TURTLE_RADIUS + 60)) {
      if (!s.collide) continue; // e.g. a sandcastle already knocked flat — walk right over it
      if (s.knockable && !s.knocked) {
        const dx0 = turtle.x - s.x, dy0 = turtle.y - s.y;
        const dist0 = Math.hypot(dx0, dy0);
        // Hit test uses the sprite's bbox (any side, incl. behind/top) with the base circle as fallback.
        const kb = getSpriteWorldBox(s);
        const hit = kb
          ? Math.hypot(turtle.x - Math.min(Math.max(turtle.x, kb.x0), kb.x1), turtle.y - Math.min(Math.max(turtle.y, kb.y0), kb.y1)) < TURTLE_BODY_RADIUS
          : dist0 < TURTLE_BODY_RADIUS + s.cr;
        if (hit) {
          // First bump knocks it down: swap to the rubble pile, stop colliding, and give the turtle
          // a little kickback + screen shake so the impact reads before it walks on through.
          s.knocked = true;
          window.Progression.addStat('castles');
          s.knockedAt = gameTime;
          s.collide = false;
          const nx = dist0 > 0.001 ? dx0 / dist0 : 0, ny = dist0 > 0.001 ? dy0 / dist0 : -1;
          turtle.x += nx * KNOCKBACK_DIST;
          turtle.y += ny * KNOCKBACK_DIST;
          triggerShake(6, 0.25);
          spawnSandPuff(s.x, s.y);
          if (window.TT_SOUND) window.TT_SOUND.sand();
          if (Math.random() < CASTLE_COIN_CHANCE) coinPickups.dropAt(s.x, s.y + 30); // coinPickups is defined later but only used at runtime
          continue;
        }
      }
      const box = getSpriteWorldBox(s);
      if (!box) {
        if (s.poly) {
          const out = { x: turtle.x, y: turtle.y };
          pushCircleOutOfPolygon(out, TURTLE_BODY_RADIUS, getTrunkPolygon(s));
          turtle.x = out.x; turtle.y = out.y;
          continue;
        }
        const dx = turtle.x - s.x, dy = turtle.y - (s.y + (s.cy || 0));
        const minDist = TURTLE_BODY_RADIUS + (s.cr ?? s.r);
        const dist = Math.hypot(dx, dy) || 0.001;
        if (dist < minDist) {
          const push = (minDist - dist) / dist;
          turtle.x += dx * push;
          turtle.y += dy * push;
        }
        continue;
      }
      const closestX = Math.min(Math.max(turtle.x, box.x0), box.x1);
      const closestY = Math.min(Math.max(turtle.y, box.y0), box.y1);
      let dx = turtle.x - closestX, dy = turtle.y - closestY;
      let dist = Math.hypot(dx, dy);
      if (dist >= TURTLE_BODY_RADIUS) continue;
      if (dist < 0.001) {
        // Turtle center is inside the box (rare — fast movement/corner case): push out along
        // whichever edge is closest rather than leaving the push direction undefined.
        const penLeft = turtle.x - box.x0, penRight = box.x1 - turtle.x;
        const penTop = turtle.y - box.y0, penBottom = box.y1 - turtle.y;
        const minPen = Math.min(penLeft, penRight, penTop, penBottom);
        dx = minPen === penLeft ? -1 : minPen === penRight ? 1 : 0;
        dy = minPen === penTop ? -1 : minPen === penBottom ? 1 : 0;
        dist = 1;
      }
      const push = (TURTLE_BODY_RADIUS - dist) / dist;
      turtle.x += dx * push;
      turtle.y += dy * push;
    }
  }

  // Read-only "would a circle at (x, y) with radius r overlap any obstacle?" for enemies. Same shapes
  // resolveObstacleCollisions() uses, but returns a boolean, never moves anything, and allocates
  // nothing per call (scenery is static, so each entry's box/polygon is cached on first use).
  function blockedAt(x, y, r) {
    const r2 = r * r;
    for (const s of nearbyObstacles(x, y, r + 60, true)) {
      if (!s.collide) continue;
      let box = s._eBox;
      if (box === undefined) { box = getSpriteWorldBox(s); if (box) s._eBox = box; }
      if (box) {
        const dx = x - Math.min(Math.max(x, box.x0), box.x1), dy = y - Math.min(Math.max(y, box.y0), box.y1);
        if (dx * dx + dy * dy < r2) return true;
        continue;
      }
      if (s.poly) {
        const poly = s._ePoly || (s._ePoly = getTrunkPolygon(s));
        // Convex polygon vs circle: center inside (same cross-product sign at every edge) or within r of an edge.
        let inside = true, sign = 0;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          const ex = b.x - a.x, ey = b.y - a.y;
          const cross = ex * (y - a.y) - ey * (x - a.x);
          if (i === 0) sign = Math.sign(cross); else if (cross !== 0 && Math.sign(cross) !== sign) inside = false;
          const len2 = ex * ex + ey * ey;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey) / len2)) : 0;
          const px = x - (a.x + ex * t), py = y - (a.y + ey * t);
          if (px * px + py * py < r2) return true;
        }
        if (inside) return true;
        continue;
      }
      const dx = x - s.x, dy = y - (s.y + (s.cy || 0)), m = r + (s.cr ?? s.r);
      if (dx * dx + dy * dy < m * m) return true;
    }
    return false;
  }

  // ---- Debug: red hitbox outlines (DEBUG_HITBOXES above). Drawn in the same world-transformed
  // context render() already sets up, right after scenery, so outlines line up with the art exactly.
  function drawDebugHitboxes(visibleScenery) {
    ctx.save();
    ctx.strokeStyle = 'red';
    ctx.lineWidth = 1.5;
    for (const s of visibleScenery) {
      if (!s.collide) continue;
      const box = getSpriteWorldBox(s);
      if (box) {
        ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      } else if (s.poly) {
        const pts = getTrunkPolygon(s);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(s.x, s.y + (s.cy || 0), s.cr ?? s.r, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.beginPath(); ctx.arc(turtle.x, turtle.y, TURTLE_BODY_RADIUS, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // Depth-sorts the turtle in with visible scenery by y so tall sprites (trees) draw over the
  // turtle when its anchor point is above their base — i.e. the turtle can duck behind the
  // canopy — while collision (much smaller `cr` radius) still stops it at the trunk itself.
  // Scenery sprites are anchored at their base (y = ground contact, art only extends upward from
  // there), but the turtle sprite is centered on turtle.y (it extends both above and below it), so
  // comparing turtle.y directly understates how far forward the turtle's visible body actually
  // reaches. TURTLE_DEPTH_FRONT_OFFSET compensates so the turtle reliably draws on top once it's
  // really in front of an asset's base, instead of a sliver of canopy/trunk art still covering it.
  const TURTLE_DEPTH_FRONT_OFFSET = 24;
  const byY = (a, b) => a.y - b.y;
  function drawSceneryWithTurtle(list) {
    list.sort(byY); // cheap back-to-front depth sort of the (small) visible set
    // Knocked-down sand piles are flat on the ground: always draw them under the turtle, never over it.
    for (const s of list) if (s.knocked) drawScenerySprite(s);
    const turtleDepthY = turtle.y + TURTLE_DEPTH_FRONT_OFFSET;
    let drawnTurtle = false;
    for (const s of list) {
      if (s.knocked) continue;
      if (!drawnTurtle && turtleDepthY < s.y) { drawTurtle(); drawnTurtle = true; }
      drawScenerySprite(s);
    }
    if (!drawnTurtle) drawTurtle();
    drawSandPuffs();
  }

  // Sand puff when a castle collapses: a few tan blobs that drift outward, rise, and fade.
  const sandPuffs = [];
  function spawnSandPuff(x, y) {
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, sp = 30 + Math.random() * 60;
      sandPuffs.push({ x: x + (Math.random() - 0.5) * 30, y: y - 10 - Math.random() * 40,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.5 - 20, r: 8 + Math.random() * 10, t: 0, life: 0.6 + Math.random() * 0.3 });
    }
  }
  function updateSandPuffs(dt) {
    for (let i = sandPuffs.length - 1; i >= 0; i--) {
      const p = sandPuffs[i];
      p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy *= 0.96;
      if (p.t >= p.life) sandPuffs.splice(i, 1);
    }
  }
  function drawSandPuffs() {
    for (const p of sandPuffs) {
      const k = p.t / p.life;
      ctx.globalAlpha = 0.7 * (1 - k);
      ctx.fillStyle = '#e8d3a0';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + k * 0.8), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawScenerySprite(s) {
      if (s.knocked) {
        // Sand pile left behind once the turtle bumps a sandcastle — walkable (see resolveObstacleCollisions).
        const pile = SPRITES.sandpile;
        if (gameTime - s.knockedAt > PILE_LIFETIME) return; // pile has vanished
        if (pile.complete && pile.naturalWidth) ctx.drawImage(pile, s.x - 28, s.y - 50, 56, 56); // sizes are a guess
        return;
      }
      if (s.type === 'sprite') {
        const img = SPRITES[s.sprite];
        if (!img.complete || !img.naturalWidth) return; // not loaded yet; skip a frame rather than block
        const dh = s.h, dw = dh * (img.naturalWidth / img.naturalHeight);
        // Anchor the sprite's base (trunk/foot) at (x, y) — the same point used for collision.
        ctx.drawImage(img, s.x - dw / 2, s.y - dh, dw, dh);
      } else if (s.type === 'rock') {
        ctx.fillStyle = '#8a8a8f'; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#a7a7ac'; ctx.beginPath(); ctx.arc(s.x - s.r * 0.3, s.y - s.r * 0.3, s.r * 0.5, 0, Math.PI * 2); ctx.fill();
      } else if (s.type === 'palm') {
        ctx.fillStyle = '#7a5a34'; ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#3f9a45';
        for (let a = 0; a < 6; a++) {
          ctx.beginPath();
          ctx.ellipse(s.x + Math.cos(a * 1.05) * 16, s.y + Math.sin(a * 1.05) * 16, 18, 6, a * 1.05, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (s.type === 'custom') {
        s.draw(ctx, s.x, s.y);
      }
  }

  // ---- Day/Night toggle (L7 skill, see progression.js CONFIG/state.isNight) ----
  // nightAmount eases toward the target over NIGHT_FADE_SPEED (full fade takes ~1/NIGHT_FADE_SPEED
  // seconds) so flipping the toggle fades the sky/glow rather than cutting hard, per the spec.
  let nightAmount = 0;
  const NIGHT_FADE_SPEED = 0.5; // fraction of the fade per second
  function updateNightFade(dt) {
    const target = window.Progression.state.isNight ? 1 : 0;
    if (nightAmount < target) nightAmount = Math.min(target, nightAmount + NIGHT_FADE_SPEED * dt);
    else if (nightAmount > target) nightAmount = Math.max(target, nightAmount - NIGHT_FADE_SPEED * dt);
  }

  function drawNightSky() {
    if (nightAmount <= 0.001) return;
    ctx.save();
    ctx.fillStyle = `rgba(6, 14, 30, ${0.55 * nightAmount})`;
    ctx.fillRect(0, 0, viewW, viewH);
    ctx.restore();
  }

  // ---- Collectible pickups: coins (currency), coconuts (food), and finds (the 25 collectibles) — all placed
  // and animated the same way (dart-thrown across land, never water; bob + respawn after pickup),
  // so makePickupType() below is shared by all three instead of copy-pasting per item. Pickups route
  // through window.Progression.tryPickup(), which gates them on hull capacity (MDD s4) — an item
  // stays on the ground (not consumed) if the hull is full. Each find pickup rolls which of the 25 it is
  // (by rarity, see progression.js CONFIG.finds) when placed and again each time it respawns.
  let gameTime = 0, lastBumpHint = -1e9, lastEnterHint = -1e9;

  // Picks a random spot that's not in water and not on the sand-text patch. Shared by every pickup
  // type for both initial placement and respawning.
  function randomLandSpot() {
    let x = CENTER.x, y = CENTER.y;
    for (let i = 0; i < 200; i++) {
      x = Math.random() * WORLD_SIZE; // unseeded so pickup spots differ every load
      y = Math.random() * WORLD_SIZE;
      const distFromCenter = Math.hypot(x - CENTER.x, y - CENTER.y);
      if (distFromCenter > WORLD_SIZE / 2 - EDGE_FOG_WIDTH * 0.4) continue; // keep clear of the far fog fringe
      if (isWater(x, y)) continue;
      if (inSandTextZone(x, y)) continue;
      break;
    }
    return { x, y };
  }

  // Small banner at the top of the screen; replaces any toast still showing.
  let toastEl = null, toastTimer = 0;
  function showToast(text, ms = 2200) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'discovery-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.remove('show');
    void toastEl.offsetWidth; // restart the animation
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }
  function showDiscoveryToast(name) { showToast('New find: ' + name + '!'); }
  function makePickupType(key, opts) {
    const items = [];
    function respawn(it) {
      const p = randomLandSpot();
      it.x = p.x; it.y = p.y; it.active = true;
      if (opts.pickKind) it.kind = opts.pickKind();
    }
    // opts.pool: that many idle slots instead of randomly placed ones (they're filled and recycled by game code, see updateAdvCoins)
    for (let i = 0; i < (opts.pool || 0); i++) items.push({ x: 0, y: 0, active: false, respawnAt: Infinity, bobSeed: i * 0.7, kind: 0 });
    for (let i = 0; i < opts.count; i++) {
      const p = randomLandSpot();
      items.push({ x: p.x, y: p.y, active: true, respawnAt: 0, bobSeed: rand() * Math.PI * 2, kind: opts.pickKind ? opts.pickKind() : 0 });
    }
    // One-off bonus pickup dropped at a spot (e.g. from a knocked-down sandcastle); removed once taken.
    function dropAt(x, y, kind = 0) {
      items.push({ x, y, active: true, respawnAt: 0, bobSeed: Math.random() * Math.PI * 2, temp: true, popAt: gameTime, kind });
    }
    // Hop arc for a dropped item: a high launch, then a smaller bounce, then rest (0 = landed).
    const POP_DUR1 = 0.7, POP_DUR2 = 0.35, POP_H1 = 110, POP_H2 = 28;
    function popHeight(it) {
      const t = gameTime - it.popAt;
      if (t < POP_DUR1) { const u = t / POP_DUR1; return POP_H1 * 4 * u * (1 - u); }
      if (t < POP_DUR1 + POP_DUR2) { const u = (t - POP_DUR1) / POP_DUR2; return POP_H2 * 4 * u * (1 - u); }
      return 0;
    }
    function update() {
      const pickupDist = TURTLE_BODY_RADIUS + opts.pickupRadius, pickupDist2 = pickupDist * pickupDist;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (!it.active) {
          if (gameTime >= it.respawnAt) respawn(it);
          continue;
        }
        if (it.popAt !== undefined && popHeight(it) > 0) continue; // can't grab it mid-hop
        const dx = turtle.x - it.x, dy = turtle.y - it.y;
        if (dx * dx + dy * dy < pickupDist2) {
          const P = window.Progression;
          // First-ever find of this kind = not banked in the collection and not already carried this trip.
          const foundItem = key === 'finds' ? P.FINDS.items[it.kind] : null;
          const isNew = foundItem && !P.state.collection[foundItem.id] && !P.state.carriedFinds.includes(foundItem.id);
          if (P.tryPickup(key, it.kind)) {
            if (isNew) showDiscoveryToast(foundItem.name);
            if (key === 'coconuts' && window.TT_SOUND) window.TT_SOUND.coconut();
            if (key === 'coins' && window.TT_SOUND) window.TT_SOUND.coin();
            if (key === 'finds' && window.TT_SOUND) window.TT_SOUND.shell();
            if (window.TT_HAPTIC) window.TT_HAPTIC();
            it.active = false;
            it.respawnAt = gameTime + opts.respawnSeconds;
            if (it.temp) items.splice(i, 1);
          }
          // else: hull is full — leave it active on the ground, Progression flashes the hull-full cue
        }
      }
    }
    function draw() {
      const vw = viewW / ZOOM, vh = viewH / ZOOM, margin = 60;
      for (const it of items) {
        if (!it.active) continue;
        if (it.x < camX - margin || it.x > camX + vw + margin || it.y < camY - margin || it.y > camY + vh + margin) continue;
        const bob = Math.sin(gameTime * opts.bobSpeed + it.bobSeed) * opts.bobAmplitude;
        // Assumes the pickup's own shadow was too faint to read: darker/wider, and it shrinks as the item hops up.
        const hopH = it.popAt !== undefined ? popHeight(it) : 0;
        ctx.globalAlpha = 0.45 * (1 - Math.min(hopH, 110) / 220);
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.ellipse(it.x, it.y + 22, opts.drawH * 0.4 * (1 - hopH / 400), opts.drawH * 0.18 * (1 - hopH / 400), 0, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1; // no save/restore needed: only alpha + fillStyle changed
        const hop = it.popAt !== undefined ? popHeight(it) : 0;
        opts.drawItem(it.x, it.y + (hop > 0 ? -hop : bob), it);
      }
    }
    return { update, draw, dropAt, items };
  }

  const coinImg = new Image();
  coinImg.src = 'assets/items/coin.png';
  const COIN_OPTS = {
    count: 60, pickupRadius: 26, respawnSeconds: 20, drawH: 30, bobSpeed: 2.4, bobAmplitude: 6,
    drawItem(cx, cy) {
      if (!coinImg.complete || !coinImg.naturalWidth) return;
      const dw = 30 * coinImg.naturalWidth / coinImg.naturalHeight;
      ctx.drawImage(coinImg, cx - dw / 2, cy - 15, dw, 30);
    },
  };
  const coinPickups = makePickupType('coins', COIN_OPTS);
  const coconutImg = new Image();
  coconutImg.src = 'assets/items/coconut.png';
  const coconutPickups = makePickupType('coconuts', {
    count: 16, pickupRadius: 24, respawnSeconds: 26, drawH: 26, bobSpeed: 2.0, bobAmplitude: 5,
    drawItem(cx, cy) {
      if (!coconutImg.complete || !coconutImg.naturalWidth) return;
      const dh = 30, dw = dh * coconutImg.naturalWidth / coconutImg.naturalHeight;
      ctx.drawImage(coconutImg, cx - dw / 2, cy - dh / 2, dw, dh);
    },
  });
  // The 25 finds: one 5x5 sprite sheet (64px cells, in progression.js CONFIG.finds order); `it.kind` is
  // the cell index. Drawn crisp (smoothing off) since it's pixel art.
  const FINDS = window.Progression.FINDS;
  const findsImg = new Image();
  findsImg.src = FINDS.sheet;
  const FIND_DRAW = 46; // world px
  const findPickups = makePickupType('finds', {
    count: 10, pickupRadius: 24, respawnSeconds: 26, drawH: 28, bobSpeed: 2.2, bobAmplitude: 5,
    pickKind: window.Progression.randomFindIndex,
    drawItem(cx, cy, it) {
      if (!findsImg.complete || !findsImg.naturalWidth) return;
      const c = FINDS.cell;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(findsImg, (it.kind % FINDS.cols) * c, Math.floor(it.kind / FINDS.cols) * c, c, c, cx - FIND_DRAW / 2, cy - FIND_DRAW / 2, FIND_DRAW, FIND_DRAW);
      ctx.imageSmoothingEnabled = true;
    },
  });

  // ---- Adventure Zone coins: the same coin pickup (same art, pickup rules and hull gate), but as a fixed pool that is
  // kept topped up around the turtle instead of one coin per spot forever: only coins near the turtle exist, and
  // they're recycled once it has moved on. Target count = the home zone's coin density x ADVENTURE.coins.densityMult
  // over the area being kept populated; nothing exists while the zone is locked.
  const advCoins = makePickupType('coins', Object.assign({}, COIN_OPTS, { count: 0, pool: ADVENTURE.coins.maxActive, respawnSeconds: Infinity }));
  // Home coin density: coins per px^2 of the land they're scattered over (the walkable circle minus the water ring).
  const HOME_COIN_R = WORLD_SIZE / 2 - EDGE_FOG_WIDTH * 0.4;
  const HOME_COIN_DENSITY = coinPickups.items.length / (Math.PI * (HOME_COIN_R * HOME_COIN_R - (WATER_OUTER_R * WATER_OUTER_R - ISLAND_R * ISLAND_R)));
  let advCoinTimer = 0, advCoinWant = 0, advCoinLive = 0;
  function updateAdvCoins(dt) {
    if (!adventureUnlocked) return;
    advCoinTimer += dt;
    if (advCoinTimer < ADVENTURE.coins.tickSeconds) return;
    advCoinTimer = 0;
    const C = ADVENTURE.coins, items = advCoins.items;
    const rIn = Math.hypot(viewW, viewH) / ZOOM / 2 + 60, rOut = rIn + C.ringWidth, drop2 = (rOut * 1.15) ** 2; // just off-screen .. kept-populated radius
    let live = 0;
    for (let i = 0; i < items.length; i++) { // trim coins the turtle has left far behind (frees their slots)
      const it = items[i];
      if (!it.active) continue;
      const dx = it.x - turtle.x, dy = it.y - turtle.y;
      if (dx * dx + dy * dy > drop2) it.active = false; else live++;
    }
    // Only the part of the kept-populated circle where coins can actually appear counts toward the target (not the home
    // zone half of it when the turtle is at the border, nor the fog fringe), so density stays the same everywhere. The
    // share is estimated from a coarse grid of points, a few hundred cheap checks per top-up.
    let inDisc = 0, valid = 0;
    const GRID = 16, step = rOut * 2 / GRID, rOut2 = rOut * rOut;
    for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
      const px = turtle.x - rOut + (gx + 0.5) * step, py = turtle.y - rOut + (gy + 0.5) * step;
      if ((px - turtle.x) ** 2 + (py - turtle.y) ** 2 > rOut2) continue;
      inDisc++;
      if (!inHomeZone(px, py) && px > WORLD_MIN + C.edgeMargin && px < WORLD_MAX - C.edgeMargin && py > WORLD_MIN + C.edgeMargin && py < WORLD_MAX - C.edgeMargin) valid++;
    }
    const want = inDisc ? Math.min(items.length, Math.round(HOME_COIN_DENSITY * C.densityMult * Math.PI * rOut2 * valid / inDisc)) : 0;
    advCoinWant = want;
    if (live < want) {
      // Empty pool (just entered / warped): fill the whole area in one go, on-screen included. Otherwise new coins
      // appear only in the off-screen ring, a few per tick, so nothing pops in view.
      const fresh = live === 0, budget = fresh ? want : C.spawnsPerTick, lo2 = fresh ? 0 : rIn * rIn;
      let made = 0;
      for (let i = 0; i < items.length && made < budget && live < want; i++) {
        const it = items[i];
        if (it.active) continue;
        for (let a = 0; a < 8; a++) {
          const ang = Math.random() * Math.PI * 2, r = Math.sqrt(lo2 + Math.random() * (rOut * rOut - lo2));
          const x = turtle.x + Math.cos(ang) * r, y = turtle.y + Math.sin(ang) * r;
          if (inHomeZone(x, y) || x < WORLD_MIN + C.edgeMargin || x > WORLD_MAX - C.edgeMargin || y < WORLD_MIN + C.edgeMargin || y > WORLD_MAX - C.edgeMargin) continue;
          if (blockedAt(x, y, 24)) continue; // not inside a tree
          it.x = x; it.y = y; it.active = true;
          live++; made++;
          break;
        }
      }
    }
    advCoinLive = live;
  }
  function clearAdvCoins() { for (const it of advCoins.items) it.active = false; advCoinLive = 0; }

  // ---- Adventure Zone treasure chest. Exactly one exists at a time, only while the zone is open. Picking it up gives
  // ADVENTURE.chest.value carried coins (hull limit ignored) with a confetti burst and a floating "+N"; the next chest
  // appears respawnSeconds of game time later (not counted inside the hut) at a random valid spot in the zone. The
  // spot and the countdown are saved with the slot so a reload can't skip the wait.
  const chestImg = new Image();
  chestImg.src = 'assets/items/chest_closed_64.png';
  const chest = { on: false, x: 0, y: 0, left: ADVENTURE.chest.firstSpawnSeconds, retry: 0, saveTimer: 0 };
  function saveChest() {
    const P = window.Progression;
    P.state.adventure.chest = { on: chest.on, x: chest.x, y: chest.y, left: Math.max(0, chest.left) };
    chest.saveTimer = 0;
    P.persist();
  }
  function loadChest() {
    const c = window.Progression.state.adventure.chest;
    chest.on = false; chest.left = ADVENTURE.chest.firstSpawnSeconds; chest.retry = 0; chest.saveTimer = 0;
    if (c) { chest.on = c.on; chest.x = c.x; chest.y = c.y; chest.left = c.left; }
  }
  // A random spot the chest may appear at: in the zone, on land inside the world circle, clear of obstacles, far from the
  // turtle (out of view) and outside every live enemy's den. Returns true and sets chest.x/y on success.
  function pickChestSpot() {
    const C = ADVENTURE.chest, span = WORLD_MAX - WORLD_MIN, minD = C.minPlayerScreens * Math.max(viewW, viewH) / ZOOM, minD2 = minD * minD;
    for (let i = 0; i < 40; i++) {
      const x = WORLD_MIN + Math.random() * span, y = WORLD_MIN + Math.random() * span;
      if (inHomeZone(x, y)) continue;
      if (x < WORLD_MIN + 300 || x > WORLD_MAX - 300 || y < WORLD_MIN + 300 || y > WORLD_MAX - 300) continue; // not out in the fog fringe
      const dx = x - turtle.x, dy = y - turtle.y;
      if (dx * dx + dy * dy < minD2) continue;
      if (blockedAt(x, y, 48) || (window.Enemies && window.Enemies.nearDen(x, y, C.denPad))) continue;
      chest.x = x; chest.y = y;
      return true;
    }
    return false;
  }
  // Confetti burst + floating "+N" at the pickup spot: fixed pools, drawn in world space for ~confettiSeconds.
  const CONFETTI_COLORS = ['#ff5a6e', '#ffd23f', '#4cc9f0', '#80ed99', '#f78fb3', '#ffffff', '#ffb347'];
  const confetti = [];
  for (let i = 0; i < ADVENTURE.chest.confettiCount; i++) confetti.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, age: 0, spin: 0, w: 0, h: 0, c: 0 });
  const plusText = { on: false, x: 0, y: 0, age: 0, text: '' };
  let confettiLive = 0;
  function burstConfetti(x, y, text) {
    for (const p of confetti) {
      const a = Math.random() * Math.PI * 2, sp = 120 + Math.random() * 340;
      p.on = true; p.x = x; p.y = y - 20; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp * 0.6 - 260 - Math.random() * 200;
      p.age = Math.random() * 0.2; p.spin = Math.random() * 6; p.w = 5 + Math.random() * 5; p.h = 8 + Math.random() * 6; p.c = Math.floor(Math.random() * CONFETTI_COLORS.length);
    }
    confettiLive = confetti.length;
    if (text) { plusText.on = true; plusText.x = x; plusText.y = y - 50; plusText.age = 0; plusText.text = text; }
  }
  function updateBurst(dt) {
    if (plusText.on && (plusText.age += dt) > 1.6) plusText.on = false;
    if (!confettiLive) return;
    const life = ADVENTURE.chest.confettiSeconds;
    confettiLive = 0;
    for (const p of confetti) {
      if (!p.on) continue;
      p.age += dt;
      if (p.age > life) { p.on = false; continue; }
      p.vy += 700 * dt; p.vx *= 1 - 1.5 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.spin += dt * 9;
      confettiLive++;
    }
  }
  function drawBurst() {
    if (confettiLive) {
      const life = ADVENTURE.chest.confettiSeconds;
      for (const p of confetti) {
        if (!p.on) continue;
        ctx.globalAlpha = Math.min(1, (life - p.age) / 0.5);
        ctx.fillStyle = CONFETTI_COLORS[p.c];
        ctx.fillRect(p.x, p.y, p.w * Math.abs(Math.cos(p.spin)) + 1, p.h); // width flutters with the spin: no per-piece rotation needed
      }
      ctx.globalAlpha = 1;
    }
    if (plusText.on) {
      const k = plusText.age / 1.6;
      ctx.globalAlpha = Math.min(1, (1 - k) * 2);
      ctx.font = '800 34px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(60, 35, 5, 0.85)'; ctx.fillStyle = '#ffd23f';
      const y = plusText.y - k * 70;
      ctx.strokeText(plusText.text, plusText.x, y); ctx.fillText(plusText.text, plusText.x, y);
      ctx.globalAlpha = 1; ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    }
  }
  function updateChest(dt) {
    if (!adventureUnlocked) return; // locked: no chest exists, nothing counts down
    const C = ADVENTURE.chest;
    if (!chest.on) {
      chest.left -= dt;
      if ((chest.saveTimer += dt) >= C.saveEverySeconds) saveChest();
      if (chest.left <= 0) {
        if ((chest.retry -= dt) > 0) return;
        if (pickChestSpot()) { chest.on = true; chest.left = 0; saveChest(); if (inAdventure) showToast('A treasure chest has appeared!', 2600); }
        else chest.retry = C.spawnRetrySeconds;
      }
      return;
    }
    const dx = turtle.x - chest.x, dy = turtle.y - chest.y, r = TURTLE_BODY_RADIUS + C.pickupRadius;
    if (dx * dx + dy * dy < r * r && state !== 'dying') {
      chest.on = false; chest.left = C.respawnSeconds;
      window.Progression.grantCarriedCoins(C.value);
      burstConfetti(chest.x, chest.y, '+' + C.value);
      if (window.TT_SOUND) { window.TT_SOUND.purchase(); window.TT_SOUND.coin(); }
      saveChest();
    }
  }
  function drawChest() {
    if (!adventureUnlocked || !chest.on) return;
    const D = ADVENTURE.chest.drawSize, vw = viewW / ZOOM, vh = viewH / ZOOM;
    if (chest.x < camX - D || chest.x > camX + vw + D || chest.y < camY - D || chest.y > camY + vh + D) return;
    if (!chestImg.complete || !chestImg.naturalWidth) return;
    const bob = Math.sin(gameTime * 2.2) * 3;
    ctx.globalAlpha = 0.4; ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(chest.x, chest.y + D * 0.32, D * 0.4, D * 0.13, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false; // pixel art
    ctx.drawImage(chestImg, chest.x - D / 2, chest.y - D / 2 + bob, D, D);
    ctx.imageSmoothingEnabled = true;
  }
  // The timer only advances while the game runs outdoors; make sure the latest countdown is in the save when the tab goes away.
  document.addEventListener('visibilitychange', () => { if (document.hidden && adventureUnlocked && spawned) saveChest(); });

  // ---- Water ripples: purely decorative wake while swimming. Spawned in update() (throttled so
  // movement doesn't spam them), aged/pruned each frame, drawn in render() between the water and
  // the turtle/scenery pass. Capped at RIPPLE_MAX so a long swim on mobile stays cheap.
  const RIPPLE_SPAWN_INTERVAL = 0.12; // seconds of movement between spawns
  const RIPPLE_LIFETIME = 0.7;        // seconds a ripple lives
  const RIPPLE_START_R = 8, RIPPLE_END_R = 46;
  const RIPPLE_MAX = 20;
  const RIPPLE_BEHIND_OFFSET = 20;    // world px behind the turtle (opposite heading) a ripple spawns
  const ripples = []; // { x, y, age }
  let rippleSpawnTimer = 0;

  // A slower, randomized second source of ripples while the turtle just floats in place (not
  // paddling): bigger, slower-expanding rings spawned right at/around the turtle rather than
  // trailing a wake.
  const IDLE_RIPPLE_MIN_GAP = 2.2, IDLE_RIPPLE_MAX_GAP = 3.6; // seconds between idle ripples
  const IDLE_RIPPLE_SCALE = 1.6;    // idle rings grow this much bigger than wake ripples
  const IDLE_RIPPLE_LIFETIME = 1.6; // idle rings expand/fade slower than wake ripples
  let idleRippleTimer = IDLE_RIPPLE_MIN_GAP + rand() * (IDLE_RIPPLE_MAX_GAP - IDLE_RIPPLE_MIN_GAP);

  function spawnRipple() {
    const x = turtle.x - Math.cos(turtle.angle) * RIPPLE_BEHIND_OFFSET;
    const y = turtle.y - Math.sin(turtle.angle) * RIPPLE_BEHIND_OFFSET;
    ripples.push({ x, y, age: 0, scale: 1, lifetime: RIPPLE_LIFETIME });
    if (ripples.length > RIPPLE_MAX) ripples.shift();
  }
  function spawnIdleRipple() {
    const a = rand() * Math.PI * 2, d = rand() * 10;
    ripples.push({
      x: turtle.x + Math.cos(a) * d, y: turtle.y + Math.sin(a) * d,
      age: 0, scale: IDLE_RIPPLE_SCALE, lifetime: IDLE_RIPPLE_LIFETIME,
    });
    if (ripples.length > RIPPLE_MAX) ripples.shift();
  }
  function updateRipples(dt) {
    for (let i = ripples.length - 1; i >= 0; i--) {
      ripples[i].age += dt;
      if (ripples[i].age >= ripples[i].lifetime) ripples.splice(i, 1);
    }
  }
  function drawRipples() {
    for (const r of ripples) {
      const t = r.age / r.lifetime;
      const radius = (RIPPLE_START_R + (RIPPLE_END_R - RIPPLE_START_R) * t) * r.scale;
      const alpha = 0.6 * (1 - t);
      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.scale(1, 0.55); // wider than tall: top-down perspective on an expanding ring
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(210, 236, 245, ${alpha})`;
      ctx.stroke();
      ctx.restore();
    }
  }

  const NO_DIR = { x: 0, y: 0 };
  // Walk cycle + footsteps while inside the hut, driven by the room speed converted back to world px/s.
  function updateInteriorAnim(dt) {
    // The hut's sleep sequence borrows the 'sleeping' sprite row; otherwise the turtle is up and walking.
    state = Home.isAsleep() ? 'sleeping' : 'normal'; moveMode = 'walk'; floating = false;
    if (state === 'sleeping') stateTime += dt;
    else stateTime = 0;
    const speed = Home.room.speed / Home.TURTLE_SCALE;
    if (speed > 5) walkFrame += speed * dt * FRAMES_PER_SPEED; else walkFrame = 0;
    if (window.TT_SOUND) {
      window.TT_SOUND.walking(speed > 5, Math.min(4, Math.max(1, WALK_SOUND_BASE_RATE * speed / (MAX_SPEED * LAND_SPEED_MULT))));
      window.TT_SOUND.swimming(false, true);
    }
  }
  // ---- Update ----
  function update(dt) {
    window.Progression.addPlayTime(dt);
    // Inside the hut (or mid door-fade) the outside world is paused: no enemies, pickups, timers.
    if (Home.tick(dt, Home.isInterior() ? getDirection() : NO_DIR)) {
      // Toggled at the hut window: snap the outside sky so there's no dim fade on exit.
      if (Home.isInterior()) nightAmount = window.Progression.state.isNight ? 1 : 0;
      if (Home.isInterior()) updateInteriorAnim(dt);
      else if (window.TT_SOUND) { window.TT_SOUND.walking(false, 1); window.TT_SOUND.swimming(false, true); }
      return;
    }
    stateTime += dt;
    gameTime += dt;
    if (deathTimer >= 0) {
      deathTimer += dt;
      if (deathTimer >= DEATH_FADE_SECONDS + DEATH_BLACK_SECONDS) {
        deathTimer = -1; state = 'normal'; stateTime = 0;
        window.Progression.respawnAtHome();
        dropLostItems();
      }
    }
    if (shakeTime > 0) shakeTime = Math.max(0, shakeTime - dt);
    updateNightFade(dt);
    updateSandPuffs(dt);
    coinPickups.update();
    coconutPickups.update();
    findPickups.update();
    if (adventureUnlocked) { advCoins.update(); updateAdvCoins(dt); }
    updateChest(dt);
    updateBurst(dt);

    const atHome = isHomeIsland(turtle.x, turtle.y);
    const hungerSpeedMult = window.Progression.update(dt, !atHome);
    if (atHome) window.Progression.bankCarried();

    // Hide in Shell (hut perk): with the toggle on, standing still for a moment tucks the turtle into its
    // shell (state 'shell', which Enemies' takeHit wrapper treats as invulnerable); any input pops it out.
    const hideOn = window.Progression.state.hideOn && window.Progression.hasSkill('hideInShell');
    const wantsMove = state === 'normal' || (state === 'shell' && shellFromToggle) ? getDirection() : NO_DIR;
    if (state === 'shell' && shellFromToggle && (wantsMove.x !== 0 || wantsMove.y !== 0 || !hideOn)) {
      state = 'normal'; stateTime = 0; shellFromToggle = false; hideIdleTimer = 0;
    }
    const dir = state === 'normal' ? wantsMove : NO_DIR;
    const inWater = isWater(turtle.x, turtle.y);
    // Swim Speed only boosts water movement, Move Speed only boosts land movement (see
    // progression.js CONFIG.speed) — domains never overlap, so nothing to stack.
    const skillSpeedMult = inWater ? window.Progression.swimSpeedMultiplier() : window.Progression.moveSpeedMultiplier();
    const speedMult = (inWater ? WATER_SPEED_MULT : LAND_SPEED_MULT) * skillSpeedMult * hungerSpeedMult;
    const tvx = dir.x * MAX_SPEED * speedMult, tvy = dir.y * MAX_SPEED * speedMult;
    const hasInput = dir.x !== 0 || dir.y !== 0;
    const rate = (hasInput ? ACCEL : DECEL) * dt;

    if (hideOn && state === 'normal' && dir.x === 0 && dir.y === 0) { // no velocity check: hide the instant input stops
      hideIdleTimer += dt;
      if (hideIdleTimer >= window.Progression.getHideConfig().idleSeconds) {
        state = 'shell'; stateTime = 0; shellFromToggle = true; hideIdleTimer = 0;
      }
    } else if (state !== 'shell') {
      hideIdleTimer = 0;
    }

    // Move velocity toward target by at most `rate` (smooth accel/decel, any angle).
    const dvx = tvx - turtle.vx, dvy = tvy - turtle.vy;
    const dl = Math.hypot(dvx, dvy);
    if (dl <= rate) { turtle.vx = tvx; turtle.vy = tvy; }
    else { turtle.vx += (dvx / dl) * rate; turtle.vy += (dvy / dl) * rate; }

    // Pick walk vs swim from the water check, debounced so the shoreline doesn't flicker it.
    const modeCandidate = inWater ? 'swim' : 'walk';
    if (modeCandidate === moveModeCandidate) moveModeCandidateFrames++;
    else { moveModeCandidate = modeCandidate; moveModeCandidateFrames = 1; }
    if (moveModeCandidateFrames >= MODE_SWITCH_FRAMES && moveMode !== moveModeCandidate) {
      moveMode = moveModeCandidate;
      walkFrame = 0; // don't start the new animation mid-cycle
    }

    // Advance walk/swim animation by distance moved; idle holds frame 0.
    const speed = Math.hypot(turtle.vx, turtle.vy);
    if (speed > 5) walkFrame += speed * dt * FRAMES_PER_SPEED;
    else walkFrame = 0;
    if (window.TT_SOUND) {
      const moving = state === 'normal' && speed > 5;
      // footstep tempo tracks speed and is boosted to line up with the head swing (~1.2 swings/s at base land speed)
      const walkRate = WALK_SOUND_BASE_RATE * speed / (MAX_SPEED * LAND_SPEED_MULT);
      window.TT_SOUND.walking(moving && !inWater, Math.min(4, Math.max(1, walkRate)));
      window.TT_SOUND.swimming(state === 'normal' && inWater, !moving);
    }

    // Wake ripples while actually swimming; slower, occasional ripples while just floating in
    // place on water. Land gets neither.
    if (inWater && speed > 5) {
      rippleSpawnTimer += dt;
      if (rippleSpawnTimer >= RIPPLE_SPAWN_INTERVAL) { rippleSpawnTimer = 0; spawnRipple(); }
      idleRippleTimer = IDLE_RIPPLE_MIN_GAP + rand() * (IDLE_RIPPLE_MAX_GAP - IDLE_RIPPLE_MIN_GAP);
    } else {
      rippleSpawnTimer = 0;
    }
    if (inWater && speed <= 5) {
      idleRippleTimer -= dt;
      if (idleRippleTimer <= 0) {
        spawnIdleRipple();
        idleRippleTimer = IDLE_RIPPLE_MIN_GAP + rand() * (IDLE_RIPPLE_MAX_GAP - IDLE_RIPPLE_MIN_GAP);
      }
    }
    updateRipples(dt);

    // Gentle bob while floating: a gone-nowhere-fast sine offset applied only in drawTurtle, driven
    // by this free-running clock (kept separate from stateTime so debug state switches don't reset it).
    floatClock += dt;
    floating = inWater && speed <= 5 && state === 'normal';

    turtle.x += turtle.vx * dt;
    turtle.y += turtle.vy * dt;
    resolveObstacleCollisions();
    Home.collideWorld(turtle, TURTLE_BODY_RADIUS);

    // World edge, or the fence while the Adventure Zone is locked.
    const m = adventureUnlocked ? TURTLE_RADIUS : FENCE_A;
    if (turtle.x < bounds.x0 + m) { turtle.x = bounds.x0 + m; turtle.vx = 0; }
    if (turtle.x > bounds.x1 - m) { turtle.x = bounds.x1 - m; turtle.vx = 0; }
    if (turtle.y < bounds.y0 + m) { turtle.y = bounds.y0 + m; turtle.vy = 0; }
    if (turtle.y > bounds.y1 - m) { turtle.y = bounds.y1 - m; turtle.vy = 0; }
    if (!adventureUnlocked && hasInput && (turtle.x <= bounds.x0 + m + 0.5 || turtle.x >= bounds.x1 - m - 0.5 || turtle.y <= bounds.y0 + m + 0.5 || turtle.y >= bounds.y1 - m - 0.5) && gameTime - lastBumpHint > ADVENTURE.bumpHintSeconds) {
      lastBumpHint = gameTime; // pushing against the locked fence: say how to open the way
      showToast('Lv 4 home unlocks the Adventure Woods', 4200);
    }

    // Re-check home status against this frame's final position (not the pre-movement one used
    // above for the hunger-penalty speed calc) so the Upgrades button/panel react the instant the
    // turtle actually crosses onto/off the island, not one frame late.
    const onIsland = isHomeIsland(turtle.x, turtle.y);
    window.Progression.setHomeButtonVisible(onIsland);
    updateCompass(dt, onIsland);

    // Face movement direction, turning smoothly.
    if (Math.hypot(turtle.vx, turtle.vy) > 10) {
      const target = Math.atan2(turtle.vy, turtle.vx);
      let diff = target - turtle.angle;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      turtle.angle += diff * Math.min(1, 10 * dt);
    }

    if (adventureUnlocked) updateZoneFlag();
    Home.checkDoor();
    Home.updateAmbient();
    if (window.Enemies) window.Enemies.update(dt);
  }

  // ---- Render ----
  let dpr = 1, viewW = 0, viewH = 0;

  function clampToWorld() {
    const m = adventureUnlocked ? TURTLE_RADIUS : FENCE_A;
    turtle.x = Math.max(bounds.x0 + m, Math.min(bounds.x1 - m, turtle.x));
    turtle.y = Math.max(bounds.y0 + m, Math.min(bounds.y1 - m, turtle.y));
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    if (window.innerWidth <= 768 || Math.min(screen.width, screen.height) <= 768) dpr = Math.min(dpr, 1.5); // screen check: Chrome iOS can report a wide innerWidth // phones: 3x backing store made every full-screen blend ~9x costlier
    viewW = canvas.clientWidth || window.innerWidth;
    viewH = window.Progression.fullViewH(canvas);
    updateZoomForViewport();
    // Backing store scales up for retina sharpness; CSS size (set in style.css) stays at window size.
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    if (spawned) clampToWorld(); // keep the turtle in bounds after a phone rotation, etc.
  }
  window.addEventListener('resize', resize);
  // iOS reports stale innerWidth/innerHeight right after a rotation, so re-measure a few times as it settles.
  function resizeSettled() { resize(); [100, 300, 600].forEach(ms => setTimeout(resize, ms)); }
  window.addEventListener('orientationchange', resizeSettled);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);

  // Camera: centers on the turtle, clamped so the view never shows past the world edge.
  // (If the viewport is ever bigger than the world, e.g. a very wide monitor, center the world instead.)
  let camX = 0, camY = 0;
  // Brief screen shake (e.g. knocking down a sandcastle) — shakeTime counts down to 0 in update(dt);
  // shakeDuration is its starting value, so shakeTime/shakeDuration fades the offset out linearly.
  let shakeTime = 0, shakeDuration = 0, shakeStrength = 0;
  function triggerShake(strength, duration) { shakeTime = shakeDuration = duration; shakeStrength = strength; }
  function updateCamera() {
    const vw = viewW / ZOOM, vh = viewH / ZOOM;
    const bw = bounds.x1 - bounds.x0, bh = bounds.y1 - bounds.y0;
    camX = bw <= vw ? bounds.x0 + (bw - vw) / 2 : Math.max(bounds.x0, Math.min(bounds.x1 - vw, turtle.x - vw / 2));
    camY = bh <= vh ? bounds.y0 + (bh - vh) / 2 : Math.max(bounds.y0, Math.min(bounds.y1 - vh, turtle.y - vh / 2));
    if (shakeTime > 0) {
      const falloff = shakeTime / shakeDuration;
      camX += (rand() - 0.5) * shakeStrength * falloff;
      camY += (rand() - 0.5) * shakeStrength * falloff;
    }
  }

  // Walk cycle = first 4 cells of row 0 in the sheet (8 cols x 5 rows); sprite faces up.
  // Other rows: 2 asleep+zzz (cols 0-3), 3 stun (cols 2-3 blink the dizzy dashes), 4 closed shell (col 0).
  const sprite = new Image();
  sprite.src = 'assets/turtle-sheet.png';
  const FRAMES = 4;
  const SHEET_COLS = 8, SHEET_ROWS = 5;
  const SPRITE_H = 100;          // drawn height in world px
  const WALK_SOUND_BASE_RATE = 2; // walking.mp3 playbackRate at base land speed; raise to speed footsteps up
  const FRAMES_PER_SPEED = 0.03; // frames per px traveled (~5 fps at full speed)
  let walkFrame = 0;

  // Shell-only tint mask: the shell sits in roughly the same ellipse in every frame/pose (measured
  // from the row-4 "withdrawn into shell" pose, where the whole visible sprite IS the shell), while
  // the head/legs/tail poke out past that ellipse in every other pose. On load, copy the sheet into
  // shellMaskSheet but zero the alpha of any pixel outside that per-frame ellipse, so color-tint
  // compositing (source-atop) only ever touches the shell, not the whole turtle. tintScratch is a
  // small reusable canvas sized to one drawn frame each time it's tinted.
  const SHELL_ELLIPSE = { cx: 0.504, cy: 0.526, rx: 0.29, ry: 0.29 }; // fractions of one frame's w/h
  let shellMaskSheet = null;
  const tintScratch = document.createElement('canvas');
  const tintScratchCtx = tintScratch.getContext('2d');
  let tintKeyTint = '', tintKeySx = -1, tintKeySy = -1, tintKeyDw = -1, tintKeyDh = -1; // last tinted frame, see drawEquippedCosmetics
  sprite.addEventListener('load', () => {
    const w = sprite.naturalWidth, h = sprite.naturalHeight;
    const fw = w / SHEET_COLS, fh = h / SHEET_ROWS;
    const src = document.createElement('canvas');
    src.width = w; src.height = h;
    const sctx = src.getContext('2d');
    sctx.drawImage(sprite, 0, 0);
    const imgData = sctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const rx = SHELL_ELLIPSE.rx * fw, ry = SHELL_ELLIPSE.ry * fh;
    for (let row = 0; row < SHEET_ROWS; row++) {
      const cy = row * fh + SHELL_ELLIPSE.cy * fh;
      for (let col = 0; col < SHEET_COLS; col++) {
        const cx = col * fw + SHELL_ELLIPSE.cx * fw;
        const x0 = Math.floor(col * fw), x1 = Math.floor((col + 1) * fw);
        const y0 = Math.floor(row * fh), y1 = Math.floor((row + 1) * fh);
        for (let y = y0; y < y1; y++) {
          const dy = (y - cy) / ry;
          for (let x = x0; x < x1; x++) {
            const dx = (x - cx) / rx;
            if (dx * dx + dy * dy > 1) {
              d[(y * w + x) * 4 + 3] = 0; // outside the shell ellipse - zero alpha, leave untinted
            }
          }
        }
      }
    }
    sctx.putImageData(imgData, 0, 0);
    shellMaskSheet = src;
  });

  // Idle-on-water bob: set each frame in update() (floating = stationary + in water + normal
  // state), floatClock is a free-running seconds counter driving the sine so the bob doesn't jump
  // or reset whenever floating toggles on/off.
  let floatClock = 0;
  let floating = false;
  const FLOAT_BOB_SPEED = 2.2;   // radians/sec
  const FLOAT_BOB_AMPLITUDE = 4; // world px of vertical drift

  // px/py/ang/sc default to the world turtle; the hut interior passes screen-space values and a scale.
  function drawTurtle(px = turtle.x, py = turtle.y, ang = turtle.angle, sc = 1) {
    if (!sprite.complete || !sprite.naturalWidth) return;
    const fw = sprite.naturalWidth / SHEET_COLS, fh = sprite.naturalHeight / SHEET_ROWS;
    const dw = SPRITE_H * fw / fh;
    let row = 0, f = Math.floor(walkFrame) % FRAMES;
    if (state === 'sleeping') { row = 2; f = Math.floor(stateTime * 2) % FRAMES; }
    else if (state === 'stunned') { row = 3; f = 2 + Math.floor(stateTime * 4) % 2; }
    else if (state === 'shell') { row = 4; f = 0; }
    else if (moveMode === 'swim') { row = 1; } // swim cycle; idle float is frame 0, same as walk's idle
    const bobY = floating ? Math.sin(floatClock * FLOAT_BOB_SPEED) * FLOAT_BOB_AMPLITUDE : 0;
    ctx.save();
    ctx.translate(px, py + bobY * sc);
    ctx.rotate(ang + Math.PI / 2); // art faces up, angle 0 = right
    if (sc !== 1) ctx.scale(sc, sc);
    if (window.Progression.isInvulnerable() && Math.floor(gameTime * 12) % 2 === 0) ctx.globalAlpha = 0.3; // blink after a hit (restored below)
    if (state === 'normal' && moveMode === 'walk' && f === 3) ctx.scale(-1, 1); // mirror the last walk frame so the head swings left (sheet only has right)
    ctx.imageSmoothingQuality = 'high';
    const swimming = moveMode === 'swim';
    if (swimming) drawEquippedCosmetics(ctx, dw, SPRITE_H, f * fw, row * fh, fw, fh, null, null, 'only'); // null frame = no bob/sway // on its back: hat goes behind the body
    ctx.drawImage(sprite, f * fw, row * fh, fw, fh, -dw / 2, -SPRITE_H / 2, dw, SPRITE_H);
    drawEquippedCosmetics(ctx, dw, SPRITE_H, f * fw, row * fh, fw, fh, null, swimming ? null : f, swimming ? 'skip' : undefined); // Turtle Shop: color tint + hat/clothes/accessory, same local
    ctx.restore();                                                      // space as the sprite draw above so it stays attached in every state
  }

  // Recolors the shell with the 'color' blend (tint's hue/saturation, sprite's own lightness) so the
  // shell's shading and highlights survive instead of being flattened by a translucent fill; the
  // destination-in pass clips the blend back to the shell mask (blend would otherwise fill outside it).
  function paintShellTint(sx, sy, sw, sh, dw, dh, tint) {
    const c = tintScratchCtx;
    c.clearRect(0, 0, dw, dh);
    c.globalCompositeOperation = 'source-over';
    c.drawImage(shellMaskSheet, sx, sy, sw, sh, 0, 0, dw, dh);
    c.globalCompositeOperation = 'color';
    c.fillStyle = tint;
    c.fillRect(0, 0, dw, dh);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(shellMaskSheet, sx, sy, sw, sh, 0, 0, dw, dh);
    c.globalCompositeOperation = 'source-over';
  }

  // Turtle Shop rendering: color tint composites onto just the shell's pixels (via shellMaskSheet),
  // then hat/clothes/accessory are drawn as extra shapes on top — both driven by progression.js's
  // owned item data (this is only the "how to draw it" half; see progression.js COSMETIC_DRAW/
  // COLOR_TINTS for what each item looks like and how equip/unequip/buy work).
  function drawEquippedCosmetics(ctx, dw, dh, sx, sy, sw, sh, overrideEquipped, walkFrame, hatMode) {
    const tint = window.Progression.getEquippedColorTint(overrideEquipped);
    if (tint && shellMaskSheet && hatMode !== 'only') {
      // Rebuild only when the frame/tint/size changes — reassigning canvas width/height every frame
      // reallocates the backing store.
      if (tint !== tintKeyTint || sx !== tintKeySx || sy !== tintKeySy || dw !== tintKeyDw || dh !== tintKeyDh) {
        tintKeyTint = tint; tintKeySx = sx; tintKeySy = sy; tintKeyDw = dw; tintKeyDh = dh;
        if (tintScratch.width !== dw || tintScratch.height !== dh) { tintScratch.width = dw; tintScratch.height = dh; }
        paintShellTint(sx, sy, sw, sh, dw, dh, tint);
      }
      ctx.drawImage(tintScratch, -dw / 2, -dh / 2);
    }
    window.Progression.drawEquippedCosmetics(ctx, dw, dh, overrideEquipped, walkFrame, hatMode);
  }

  // Shop-panel live preview (progression.js calls this by canvas element, no world state involved):
  // draws the idle walk frame at a fixed pose so the player can see exactly what's currently
  // equipped without needing to leave the menu.
  function renderCosmeticPreview(canvasEl) {
    if (!sprite.complete || !sprite.naturalWidth) { requestAnimationFrame(() => renderCosmeticPreview(canvasEl)); return; }
    const pctx = canvasEl.getContext('2d');
    const w = canvasEl.width, h = canvasEl.height;
    pctx.clearRect(0, 0, w, h);
    const fw = sprite.naturalWidth / SHEET_COLS, fh = sprite.naturalHeight / SHEET_ROWS;
    const spriteH = h * 0.8, dw = spriteH * fw / fh;
    pctx.save();
    pctx.translate(w / 2, h / 2 + spriteH * 0.05);
    pctx.imageSmoothingQuality = 'high';
    pctx.drawImage(sprite, 0, 0, fw, fh, -dw / 2, -spriteH / 2, dw, spriteH); // row 0 col 0: idle frame
    const tint = window.Progression.getEquippedColorTint();
    if (tint && shellMaskSheet) {
      tintScratch.width = dw; tintScratch.height = spriteH;
      paintShellTint(0, 0, fw, fh, dw, spriteH, tint);
      pctx.drawImage(tintScratch, -dw / 2, -spriteH / 2);
      tintKeyTint = ''; // the in-world turtle shares tintScratch: force it to repaint its own frame next draw
    }
    window.Progression.drawEquippedCosmetics(pctx, dw, spriteH);
    pctx.restore();
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

  const visibleBuf = [];
  // Scenery in the camera view (+ margin), found via the draw grid instead of scanning every entry.
  function collectScenery(vw, vh, margin) {
    const gx0 = Math.floor((camX - margin) / DRAW_CELL), gx1 = Math.floor((camX + vw + margin) / DRAW_CELL);
    const gy0 = Math.floor((camY - margin) / DRAW_CELL), gy1 = Math.floor((camY + vh + margin) / DRAW_CELL);
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const arr = drawGrid.get(gx * 65536 + gy);
      if (arr) for (const s of arr) if (inView(s, vw, vh, margin)) visibleBuf.push(s);
    }
  }
  // Fence art (64px top-down tiles with the post in the middle): a straight run piece for the top/bottom edges (all pieces are the "depth" art: the post's front face and sagging rope), one for the
  // sides, and four corners named for the way their ropes point. A closed rectangle of FENCE_N tiles per side.
  const FENCE_IMG = {};
  const FENCE_FILES = { horizontal_depth: 'fence_horizontal_depth_64', vertical: 'fence_depth_vertical_64', corner_up_left: 'fence_depth_corner_up_left_64',
    corner_up_right: 'fence_depth_corner_up_right_64', corner_down_left: 'fence_depth_corner_down_left_64', corner_down_right: 'fence_depth_corner_down_right_64' };
  for (const k in FENCE_FILES) { const img = new Image(); img.src = `assets/scenery/${FENCE_FILES[k]}.png`; FENCE_IMG[k] = img; }
  let fenceFog = null;
  // While the Adventure Zone is locked: fog rolling in toward the home zone's edge, and the fence along FENCE_A. Only the
  // tiles in view are drawn (at most a couple dozen per edge). The turtle stops at the fence (see update()).
  function drawFence(vw, vh) {
    if (adventureUnlocked) return;
    const W = WORLD_SIZE, fb = ADVENTURE.fogBand, T = ADVENTURE.fenceTile, A = FENCE_A, N = FENCE_N, far = A + N * T;
    const top = camY < fb, bottom = camY + vh > W - fb, left = camX < fb, right = camX + vw > W - fb;
    if (!(top || bottom || left || right)) return;
    ctx.save();
    // Fog (gradients are built once; they live in world space).
    if (!fenceFog) {
      const mk = (x0, y0, x1, y1) => {
        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        g.addColorStop(0, 'rgba(8, 28, 36, 0)'); g.addColorStop(1, `rgba(8, 28, 36, ${ADVENTURE.fogAlpha})`);
        return g;
      };
      fenceFog = { top: mk(0, fb, 0, 0), left: mk(fb, 0, 0, 0), bottom: mk(0, W - fb, 0, W), right: mk(W - fb, 0, W, 0) };
    }
    if (top) { ctx.fillStyle = fenceFog.top; ctx.fillRect(camX, 0, vw, fb); }
    if (bottom) { ctx.fillStyle = fenceFog.bottom; ctx.fillRect(camX, W - fb, vw, fb); }
    if (left) { ctx.fillStyle = fenceFog.left; ctx.fillRect(0, camY, fb, vh); }
    if (right) { ctx.fillStyle = fenceFog.right; ctx.fillRect(W - fb, camY, fb, vh); }
    ctx.imageSmoothingEnabled = false; // pixel art
    const F = FENCE_IMG, h = T / 2;
    const tile = (img, cx, cy) => { if (img.complete && img.naturalWidth) ctx.drawImage(img, cx - h, cy - h, T, T); };
    // Index range of the tiles in view along one axis (0..N), padded by one tile.
    const k0x = Math.max(0, Math.floor((camX - A) / T) - 1), k1x = Math.min(N, Math.ceil((camX + vw - A) / T) + 1);
    const k0y = Math.max(0, Math.floor((camY - A) / T) - 1), k1y = Math.min(N, Math.ceil((camY + vh - A) / T) + 1);
    if (top) for (let k = k0x; k <= k1x; k++) tile(k === 0 ? F.corner_down_right : k === N ? F.corner_down_left : F.horizontal_depth, A + k * T, A);
    if (bottom) for (let k = k0x; k <= k1x; k++) tile(k === 0 ? F.corner_up_right : k === N ? F.corner_up_left : F.horizontal_depth, A + k * T, far);
    if (left) for (let k = Math.max(1, k0y); k <= Math.min(N - 1, k1y); k++) tile(F.vertical, A, A + k * T);
    if (right) for (let k = Math.max(1, k0y); k <= Math.min(N - 1, k1y); k++) tile(F.vertical, far, A + k * T);
    ctx.restore();
  }
  function inView(s, vw, vh, margin) {
    return s.x > camX - margin && s.x < camX + vw + margin && s.y > camY - margin && s.y < camY + vh + margin;
  }
  // Debug bisecting on a phone: ?debug=1&skip=terrain,grass,shore turns those layers off (also: scenery, ripples, pickups, enemies, hud, night).
  const skip = {};
  for (const k of (new URLSearchParams(location.search).get('skip') || '').split(',')) if (k) skip[k] = true;
  // Hut interior: fixed screen-space scene, no camera. Room art is drawn from home.js's cached canvas.
  function renderInterior(t) {
    ctx.fillStyle = '#1b120a';
    ctx.fillRect(0, 0, viewW, viewH);
    const lay = Home.layout(viewW, viewH), R = Home.room;
    Home.drawRoom(ctx, lay, t);
    Home.drawSleepDim(ctx, viewW, viewH);
    if (Home.isAsleep()) { const b = Home.bedSpot; drawTurtle(lay.x0 + b.x * lay.s, lay.y0 + b.y * lay.s, -Math.PI / 2, lay.s * lay.tk * Home.SLEEP_SCALE); }
    else drawTurtle(lay.x0 + R.x * lay.s, lay.y0 + R.y * lay.s, R.angle, lay.s * lay.tk);
    Home.drawMessages(ctx, lay);
    drawJoystick();
    if (!skip.hud) window.Progression.drawHUD(ctx);
    Home.drawFade(ctx, viewW, viewH);
  }
  function render(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 1 ctx unit = 1 CSS px; backing store already has the dpr scale-up
    if (Home.isInterior()) { renderInterior(t); return; }
    ctx.fillStyle = '#0b3d4f';
    ctx.fillRect(0, 0, viewW, viewH);

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, viewW, viewH); ctx.clip();
    updateCamera();
    ctx.scale(ZOOM, ZOOM);
    ctx.translate(-camX, -camY);

    if (!skip.terrain) { serviceGround(); drawGround(); }
    if (shore && !skip.shore) drawShore(t);
    if (!skip.ripples) drawRipples(); // above water, below turtle/scenery
    drawSandText();
    drawFence(viewW / ZOOM, viewH / ZOOM);
    ctx.drawImage(islandDetail.canvas, islandDetail.worldX, islandDetail.worldY);
    Home.drawGround(ctx, t); // outdoor campfire
    if (!skip.pickups) { coinPickups.draw(); coconutPickups.draw(); findPickups.draw(); if (adventureUnlocked) { advCoins.draw(); drawChest(); } }

    // Cull scenery to the visible world rect (plus a small margin) so a big world with lots of
    // trees still draws only a couple dozen-to-hundred objects per frame.
    const vw = viewW / ZOOM, vh = viewH / ZOOM, margin = 200; // >= widest tree sprite so edge trees don't pop in
    visibleBuf.length = 0; // reused buffer: no per-frame array allocations
    if (!skip.scenery) collectScenery(vw, vh, margin);
    if (Home.hutBuilt() && inView(Home.hutEntry, vw, vh, 220)) visibleBuf.push(Home.hutEntry); // big sprite: wider cull margin
    if (window.Enemies && !skip.enemies) window.Enemies.collectVisible(visibleBuf, ctx, camX, camY, vw, vh, margin);
    const visible = visibleBuf;
    if (perf) perf.visible = visible.length;
    drawSceneryWithTurtle(visible);
    drawBurst();
    if (DEBUG_HITBOXES) drawDebugHitboxes(visible);
    if (DEBUG) { ctx.strokeStyle = 'magenta'; ctx.lineWidth = 4; ctx.strokeRect(0, 0, WORLD_SIZE, WORLD_SIZE); } // Adventure Zone boundary (= the home zone's edge)
    if (window.Enemies) window.Enemies.drawDebug(ctx, camX, camY, vw, vh);
    ctx.restore();

    if (!skip.night) drawNightSky(); // screen space, under the HUD/joystick so they stay fully readable
    drawJoystick(); // screen space
    if (!skip.hud) window.Progression.drawHUD(ctx); // screen space
    // Starvation dim (see Progression.getStarveDim) or, once dead, the fade to black picking up from it.
    const dimA = deathTimer >= 0
      ? deathStartDim + (1 - deathStartDim) * Math.min(1, deathTimer / DEATH_FADE_SECONDS)
      : window.Progression.getStarveDim();
    if (dimA > 0) {
      ctx.fillStyle = `rgba(0,0,0,${dimA})`;
      ctx.fillRect(0, 0, viewW, viewH);
    }
    Home.drawFade(ctx, viewW, viewH); // door fade (entering the hut)
  }

  // ---- Perf overlay: only exists with ?debug=1 in the URL; zero cost otherwise.
  const loadedVer = (document.querySelector('script[src*="game.js"]') || {}).src?.split('?')[1] || '?'; // confirms the phone isn't running a cached build
  const perf = DEBUG ? (() => {
    const el = document.createElement('pre');
    el.style.cssText = 'position:fixed;left:4px;top:4px;margin:0;padding:4px 6px;background:rgba(0,0,0,.65);color:#7f7;font:11px/1.3 monospace;z-index:99;pointer-events:none';
    document.body.appendChild(el);
    let calls = 0;
    // Count canvas draw calls per frame by wrapping the main ctx's drawing methods.
    for (const m of ['drawImage', 'fill', 'stroke', 'fillRect', 'strokeRect', 'putImageData']) {
      const orig = ctx[m].bind(ctx);
      ctx[m] = (...a) => { calls++; return orig(...a); };
    }
    const p = { frames: 0, acc: 0, worst: 0, t0: 0, visible: 0, ms: 0,
      take() { const c = calls; calls = 0; return c; },
      show(fps, avg, worst, c) {
        const mem = performance.memory ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)} MB` : 'n/a';
        el.textContent = `fps ${fps.toFixed(0)}\nframe ${avg.toFixed(1)}ms (worst ${worst.toFixed(1)})\nwork ${p.ms.toFixed(1)}ms\nvisible ${p.visible} / ${scenery.length}\ndraws/frame ${c.toFixed(0)}\nadventure ${adventureUnlocked ? 'unlocked' : 'locked'}${inAdventure ? ' (in zone)' : ''}  chunks ${chunks.size}\nzone coins ${advCoinLive}/${advCoinWant}  chest ${chest.on ? 'at ' + Math.round(chest.x) + ',' + Math.round(chest.y) : 'respawn in ' + Math.max(0, chest.left).toFixed(0) + 's'}\nenemies ${window.Enemies ? (st => `home ${st.home} zone ${st.adv} active ${st.near}`)(window.Enemies.stats()) : '-'}\nmusic ${window.TT_SOUND && window.TT_SOUND.musicInfo ? window.TT_SOUND.musicInfo() : '-'}\nheap ${mem}\ndpr ${dpr}\n${loadedVer} skip:${Object.keys(skip).join(',') || '-'}`;
      } };
    return p;
  })() : null;

  let last;
  function frame(now) {
    // Clamp to >= 0: the first rAF timestamp can predate the performance.now() start() recorded,
    // and a negative dt made the accel branch below evaluate 0/0, poisoning the turtle's velocity
    // (and then its position, and the camera) with NaN for the rest of the session.
    const dt = Math.min(Math.max(0, (now - last) / 1000), 0.05);
    const rawMs = now - last;
    last = now;
    const w0 = perf ? performance.now() : 0;
    update(dt);
    render(now / 1000);
    if (!Home.isInterior()) serviceGroundAhead();
    if (perf) {
      perf.ms = performance.now() - w0;
      perf.frames++; perf.acc += rawMs; perf.worst = Math.max(perf.worst, rawMs);
      if (now - perf.t0 >= 500) {
        perf.show(perf.frames * 1000 / (now - perf.t0), perf.acc / perf.frames, perf.worst, perf.take() / perf.frames);
        perf.frames = 0; perf.acc = 0; perf.worst = 0; perf.t0 = now;
      }
    }
    requestAnimationFrame(frame);
  }

  // Start only once the window (and canvas) has real dimensions, so the very first resize()/spawn
  // never runs against a 0x0 layout. If innerWidth/Height still isn't ready, wait one more frame
  // rather than spawn at the origin.
  //
  // No longer auto-starts on load: intro.js owns the canvas first (egg/hatch/menu/save-slot flow)
  // and calls TurtleGame.start() once the player has zoomed into the island. `started` guards
  // against a double call (e.g. a stray extra tap on the last save-slot transition).
  let started = false;
  // slotId/saveData come from intro.js's save-slot selection, so Progression can load that slot's
  // banked inventory/upgrade levels before the turtle spawns and starts saving back to it.
  function start(slotId, saveData) {
    if (started) return;
    started = true;
    resize();
    if (!window.innerWidth || !window.innerHeight) { started = false; requestAnimationFrame(() => start(slotId, saveData)); return; }
    if (compassImagesLeft > 0) { started = false; requestAnimationFrame(() => start(slotId, saveData)); return; } // compass art
    if (scenerySpritesLeft > 0) { started = false; requestAnimationFrame(() => start(slotId, saveData)); return; } // scenery art
    if (!grassReady) { started = false; requestAnimationFrame(() => start(slotId, saveData)); return; } // wait for grass textures so nothing draws untextured
    if (!shore) { started = false; requestAnimationFrame(() => start(slotId, saveData)); return; } // wait for Shore.js's sand/water tiles too
    window.Progression.attachSlot(slotId, saveData);
    Home.syncFromSave();
    loadChest();
    syncAdventureUnlock(false);
    spawnTurtle();
    ensureGroundAt(turtle.x, turtle.y);
    last = performance.now();
    requestAnimationFrame(frame);
  }
  const viewRect = { x: 0, y: 0, w: 0, h: 0 };
  const ENEMY_WALK_R2 = (WORLD_SIZE / 2 - EDGE_FOG_WIDTH * 0.4) ** 2; // same fog margin pickups use (home zone)
  const ENEMY_ZONE_M = 0; // enemies reach the whole square world, so they can get a turtle hugging the edge
  // Enemies may go anywhere inside the circle that fits the playable world: the old circle until the zone is
  // open (so a locked game plays exactly as before), the enlarged one after, so they can cross the old edge both ways.
  const enemyRoom = (x, y) => adventureUnlocked
    ? x > WORLD_MIN + ENEMY_ZONE_M && x < WORLD_MAX - ENEMY_ZONE_M && y > WORLD_MIN + ENEMY_ZONE_M && y < WORLD_MAX - ENEMY_ZONE_M
    : (x - CENTER.x) ** 2 + (y - CENTER.y) ** 2 <= ENEMY_WALK_R2;
  if (!TEST && window.Enemies && !skip.noenemies) window.Enemies.init({
    turtle, worldSize: WORLD_SIZE, center: CENTER,
    basePlayerSpeed: MAX_SPEED * LAND_SPEED_MULT, // enemy speeds are fractions of this (skill bonuses ignored)
    walkable: (x, y) => { return enemyRoom(x, y) && !isWater(x, y) && !isHomeIsland(x, y); },
    flyable: (x, y) => { return enemyRoom(x, y) && !isHomeIsland(x, y); }, // fliers cross water/obstacles, never the island
    adventure: ADVENTURE.enemies, worldMin: WORLD_MIN, worldMax: WORLD_MAX, inHomeZone, homeSpawnR2: ENEMY_WALK_R2,
    isHomeIsland, inSandText: inSandTextZone, blockedAt,
    biomeAt: (x, y) => dominantBiome(x, y).biome, // allocates; only called when spawning / picking wander targets
    view: () => { viewRect.x = camX; viewRect.y = camY; viewRect.w = viewW / ZOOM; viewRect.h = viewH / ZOOM; return viewRect; },
    turtleAlive: () => deathTimer < 0,
    takeHit: n => {
      if (state === 'shell') return false; // a turtle tucked into its shell takes no enemy damage
      const r = window.Progression.takeHit(n);
      if (r !== false && window.TT_HAPTIC) window.TT_HAPTIC(); // skip while invulnerable
      return r;
    },
  });
  window.TurtleGame = { start, renderCosmeticPreview, setAdventureUnlocked, isAdventureUnlocked: () => adventureUnlocked, debugFinds: () => findPickups.items }; // debugFinds: console poking only

  // ---- Test mode (?test=1): no intro, no rAF loop. Math.random is seeded (top of file) and every
  // time input is a fixed number, so render() output is a pure function of the shot spec. Driven by
  // test/serve.py + TT_TEST.run(): renders each shot below and POSTs the PNG for byte comparison.
  if (TEST) {
    const P = window.Progression;
    const NONE = { color: 'color_default', hat: null, clothes: null, accessory: null };
    const ready = () => shore && grassReady && sprite.complete && shellMaskSheet &&
      Object.values(SPRITES).every(i => i.complete && i.naturalWidth) &&
      [coinImg, coconutImg].every(i => i.complete && i.naturalWidth);
    function shot(s) {
      turtle.x = s.x; turtle.y = s.y; turtle.vx = turtle.vy = 0; turtle.angle = s.angle || 0;
      walkFrame = s.walkFrame || 0; state = s.state || 'normal'; stateTime = s.stateTime || 0;
      moveMode = s.moveMode || 'walk'; floating = !!s.floating; floatClock = s.floatClock || 0;
      nightAmount = s.night || 0; gameTime = s.gameTime || 0; shakeTime = 0;
      P.state.homeLevel = s.homeLevel || 0;
      Object.assign(P.state.cosmetics.equipped, NONE, s.outfit || {});
      ripples.length = 0; for (const r of s.ripples || []) ripples.push({ scale: 1, lifetime: RIPPLE_LIFETIME, ...r });
      sandPuffs.length = 0; for (const p of s.puffs || []) sandPuffs.push(p);
      // Shore.js reuses its wave mask across frames at a sub-cell camera offset, so its output depends
      // on the previous shot. A throwaway draw at a different tick forces the real one to rebuild.
      drawShore((s.t || 0) + 777);
      render(s.t || 0);
      return canvas.toDataURL('image/png');
    }
    const near = (items, x, y) => items.reduce((b, i) => Math.hypot(i.x - x, i.y - y) < Math.hypot(b.x - x, b.y - y) ? i : b);
    const C = CENTER, ang = a => ({ x: C.x + Math.cos(a), y: C.y + Math.sin(a) });
    function shotList() {
      const L = [];
      const add = (name, s) => L.push([name, s]);
      // open water (ring between island and mainland), idle float + swim frames + wake ripples
      add('water_idle', { x: C.x + 400, y: C.y, moveMode: 'swim', floating: true, floatClock: 1.3, t: 12.3 });
      for (let f = 0; f < 4; f++) add('water_swim_f' + f, { x: C.x, y: C.y - 400, angle: -1.2, moveMode: 'swim', walkFrame: f, t: 3.7 + f,
        ripples: [{ x: C.x - 20, y: C.y - 380, age: 0.2 }, { x: C.x - 40, y: C.y - 360, age: 0.5 }, { x: C.x, y: C.y - 400, age: 0.4, scale: 1.6, lifetime: 1.6 }] });
      // island: shoreline, decor at several home levels, night glow
      add('island_shore_e', { x: C.x + 230, y: C.y + 20, t: 5.1 });
      add('island_home_l0', { x: HOME.x, y: HOME.y - 90, t: 1.1 });
      add('island_home_l4', { x: HOME.x, y: HOME.y, homeLevel: 4, t: 2.2 });
      add('island_home_max', { x: HOME.x - 20, y: HOME.y + 40, homeLevel: 20, t: 8.8 });
      add('island_home_night', { x: HOME.x, y: HOME.y, homeLevel: 20, night: 1, t: 8.8 });
      add('island_home_dusk', { x: HOME.x, y: HOME.y, homeLevel: 20, night: 0.4, t: 8.8 });
      // mainland shore + sand/grass edge in each biome, and the sand text
      for (const [n, a] of [['e', 0], ['s', Math.PI / 2], ['w', Math.PI], ['n', -Math.PI / 2]]) {
        const d = ang(a);
        for (const r of [WATER_OUTER_R - 20, WATER_OUTER_R + 120, WATER_OUTER_R + 330]) {
          add(`shore_${n}_${r - WATER_OUTER_R}`, { x: C.x + (d.x - C.x) * r, y: C.y + (d.y - C.y) * r, angle: a, t: 4.4 });
        }
      }
      add('sand_text', { x: SAND_TEXT_POS.x, y: SAND_TEXT_POS.y + 30, t: 6.6 });
      add('forest_deep_w', { x: C.x - 1800, y: C.y + 100, t: 2 });
      add('dead_deep_s', { x: C.x + 100, y: C.y + 1800, t: 2 });
      add('open_deep_e', { x: C.x + 1800, y: C.y - 100, t: 2 });
      add('beach_deep_n', { x: C.x - 100, y: C.y - 1800, t: 2 });
      add('biome_border_se', { x: C.x + 1300, y: C.y + 1300, t: 2 });
      add('world_corner', { x: 60, y: 60, t: 2 });
      add('world_edge_se', { x: WORLD_SIZE - 60, y: WORLD_SIZE - 400, t: 2 });
      // pickups (bob phase depends on gameTime) + mid-hop drop + sand puff
      for (const [k, p] of [['coin', coinPickups], ['coconut', coconutPickups], ['find', findPickups]]) {
        const it = near(p.items, C.x + 900, C.y - 700);
        add('pickup_' + k, { x: it.x + 50, y: it.y + 40, gameTime: 3.3, t: 1 });
        add('pickup_' + k + '_b', { x: it.x - 60, y: it.y + 10, gameTime: 4.1, t: 1 });
      }
      add('puff', { x: C.x + 100, y: C.y - WATER_OUTER_R - 200, t: 1, puffs: [
        { x: C.x + 90, y: C.y - WATER_OUTER_R - 220, vx: 0, vy: 0, r: 12, t: 0.2, life: 0.8 },
        { x: C.x + 120, y: C.y - WATER_OUTER_R - 190, vx: 0, vy: 0, r: 16, t: 0.5, life: 0.8 }] });
      // outfits, walk + swim + states, over sand and grass (4 walk frames each for the head bob/sway)
      const outfits = {
        none: {}, coral_straw_tshirt_bow: { color: 'color_coral', hat: 'hat_straw', clothes: 'clothes_tshirt', accessory: 'accessory_bowtie' },
        indigo_sailor_vest_scarf: { color: 'color_indigo', hat: 'hat_sailor', clothes: 'clothes_vest', accessory: 'accessory_scarf' },
        gold_flower_cape_crab: { color: 'color_gold', hat: 'hat_flower', clothes: 'clothes_cape', accessory: 'accessory_crab' },
        diving_goggles: { clothes: 'clothes_diving', accessory: 'accessory_goggles' },
      };
      for (const o in outfits) {
        for (let f = 0; f < 4; f++) {
          add(`outfit_${o}_walk${f}`, { x: C.x + 1100, y: C.y + 100, angle: 0.4, walkFrame: f, outfit: outfits[o], t: 2 });
        }
        add(`outfit_${o}_swim`, { x: C.x - 400, y: C.y, angle: 2.5, moveMode: 'swim', walkFrame: 1, outfit: outfits[o], t: 2 });
        for (const st of ['sleeping', 'stunned', 'shell']) add(`outfit_${o}_${st}`, { x: C.x - 1100, y: C.y, state: st, stateTime: 0.7, outfit: outfits[o], t: 2 });
      }
      return L;
    }
    window.TT_TEST = {
      ready, shot, shotList, init() { resize(); spawnTurtle(); P.attachSlot(null, null); },
      // mode 'ref' writes references, 'cur' writes to the current dir and reports match vs ref.
      async run(dir) {
        const tag = `${window.innerWidth}x${window.innerHeight}`;
        const res = { total: 0, same: 0, diff: [], missing: [] };
        resize(); spawnTurtle(); P.attachSlot(null, null);
        // Cosmetic images load lazily on first draw: touch every one, then let them finish loading.
        for (const id of ['hat_flower', 'hat_sailor', 'hat_straw', 'clothes_vest', 'clothes_tshirt', 'clothes_cape', 'clothes_diving',
          'accessory_bowtie', 'accessory_scarf', 'accessory_crab', 'accessory_goggles']) shot({ x: C.x, y: C.y, outfit: { [id.split('_')[0]]: id } });
        await new Promise(r => setTimeout(r, 1500));
        // Chrome lazily builds scaled copies of big sprites (e.g. pine_tall) after the first few draws, so
        // pass 1 renders slightly differently from every later pass. Discard one full pass so refs and
        // comparisons both start from the settled state.
        for (const [, spec] of shotList()) shot(spec);
        await new Promise(r => setTimeout(r, 300));
        for (const [name, spec] of shotList()) {
          const url = shot(spec);
          const r = await (await fetch(`/save?dir=${dir}&name=${tag}_${name}`, { method: 'POST', body: await (await fetch(url)).blob() })).json();
          res.total++;
          if (r.same === true) res.same++; else if (r.same === false) res.diff.push(name); else if (dir === 'cur') res.missing.push(name);
        }
        return res;
      },
    };
  }
})();
