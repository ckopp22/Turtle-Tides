(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // The canvas fills the window; 1 world unit = 1 CSS px, so the viewport (viewW x viewH,
  // set in resize()) just shows more world on a wide screen and more on a tall one — no letterboxing.

  // ---- World layout (MDD s3, revised 2026-09-28) ----
  // A small home island at the world center, a water ring around it, and a mainland ring beyond
  // that wraps all the way around, split into 4 compass biomes (N beach, E open forest, S dead
  // trees, W thick forest). World is square so all 4 directions have equal room to explore.
  const WORLD_SIZE = 5200;                          // ~5-6x a nominal 900px screen in each direction
  const CENTER = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
  const ISLAND_R = 260;                             // home island radius: safe area, no obstacles
  const WATER_WIDTH = 300;                          // water ring width beyond the island
  const WATER_OUTER_R = ISLAND_R + WATER_WIDTH;     // mainland starts here
  const EDGE_FOG_WIDTH = 260;                       // darkened fringe at the world border
  const WORLD_W = WORLD_SIZE, WORLD_H = WORLD_SIZE; // kept as separate names: rest of the file (camera,
                                                     // bounds clamp) already reads WORLD_W/WORLD_H
  const HOME = { x: CENTER.x, y: CENTER.y + 90 };

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
  function spawnTurtle() {
    turtle.x = HOME.x;
    turtle.y = HOME.y - 90;
    turtle.vx = 0; turtle.vy = 0;
    spawned = true;
  }

  // ---- Input -> normalized direction vector (length 0..1) ----
  const keys = new Set();
  // Turtle state: 'normal' | 'stunned' | 'sleeping' | 'shell'. Non-normal states can't move.
  // TODO: real triggers (bird hit, hunger/night, hide button); keys 1-4 are a debug switch for now.
  let state = 'normal';
  let stateTime = 0;
  const DEBUG_STATES = { 1: 'normal', 2: 'stunned', 3: 'sleeping', 4: 'shell' };
  const joy = { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0 };

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
  window.addEventListener('keydown', e => {
    if (typingInField()) return;
    if (DEBUG_STATES[e.key]) { state = DEBUG_STATES[e.key]; stateTime = 0; return; }
    const k = KEY_MAP[e.key.toLowerCase()];
    if (k) { keys.add(k); e.preventDefault(); }
  });
  window.addEventListener('keyup', e => {
    if (typingInField()) return;
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
  function biomeWeights(angle) {
    const w = {}; let sum = 0;
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

  // ---- Terrain: a color grid, blended per-pixel once at load, then drawn scaled up each frame
  // only for the visible camera slice. Fine enough resolution (4 world px/cell) that the shoreline
  // bands above look smooth rather than blocky; built in row chunks (a setTimeout each) so the
  // ~1.7M-pixel canvas never freezes the page or a phone while it loads. ----
  const TERRAIN_CELL = 4;          // world px per terrain grid cell
  const TERRAIN_ROWS_PER_CHUNK = 40; // rows computed per chunk while building
  const FOG_COLOR = [8, 28, 36];
  function buildTerrainChunked() {
    const cols = Math.ceil(WORLD_SIZE / TERRAIN_CELL), rows = cols;
    const c = document.createElement('canvas');
    c.width = cols; c.height = rows;
    const g = c.getContext('2d');
    const img = g.createImageData(cols, rows);

    let ry = 0;
    function step() {
      const end = Math.min(ry + TERRAIN_ROWS_PER_CHUNK, rows);
      for (; ry < end; ry++) {
        const y = ry * TERRAIN_CELL;
        for (let rx = 0; rx < cols; rx++) {
          const x = rx * TERRAIN_CELL;
          let col = shorelineGroundColor(x, y);
          // Deep-water/fog fringe at the world border so the edge reads as a boundary, not a cliff.
          const edgeDist = Math.min(x, y, WORLD_SIZE - x, WORLD_SIZE - y);
          if (edgeDist < EDGE_FOG_WIDTH) col = lerpColor(col, FOG_COLOR, 1 - edgeDist / EDGE_FOG_WIDTH);
          const i = (ry * cols + rx) * 4;
          img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0); // flush progress so the page shows the map filling in, not a freeze
      if (ry < rows) setTimeout(step, 0);
    }
    step();
    return c;
  }
  // Built once at load (reused as-is on resize); rebuilding only makes sense if WORLD_SIZE or the
  // noise seed ever changes, neither of which happens at runtime.
  const terrainCanvas = buildTerrainChunked();

  function drawTerrain() {
    // Map the visible world rect straight onto the low-res grid and let drawImage scale it up —
    // cheap regardless of world size since we never rasterize full-res terrain.
    const vw = viewW / ZOOM, vh = viewH / ZOOM;
    const sx = camX / TERRAIN_CELL, sy = camY / TERRAIN_CELL;
    const sw = vw / TERRAIN_CELL, sh = vh / TERRAIN_CELL;
    ctx.imageSmoothingEnabled = true; // let the upscale add extra softness to the shoreline blend
    ctx.drawImage(terrainCanvas, sx, sy, sw, sh, camX, camY, vw, vh);
  }

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
  // themselves in drawGrassTextures() and just need a plain land color underneath, from
  // shorelineGroundColor()). Every coastline gets a sand band before grass takes over — using the
  // same SHORE_WET_BAND+SHORE_DRY_BAND distance buildGrassLayers() already fades grass in past, so
  // the two line up — not just the beach biome's own sector (which stays sand all the way inland).
  const SHORE_SAND_BAND = -(SHORE_WET_BAND + SHORE_DRY_BAND);
  const shoreCols = Math.ceil(WORLD_SIZE / Shore.TILE), shoreRows = shoreCols;
  const shoreMap = [];
  for (let ty = 0; ty < shoreRows; ty++) {
    const row = [];
    const y = ty * Shore.TILE + Shore.TILE / 2;
    for (let tx = 0; tx < shoreCols; tx++) {
      const x = tx * Shore.TILE + Shore.TILE / 2;
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
    });
  }
  // shore.draw() expects a plain, untransformed ctx (1 canvas px = 1 world px, its own camX/camY
  // bookkeeping does the scrolling) — it doesn't know about this game's ZOOM. So it's rendered onto
  // its own world-sized scratch canvas first, then that scratch is drawn into the real ctx with a
  // world-space dest rect, same as drawTerrain()/drawGrassTextures() already do, so ZOOM applies to
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
  function buildGrassLayers() {
    const cols = Math.ceil(WORLD_SIZE / GRASS_CELL), rows = cols;
    const layers = {};
    for (const key of GRASS_BIOME_KEYS) {
      const maskC = document.createElement('canvas'); maskC.width = cols; maskC.height = rows;
      const varC = document.createElement('canvas'); varC.width = cols; varC.height = rows;
      layers[key] = {
        maskCtx: maskC.getContext('2d'), maskImg: maskC.getContext('2d').createImageData(cols, rows), maskCanvas: maskC,
        varCtx: varC.getContext('2d'), varImg: varC.getContext('2d').createImageData(cols, rows), varCanvas: varC,
      };
    }
    const tileStart = -(SHORE_WET_BAND + SHORE_DRY_BAND);
    for (let ry = 0; ry < rows; ry++) {
      const y = ry * GRASS_CELL;
      for (let rx = 0; rx < cols; rx++) {
        const x = rx * GRASS_CELL;
        const { d, nearIsland } = shoreSignedDist(x, y);
        const i = (ry * cols + rx) * 4;
        let w = null, landFade = 0;
        if (!nearIsland && d <= tileStart) {
          landFade = smoothstep(tileStart, tileStart - GROUND_TILE_FADE, d) * (1 - sandTextFade(x, y));
          if (landFade > 0) {
            const dx = x - CENTER.x, dy = y - CENTER.y;
            w = biomeWeights(Math.atan2(dy, dx) + biomeAngleNoise(x, y));
          }
        }
        const patch = noise2(x / 260 + 500, y / 260 + 500); // soft, large-scale color variation
        for (const key of GRASS_BIOME_KEYS) {
          const l = layers[key];
          const alpha = w ? w[key] * landFade : 0;
          l.maskImg.data[i] = l.maskImg.data[i + 1] = l.maskImg.data[i + 2] = 255;
          l.maskImg.data[i + 3] = Math.round(alpha * 255);
          const c = GRASS_VARIATION_COLORS[key];
          const col = lerpColor(c.dark, c.light, patch);
          l.varImg.data[i] = col[0]; l.varImg.data[i + 1] = col[1]; l.varImg.data[i + 2] = col[2];
          l.varImg.data[i + 3] = Math.round(0.15 * 255); // low opacity, clipped to the mask at draw time
        }
      }
    }
    for (const key of GRASS_BIOME_KEYS) {
      layers[key].maskCtx.putImageData(layers[key].maskImg, 0, 0);
      layers[key].varCtx.putImageData(layers[key].varImg, 0, 0);
    }
    return layers;
  }
  const grassLayers = buildGrassLayers();
  const grassPatterns = {};
  function getGrassPattern(key) {
    if (grassPatterns[key]) return grassPatterns[key];
    const img = GRASS_BIOMES[key].imgEl;
    if (!img.complete || !img.naturalWidth) return null;
    return (grassPatterns[key] = ctx.createPattern(buildSeamlessTile(img), 'repeat'));
  }
  // Cheap presence check (a few sample points) so a biome with nothing in view this frame is
  // skipped entirely rather than compositing an empty viewport-sized layer.
  function grassBiomeInView(key, rcx, rcy, vw, vh) {
    const pts = [[rcx, rcy], [rcx + vw, rcy], [rcx, rcy + vh], [rcx + vw, rcy + vh], [rcx + vw / 2, rcy + vh / 2]];
    for (const [x, y] of pts) {
      const dx = x - CENTER.x, dy = y - CENTER.y;
      if (biomeWeights(Math.atan2(dy, dx) + biomeAngleNoise(x, y))[key] > 0.02) return true;
    }
    return false;
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

  let grassScratch = null;
  function ensureGrassScratch() {
    if (!grassScratch) grassScratch = document.createElement('canvas');
    const w = Math.max(1, Math.round(viewW * dpr)), h = Math.max(1, Math.round(viewH * dpr));
    if (grassScratch.width !== w || grassScratch.height !== h) { grassScratch.width = w; grassScratch.height = h; }
    return grassScratch;
  }
  // Per biome: pattern-fill a scratch canvas, mask it to that biome's blend weight
  // (destination-in), wash the noise-variation layer and tint over it (source-atop, so both stay
  // clipped to the mask's alpha), then composite the result over the terrain (source-over) — never
  // destructive to what's already drawn, so the 3 biomes crossfade naturally at their borders.
  function drawGrassTextures() {
    const vw = viewW / ZOOM, vh = viewH / ZOOM;
    // Whole-pixel camera for the pattern fill only, so it doesn't shimmer while moving; everything
    // else (terrain, scenery) keeps using the exact sub-pixel camX/camY as before.
    const rcx = Math.round(camX), rcy = Math.round(camY);
    const scratch = ensureGrassScratch();
    const sctx = scratch.getContext('2d');

    for (const key of GRASS_BIOME_KEYS) {
      if (!grassBiomeInView(key, rcx, rcy, vw, vh)) continue;
      const pattern = getGrassPattern(key);
      const layer = grassLayers[key];
      if (!pattern || !layer) continue;
      const cfg = GRASS_BIOMES[key];

      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sctx.clearRect(0, 0, viewW, viewH);
      sctx.save();
      sctx.scale(ZOOM, ZOOM);
      sctx.translate(-rcx, -rcy);
      sctx.fillStyle = pattern;
      sctx.fillRect(rcx, rcy, vw, vh);
      sctx.restore(); // back to screen space (dpr-only transform)

      const sx = rcx / GRASS_CELL, sy = rcy / GRASS_CELL, sw = vw / GRASS_CELL, sh = vh / GRASS_CELL;
      sctx.globalCompositeOperation = 'destination-in';
      sctx.drawImage(layer.maskCanvas, sx, sy, sw, sh, 0, 0, viewW, viewH);

      sctx.globalCompositeOperation = 'source-atop';
      sctx.drawImage(layer.varCanvas, sx, sy, sw, sh, 0, 0, viewW, viewH);
      if (cfg.tintColor) {
        sctx.fillStyle = `rgba(${cfg.tintColor[0]}, ${cfg.tintColor[1]}, ${cfg.tintColor[2]}, ${cfg.tintAlpha})`;
        sctx.fillRect(0, 0, viewW, viewH);
      }
      sctx.globalCompositeOperation = 'source-over';

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = cfg.opacity;
      ctx.drawImage(scratch, 0, 0, viewW, viewH);
      ctx.restore();
    }
    // TODO: if this costs noticeable frame rate on mobile, fall back to drawing each pattern at a
    // flat reduced alpha straight over the terrain (skip the mask/tint compositing) instead.
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
  const SPACING = { forestThick: 120, forestOpen: 150, deadTrees: 140, beach: 170 };
  const scenery = [];       // { x, y, r, h, sprite, type, collide } — everything drawn
  let obstacleGrid;         // built after placement: cell key -> array of scenery indices (collide only)
  const OBSTACLE_CELL = 220;

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
  for (const name of ['pine_tall', 'oak_tree', 'tree_cluster3', 'round_tree_med', 'round_tree_single',
    'pine_sapling', 'dead_tree_med', 'dead_tree_small', 'round_tree_small',
    'driftwood_stick', 'sandcastle_big', 'rock_beach']) {
    const img = new Image();
    img.onload = () => computeSpriteBBox(img, name);
    img.src = `assets/scenery/${name}.png`;
    SPRITES[name] = img;
  }
  // Per-biome tree sprite choices, weighted toward the look each biome calls for.
  const BIOME_TREES = {
    forestThick: [{ sprite: 'pine_tall', h: 190 }, { sprite: 'tree_cluster3', h: 150 }, { sprite: 'pine_sapling', h: 110 }],
    forestOpen: [{ sprite: 'oak_tree', h: 140 }, { sprite: 'round_tree_med', h: 115 }, { sprite: 'round_tree_single', h: 110 }],
    deadTrees: [{ sprite: 'dead_tree_med', h: 115 }, { sprite: 'dead_tree_small', h: 95 }],
  };
  function pickTree(biome) {
    const opts = BIOME_TREES[biome];
    return opts[Math.floor(rand() * opts.length)];
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

  function placeScenery() {
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

    const ATTEMPTS = 30000;
    for (let i = 0; i < ATTEMPTS; i++) {
      const x = rand() * WORLD_SIZE, y = rand() * WORLD_SIZE;
      const dist = Math.hypot(x - CENTER.x, y - CENTER.y);
      if (dist <= WATER_OUTER_R + 20) continue;               // never on the island or in the water
      if (dist > WORLD_SIZE / 2 - EDGE_FOG_WIDTH * 0.4) continue; // keep the far fog fringe emptier
      if (inSandTextZone(x, y)) continue;                     // keep the sand-text patch clear of scenery
      const { biome, weight } = dominantBiome(x, y);
      if (weight < 0.55) continue; // blend zone between two biomes: leave it sparser/transitional
      const spacing = SPACING[biome];
      if (tooClose(x, y, spacing)) continue;
      markPlaced(x, y, spacing);

      if (biome === 'beach' && rand() < 0.1) {
        scenery.push({ x, y, r: 34, cr: 36, type: 'sprite', sprite: 'rock_beach', h: 76, collide: true });
      } else if (biome === 'beach' && rand() < 0.14) {
        scenery.push({ x, y, r: 12, cr: 18, type: 'sprite', sprite: 'driftwood_stick', h: 60, collide: true });
      } else if (biome === 'beach' && rand() < 0.06) {
        // rare beach flourish, straight off the reference sheet
        scenery.push({ x, y, r: 24, cr: 38, type: 'sprite', sprite: 'sandcastle_big', h: 90, collide: true });
      } else if (biome === 'beach') {
        // none of the beach rolls hit for this spot: leave it bare sand, no tree fallback
      } else if (shoreSignedDist(x, y).d > SHORE_SAND_BAND) {
        // Inside the mainland's outer sand ring (every coastline gets one, not just the beach
        // biome) — leave it bare, no trees on sand.
      } else {
        const t = pickTree(biome);
        const r = biome === 'forestThick' ? 14 : 12;
        // Trees always collide as a small circle at the trunk's base, not the sprite's full alpha
        // bbox — circleOnly skips the tight-bbox hitbox in resolveObstacleCollisions/debug draw
        // below, so the turtle can walk behind the canopy and only bumps where the trunk meets the
        // ground. cy nudges the circle's center up a bit above the anchor point (y), which reads
        // more like the actual trunk width than one centered right at the ground contact line.
        // tree_cluster3 is 3 trunks side by side, not 1 — gets a single triangular `poly` hitbox
        // (see getTrunkPolygon/pushCircleOutOfPolygon) instead of the single cr/cy circle every
        // other tree uses, point facing down toward the sprite's anchor.
        const entry = { x, y, r, type: 'sprite', sprite: t.sprite, h: t.h * (0.85 + rand() * 0.3), collide: true, circleOnly: true };
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
        scenery.push(entry);
      }
    }
  }
  placeScenery();

  function buildObstacleGrid() {
    obstacleGrid = new Map();
    scenery.forEach((s, idx) => {
      if (!s.collide) return;
      const k = `${Math.floor(s.x / OBSTACLE_CELL)},${Math.floor(s.y / OBSTACLE_CELL)}`;
      if (!obstacleGrid.has(k)) obstacleGrid.set(k, []);
      obstacleGrid.get(k).push(idx);
    });
  }
  buildObstacleGrid();

  function nearbyObstacles(x, y, radius) {
    const out = [];
    const cx = Math.floor(x / OBSTACLE_CELL), cy = Math.floor(y / OBSTACLE_CELL);
    const span = Math.ceil(radius / OBSTACLE_CELL) + 1;
    for (let gy = cy - span; gy <= cy + span; gy++) for (let gx = cx - span; gx <= cx + span; gx++) {
      const arr = obstacleGrid.get(`${gx},${gy}`);
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
  function drawSceneryWithTurtle(list) {
    list.sort((a, b) => a.y - b.y); // cheap back-to-front depth sort of the (small) visible set
    const turtleDepthY = turtle.y + TURTLE_DEPTH_FRONT_OFFSET;
    let drawnTurtle = false;
    for (const s of list) {
      if (!drawnTurtle && turtleDepthY < s.y) { drawTurtle(); drawnTurtle = true; }
      drawScenerySprite(s);
    }
    if (!drawnTurtle) drawTurtle();
  }

  function drawScenerySprite(s) {
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
      }
  }

  // ---- Coins: simple floating currency pickups scattered around the world (island + mainland,
  // never in water). Collecting one adds to `coinCount` (inventory system TODO: more to come —
  // shop, spending, loss-on-death, etc. — this is just pickup + respawn for now).
  const COIN_COUNT = 30;
  const COIN_PICKUP_RADIUS = 26;   // world px, added to TURTLE_BODY_RADIUS for the pickup check
  const COIN_RESPAWN_SECONDS = 20; // time a collected coin stays gone before respawning elsewhere
  const COIN_DRAW_H = 30;          // world px, drawn height of the coin sprite
  const COIN_BOB_SPEED = 2.4;      // radians/sec
  const COIN_BOB_AMPLITUDE = 6;    // world px of vertical bob
  const coinImg = new Image();
  coinImg.src = 'assets/items/coin.png';
  const coins = [];
  let coinCount = 0;
  let gameTime = 0;

  // Picks a random spot that's not in water and not on the sand-text patch. Used both for initial
  // placement and respawning; falls back to whatever the last attempt found if it never finds a
  // clean spot (extremely unlikely given how little of the world that excludes).
  function randomCoinSpot() {
    let x = CENTER.x, y = CENTER.y;
    for (let i = 0; i < 200; i++) {
      x = rand() * WORLD_SIZE;
      y = rand() * WORLD_SIZE;
      const distFromCenter = Math.hypot(x - CENTER.x, y - CENTER.y);
      if (distFromCenter > WORLD_SIZE / 2 - EDGE_FOG_WIDTH * 0.4) continue; // keep clear of the far fog fringe
      if (isWater(x, y)) continue;
      if (inSandTextZone(x, y)) continue;
      break;
    }
    return { x, y };
  }

  function respawnCoin(c) {
    const p = randomCoinSpot();
    c.x = p.x; c.y = p.y;
    c.active = true;
  }

  function initCoins() {
    for (let i = 0; i < COIN_COUNT; i++) {
      const p = randomCoinSpot();
      coins.push({ x: p.x, y: p.y, active: true, respawnAt: 0, bobSeed: rand() * Math.PI * 2 });
    }
  }
  initCoins();

  function updateCoins(dt) {
    const pickupDist = TURTLE_BODY_RADIUS + COIN_PICKUP_RADIUS;
    for (const c of coins) {
      if (!c.active) {
        if (gameTime >= c.respawnAt) respawnCoin(c);
        continue;
      }
      if (Math.hypot(turtle.x - c.x, turtle.y - c.y) < pickupDist) {
        c.active = false;
        c.respawnAt = gameTime + COIN_RESPAWN_SECONDS;
        coinCount++;
      }
    }
  }

  function drawCoins() {
    if (!coinImg.complete || !coinImg.naturalWidth) return;
    const dw = COIN_DRAW_H * coinImg.naturalWidth / coinImg.naturalHeight;
    const vw = viewW / ZOOM, vh = viewH / ZOOM, margin = 60;
    for (const c of coins) {
      if (!c.active) continue;
      if (c.x < camX - margin || c.x > camX + vw + margin || c.y < camY - margin || c.y > camY + vh + margin) continue;
      const bob = Math.sin(gameTime * COIN_BOB_SPEED + c.bobSeed) * COIN_BOB_AMPLITUDE;
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.ellipse(c.x, c.y + 4, dw * 0.32, dw * 0.14, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.drawImage(coinImg, c.x - dw / 2, c.y - COIN_DRAW_H / 2 + bob, dw, COIN_DRAW_H);
    }
  }

  // Screen-space HUD: coin count, top-left. TODO: fold into a real inventory HUD once the
  // shell/coconut/carry-capacity systems land per the MDD.
  function drawCoinHUD() {
    if (!coinImg.complete || !coinImg.naturalWidth) return;
    const pad = 14, iconSize = 28;
    ctx.save();
    ctx.font = '600 20px system-ui, sans-serif';
    const label = String(coinCount);
    const textW = ctx.measureText(label).width;
    const boxW = iconSize + 10 + textW + pad * 2;
    const boxH = iconSize + pad;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.roundRect(pad, pad, boxW, boxH, boxH / 2);
    ctx.fill();
    ctx.drawImage(coinImg, pad + pad / 2, pad + boxH / 2 - iconSize / 2, iconSize, iconSize);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pad + pad / 2 + iconSize + 10, pad + boxH / 2 + 1);
    ctx.restore();
  }

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

  // ---- Update ----
  function update(dt) {
    stateTime += dt;
    gameTime += dt;
    updateCoins(dt);
    const dir = state === 'normal' ? getDirection() : { x: 0, y: 0 };
    const inWater = isWater(turtle.x, turtle.y);
    const speedMult = inWater ? WATER_SPEED_MULT : LAND_SPEED_MULT;
    const tvx = dir.x * MAX_SPEED * speedMult, tvy = dir.y * MAX_SPEED * speedMult;
    const hasInput = dir.x !== 0 || dir.y !== 0;
    const rate = (hasInput ? ACCEL : DECEL) * dt;

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
  let dpr = 1, viewW = 0, viewH = 0;

  function clampToWorld() {
    const r = TURTLE_RADIUS;
    turtle.x = Math.max(r, Math.min(WORLD_W - r, turtle.x));
    turtle.y = Math.max(r, Math.min(WORLD_H - r, turtle.y));
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    // Backing store scales up for retina sharpness; CSS size (set in style.css) stays at window size.
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    if (spawned) clampToWorld(); // keep the turtle in bounds after a phone rotation, etc.
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  // Camera: centers on the turtle, clamped so the view never shows past the world edge.
  // (If the viewport is ever bigger than the world, e.g. a very wide monitor, center the world instead.)
  const ZOOM = 0.85; // slightly zoomed out so the player sees more of the map around the turtle
  let camX = 0, camY = 0;
  function updateCamera() {
    const vw = viewW / ZOOM, vh = viewH / ZOOM;
    camX = WORLD_W <= vw ? (WORLD_W - vw) / 2 : Math.max(0, Math.min(WORLD_W - vw, turtle.x - vw / 2));
    camY = WORLD_H <= vh ? (WORLD_H - vh) / 2 : Math.max(0, Math.min(WORLD_H - vh, turtle.y - vh / 2));
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

  // Idle-on-water bob: set each frame in update() (floating = stationary + in water + normal
  // state), floatClock is a free-running seconds counter driving the sine so the bob doesn't jump
  // or reset whenever floating toggles on/off.
  let floatClock = 0;
  let floating = false;
  const FLOAT_BOB_SPEED = 2.2;   // radians/sec
  const FLOAT_BOB_AMPLITUDE = 4; // world px of vertical drift

  function drawTurtle() {
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
    ctx.translate(turtle.x, turtle.y + bobY);
    ctx.rotate(turtle.angle + Math.PI / 2); // art faces up, angle 0 = right
    if (state === 'normal' && moveMode === 'walk' && f === 3) ctx.scale(-1, 1); // mirror the last walk frame so the head swings left (sheet only has right)
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

  function render(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 1 ctx unit = 1 CSS px; backing store already has the dpr scale-up
    ctx.fillStyle = '#0b3d4f';
    ctx.fillRect(0, 0, viewW, viewH);

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, viewW, viewH); ctx.clip();
    updateCamera();
    ctx.scale(ZOOM, ZOOM);
    ctx.translate(-camX, -camY);

    drawTerrain();
    drawGrassTextures();
    if (shore) drawShore(t);
    drawRipples(); // above water, below turtle/scenery
    drawSandText();
    ctx.drawImage(islandDetail.canvas, islandDetail.worldX, islandDetail.worldY);
    drawCoins();

    // Cull scenery to the visible world rect (plus a small margin) so a big world with lots of
    // trees still draws only a couple dozen-to-hundred objects per frame.
    const vw = viewW / ZOOM, vh = viewH / ZOOM, margin = 80;
    const visible = scenery.filter(s =>
      s.x > camX - margin && s.x < camX + vw + margin && s.y > camY - margin && s.y < camY + vh + margin);
    drawSceneryWithTurtle(visible);
    if (DEBUG_HITBOXES) drawDebugHitboxes(visible);
    ctx.restore();

    drawJoystick(); // screen space
    drawCoinHUD();  // screen space
  }

  let last;
  function frame(now) {
    // Clamp to >= 0: the first rAF timestamp can predate the performance.now() start() recorded,
    // and a negative dt made the accel branch below evaluate 0/0, poisoning the turtle's velocity
    // (and then its position, and the camera) with NaN for the rest of the session.
    const dt = Math.min(Math.max(0, (now - last) / 1000), 0.05);
    last = now;
    update(dt);
    render(now / 1000);
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
  function start() {
    if (started) return;
    started = true;
    resize();
    if (!window.innerWidth || !window.innerHeight) { started = false; requestAnimationFrame(start); return; }
    if (!grassReady) { started = false; requestAnimationFrame(start); return; } // wait for grass textures so nothing draws untextured
    if (!shore) { started = false; requestAnimationFrame(start); return; } // wait for Shore.js's sand/water tiles too
    spawnTurtle();
    last = performance.now();
    requestAnimationFrame(frame);
  }
  window.TurtleGame = { start };
})();
