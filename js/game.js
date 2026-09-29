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

  // ---- Shoreline rendering (visual only — gameplay still uses the perfect-circle ISLAND_R /
  // WATER_OUTER_R above for collision, speed and biome logic; none of that changes here). ----
  const SHORE_DEEP_COLOR = [20, 90, 160];    // open water, far from any shore
  const SHORE_SHALLOW_COLOR = [70, 190, 210]; // water near the shoreline
  const SHORE_WET_SAND_COLOR = [190, 170, 120]; // sand just past the waterline
  const SHORE_DRY_SAND_COLOR = [235, 215, 160]; // sand further inland (the island's ground color)
  const SHORE_DEEP_BAND = 90;   // world px of water past the shoreline before it reads as full "deep"
  const SHORE_WET_BAND = 40;    // world px of land past the shoreline that reads as wet sand
  const SHORE_DRY_BAND = 50;    // world px past the wet band that fades wet sand into dry sand/biome
  const SHORE_NOISE_AMPLITUDE = 40; // +/- world px the shoreline wanders from its base radius
  // Two independent angle-noise samples (different frequency + offset into the same seeded noise
  // field) so the island and mainland coastlines wobble differently rather than looking identical.
  const ISLAND_SHORE_FREQ = 3.2, ISLAND_SHORE_SEED_OFFSET = 0;
  const OUTER_SHORE_FREQ = 5.5, OUTER_SHORE_SEED_OFFSET = 97;
  const FOAM_WIDTH = 3, FOAM_ALPHA = 0.5;       // thin, semi-transparent waterline stroke
  const FOAM_PULSE_AMPLITUDE = 6;               // world px the foam line breathes in/out
  const FOAM_PULSE_SPEED = 1.2;                 // radians/sec
  const FOAM_ANGLE_STEPS = 180;                 // resolution the shoreline is traced at (2deg steps)

  const TURTLE_RADIUS = 36;
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
  // groundTileFor(), so tiled ground art only appears where the water/sand blend has fully
  // resolved to land, never floating over water on the noisy side of the old perfect-circle radius.
  function shoreSignedDist(x, y) {
    const dx = x - CENTER.x, dy = y - CENTER.y;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const rIsland = ISLAND_R + shoreWobble(angle, ISLAND_SHORE_SEED_OFFSET, ISLAND_SHORE_FREQ);
    const rOuter = WATER_OUTER_R + shoreWobble(angle, OUTER_SHORE_SEED_OFFSET, OUTER_SHORE_FREQ);
    const nearIsland = dist < (rIsland + rOuter) / 2;
    return { d: nearIsland ? dist - rIsland : rOuter - dist, nearIsland }; // negative land, positive water
  }

  // The blended ground color at one point: gets its distance from the nearer shoreline and
  // smoothsteps through deep water -> shallow water -> wet sand -> dry sand/biome color across it.
  function shorelineGroundColor(x, y) {
    const { d, nearIsland } = shoreSignedDist(x, y);

    if (d >= SHORE_DEEP_BAND) return SHORE_DEEP_COLOR;
    if (d >= 0) return lerpColor(SHORE_SHALLOW_COLOR, SHORE_DEEP_COLOR, smoothstep(0, SHORE_DEEP_BAND, d));
    if (d >= -SHORE_WET_BAND) {
      return lerpColor(SHORE_WET_SAND_COLOR, SHORE_SHALLOW_COLOR, smoothstep(-SHORE_WET_BAND, 0, d));
    }
    // Past the wet-sand band: the island is sand all the way to its center, but the mainland's
    // land color depends on which biome this angle falls in, same blend buildTerrain always used.
    let landColor;
    if (nearIsland) {
      landColor = SHORE_DRY_SAND_COLOR;
    } else {
      const dx = x - CENTER.x, dy = y - CENTER.y;
      const w = biomeWeights(Math.atan2(dy, dx) + biomeAngleNoise(x, y));
      landColor = [0, 0, 0];
      for (const k in w) {
        landColor[0] += BIOME_COLOR[k][0] * w[k];
        landColor[1] += BIOME_COLOR[k][1] * w[k];
        landColor[2] += BIOME_COLOR[k][2] * w[k];
      }
    }
    const dryEnd = -(SHORE_WET_BAND + SHORE_DRY_BAND);
    if (d >= dryEnd) return lerpColor(landColor, SHORE_WET_SAND_COLOR, smoothstep(dryEnd, -SHORE_WET_BAND, d));
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

  // None of the tile art (sand1/2, grass1/2) tiles cleanly on its own — opposite edges don't match,
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

  // ---- Ground texture tiles: real art laid over the flat-color terrain blend above (water stays
  // plain color + shimmer, no tile). Beach (north) only now — the 3 grass biomes use the
  // pattern-based drawGrassTextures() below instead of a tiled grid. Plain, regular repeating
  // tiles, full opacity, no rotation, no blur. ----
  const GROUND_TILE_PX = 96;
  const GROUND_TILES = {};
  for (const name of ['sand1', 'sand2']) {
    const img = new Image();
    const entry = { canvas: null };
    img.onload = () => { entry.canvas = buildSeamlessTile(img); };
    img.src = `assets/tiles/${name}.png`;
    GROUND_TILES[name] = entry;
  }
  const GROUND_TILE_FADE = 90; // world px inland over which tiles fade up to full opacity
  // Returns the sand tile for this point and how opaque it should be: tiles start past the
  // shoreline's wet/dry sand blend (using the same noisy shoreline as the color blend, not the old
  // perfect circle) and fade up from there, so the grid never cuts a hard edge across the beach.
  function groundTileFor(x, y) {
    const { d, nearIsland } = shoreSignedDist(x, y);
    if (nearIsland) return null; // island art handles its own ground, no tile
    const tileStart = -(SHORE_WET_BAND + SHORE_DRY_BAND);
    if (d > tileStart) return null; // still in the water/sand blend band
    // Fade the tile by beach's own (non-argmax) weight, the same way drawGrassTextures() fades its
    // 3 biomes, rather than gating on which biome wins. The angle noise is strong enough (+-35deg)
    // that 'beach' can win the argmax well inside forestThick's own sector — that stamped a stray
    // full-opacity sand block mid-forest, since the underlying color blend below is a soft weighted
    // average but the old argmax check turned it into a hard on/off switch.
    const dx = x - CENTER.x, dy = y - CENTER.y;
    const beachWeight = biomeWeights(Math.atan2(dy, dx) + biomeAngleNoise(x, y)).beach;
    const biomeFade = smoothstep(0.35, 0.65, beachWeight);
    if (biomeFade <= 0) return null;
    const variant = hash2(Math.floor(x / GROUND_TILE_PX), Math.floor(y / GROUND_TILE_PX)) < 0.5;
    const tile = variant ? GROUND_TILES.sand1 : GROUND_TILES.sand2;
    return { tile, alpha: smoothstep(tileStart, tileStart - GROUND_TILE_FADE, d) * biomeFade };
  }
  function drawGroundTextures() {
    const vw = viewW / ZOOM, vh = viewH / ZOOM;
    const x0 = Math.floor(camX / GROUND_TILE_PX) * GROUND_TILE_PX;
    const y0 = Math.floor(camY / GROUND_TILE_PX) * GROUND_TILE_PX;
    for (let y = y0; y < camY + vh; y += GROUND_TILE_PX) {
      for (let x = x0; x < camX + vw; x += GROUND_TILE_PX) {
        const t = groundTileFor(x + GROUND_TILE_PX / 2, y + GROUND_TILE_PX / 2);
        if (t && t.tile.canvas) {
          ctx.globalAlpha = t.alpha;
          ctx.drawImage(t.tile.canvas, x, y, GROUND_TILE_PX, GROUND_TILE_PX);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- Grass biome textures (east/west/south only — north beach keeps sand, untouched above).
  // Per-biome config so each is easy to tweak; grass1/grass2 aren't seamless tiles (see note below),
  // so both are reused across biomes and differentiated with a tint wash + opacity instead of
  // needing 3 distinct source images.
  // grass1.png/grass2.png don't tile cleanly on their own (edge pixels don't match their opposite
  // edge) — getGrassPattern() below runs each through buildSeamlessTile() before patterning it.
  const GRASS_BIOMES = {
    // TODO: preview swap to grass3.png (new repeating texture) for all 3 biomes — revert or keep per feedback.
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

  // Low-res per-biome mask (alpha = that biome's weight, faded to 0 by the same shoreline band the
  // sand tiles use, so grass always stops before the wet sand — see groundTileFor above) and a
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
          landFade = smoothstep(tileStart, tileStart - GROUND_TILE_FADE, d);
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

  // ---- Home island detail: sand, dunes, tide pools, the home rock pile — pre-rendered once to a
  // small canvas (island-sized, not world-sized) and stamped at the island's world position. ----
  function buildIslandDetail() {
    const pad = 80;
    const size = (ISLAND_R + pad) * 2;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    const cx = size / 2, cy = size / 2;
    const homeX = cx + (HOME.x - CENTER.x), homeY = cy + (HOME.y - CENTER.y);

    // No base sand fill here: the terrain canvas now paints the island's ground color itself
    // (including its noisy shoreline blend), so this transparent layer only adds texture on top.

    // Dunes: soft darker sand bumps.
    for (let i = 0, n = 0; n < 14 && i < 400; i++) {
      const ang = rand() * Math.PI * 2, rr = rand() * (ISLAND_R - 50);
      const x = cx + Math.cos(ang) * rr, y = cy + Math.sin(ang) * rr;
      g.beginPath(); g.ellipse(x, y, 26 + rand() * 16, 10 + rand() * 6, 0, 0, Math.PI * 2);
      g.fillStyle = '#e8d391'; g.fill(); n++;
    }
    // Tide pools, kept away from home.
    for (let i = 0, n = 0; n < 3 && i < 400; i++) {
      const ang = rand() * Math.PI * 2, rr = rand() * (ISLAND_R - 90);
      const x = cx + Math.cos(ang) * rr, y = cy + Math.sin(ang) * rr;
      if (Math.hypot(x - homeX, y - homeY) < 160) continue;
      g.beginPath(); g.ellipse(x, y, 26, 16, 0, 0, Math.PI * 2); g.fillStyle = '#c9b57a'; g.fill();
      g.beginPath(); g.ellipse(x, y, 19, 11, 0, 0, Math.PI * 2); g.fillStyle = '#5ec8d0'; g.fill(); n++;
    }
    // Home: rock pile (fixed landmark; level art comes with upgrades).
    for (const [dx, dy, r] of [[-34, 6, 26], [8, 14, 30], [40, 0, 22], [-8, -22, 24], [22, -20, 18]]) {
      g.fillStyle = '#7d7d82'; g.beginPath(); g.arc(homeX + dx, homeY + dy, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#9a9aa0'; g.beginPath(); g.arc(homeX + dx - 4, homeY + dy - 5, r * 0.6, 0, Math.PI * 2); g.fill();
    }
    return { canvas: c, worldX: CENTER.x - cx, worldY: CENTER.y - cy, size };
  }
  const islandDetail = buildIslandDetail();

  // ---- Mainland scenery: trees (all 4 biomes) and beach rocks are obstacles (trunk-only circle
  // collision); driftwood is decorative. Placed by dart-throwing so spacing stays natural, with a
  // per-biome minimum distance so the west forest reads dense but the east forest stays open. ----
  const SPACING = { forestThick: 100, forestOpen: 150, deadTrees: 140, beach: 170 };
  const scenery = [];       // { x, y, r, h, sprite, type, collide } — everything drawn
  let obstacleGrid;         // built after placement: cell key -> array of scenery indices (collide only)
  const OBSTACLE_CELL = 220;

  // Pixel-art scenery sprites (sliced from the reference sheet). Each entry is drawn `h` world-px
  // tall, scaled to its own aspect ratio; collision still uses the small trunk radius `r`, not the
  // full (much bigger) canopy, per the trunk-only collision spec.
  const SPRITES = {};
  for (const name of ['pine_tall', 'oak_tree', 'tree_cluster3', 'round_tree_med', 'round_tree_single',
    'pine_sapling', 'dead_tree_med', 'dead_tree_small', 'round_tree_small', 'bush_round', 'bush_flowering',
    'bush_dead', 'grass_tuft', 'shell_cream', 'shell_pink', 'driftwood_stick', 'sandcastle_big']) {
    const img = new Image();
    img.src = `assets/scenery/${name}.png`;
    SPRITES[name] = img;
  }
  // Decorative ground clutter, cut from the same reference tile sheet as the terrain textures.
  for (const name of ['fern1', 'clover', 'flowers_mixed', 'mushroom_pair', 'mossy_boulder',
    'tidepool1', 'sand_pebbles']) {
    const img = new Image();
    img.src = `assets/tiles/${name}.png`;
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
      const { biome, weight } = dominantBiome(x, y);
      if (weight < 0.55) continue; // blend zone between two biomes: leave it sparser/transitional
      const spacing = SPACING[biome];
      if (tooClose(x, y, spacing)) continue;
      markPlaced(x, y, spacing);

      if (biome === 'beach' && rand() < 0.25) {
        scenery.push({ x, y, r: 16, cr: 9, type: 'sprite', sprite: 'mossy_boulder', h: 40, collide: true });
      } else if (biome === 'beach' && rand() < 0.14) {
        scenery.push({ x, y, r: 20, type: 'sprite', sprite: 'driftwood_stick', h: 60, collide: false });
      } else if (biome === 'beach' && rand() < 0.1) {
        scenery.push({ x, y, r: 20, cr: 10, type: 'palm', collide: true });
      } else if (biome === 'beach' && rand() < 0.06) {
        // rare beach flourish, straight off the reference sheet
        scenery.push({ x, y, r: 24, type: 'sprite', sprite: 'sandcastle_big', h: 140, collide: false });
      } else if (biome === 'beach' && rand() < 0.08) {
        scenery.push({ x, y, r: 6, type: 'sprite', sprite: rand() < 0.5 ? 'shell_cream' : 'shell_pink', h: 26, collide: false });
      } else if (biome === 'beach' && rand() < 0.1) {
        scenery.push({ x, y, r: 4, type: 'sprite', sprite: 'grass_tuft', h: 34, collide: false });
      } else if (biome === 'beach' && rand() < 0.05) {
        scenery.push({ x, y, r: 14, type: 'sprite', sprite: 'tidepool1', h: 28, collide: false });
      } else if (biome === 'beach' && rand() < 0.08) {
        scenery.push({ x, y, r: 10, type: 'sprite', sprite: 'sand_pebbles', h: 22, collide: false });
      } else if (biome === 'beach') {
        // none of the beach rolls hit for this spot: leave it bare sand, no tree fallback
      } else if (rand() < 0.08) {
        // Ground clutter matched to each grass biome's mood. Purely decorative.
        // TODO: no bones/twigs, cracked-dirt, fallen-leaves, or transparent-pebble art yet —
        // mossy_boulder/bush_dead stand in for moss patches and dead brush until that art exists.
        // (sand_pebbles.png is an opaque sand-background tile, not a transparent sprite, so it's
        // left off this list — it only reads right over sand, where it's already used on the beach.)
        const CLUTTER = {
          forestOpen: ['grass_tuft', 'clover', 'flowers_mixed'],
          forestThick: ['fern1', 'fern1', 'mossy_boulder', 'bush_round'],
          deadTrees: ['mushroom_pair', 'bush_dead', 'bush_dead', 'grass_tuft'],
        }[biome];
        const clutter = CLUTTER[Math.floor(rand() * CLUTTER.length)];
        scenery.push({ x, y, r: 8, type: 'sprite', sprite: clutter, h: 30, collide: false });
      } else {
        const t = pickTree(biome);
        const r = biome === 'forestThick' ? 14 : 12;
        // Collision radius is much smaller than the drawn trunk radius `r` (used for the shadow),
        // so the turtle only bumps the trunk itself and can pass close by/behind the canopy.
        scenery.push({ x, y, r, cr: r * 0.45, type: 'sprite', sprite: t.sprite, h: t.h * (0.85 + rand() * 0.3), collide: true });
        // A little undergrowth around forest/dead-tree trees, purely decorative.
        if (biome !== 'beach' && rand() < 0.12) {
          const bush = biome === 'deadTrees' ? 'bush_dead' : (biome === 'forestThick' ? 'bush_round' : 'bush_flowering');
          scenery.push({ x: x + (rand() * 2 - 1) * 40, y: y + (rand() * 2 - 1) * 40, r: 6, type: 'sprite', sprite: bush, h: 36, collide: false });
        }
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

  // Resolve turtle-vs-obstacle circle collision by pushing the turtle out along the contact normal.
  function resolveObstacleCollisions() {
    for (const s of nearbyObstacles(turtle.x, turtle.y, TURTLE_RADIUS + 20)) {
      const dx = turtle.x - s.x, dy = turtle.y - s.y;
      const minDist = TURTLE_RADIUS + (s.cr ?? s.r);
      const dist = Math.hypot(dx, dy) || 0.001;
      if (dist < minDist) {
        const push = (minDist - dist) / dist;
        turtle.x += dx * push;
        turtle.y += dy * push;
      }
    }
  }

  // Depth-sorts the turtle in with visible scenery by y so tall sprites (trees) draw over the
  // turtle when its anchor point is above their base — i.e. the turtle can duck behind the
  // canopy — while collision (much smaller `cr` radius) still stops it at the trunk itself.
  function drawSceneryWithTurtle(list) {
    list.sort((a, b) => a.y - b.y); // cheap back-to-front depth sort of the (small) visible set
    let drawnTurtle = false;
    for (const s of list) {
      if (!drawnTurtle && turtle.y < s.y) { drawTurtle(); drawnTurtle = true; }
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

  // ---- Update ----
  function update(dt) {
    stateTime += dt;
    const dir = state === 'normal' ? getDirection() : { x: 0, y: 0 };
    const speedMult = isWater(turtle.x, turtle.y) ? WATER_SPEED_MULT : LAND_SPEED_MULT;
    const tvx = dir.x * MAX_SPEED * speedMult, tvy = dir.y * MAX_SPEED * speedMult;
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

  // Animated foam line traced along both noisy shorelines (island + mainland). Cheap: a fixed
  // handful of angle samples per shore per frame, and only the segments that land inside the
  // current camera view are added to the stroked path.
  // TODO: if this ever shows up as a frame-rate drop on low-end phones, gate it behind a quick
  // device check and skip the call entirely rather than tuning it further.
  function traceFoamShoreline(baseR, seedOffset, freq, t, left, right, top, bottom) {
    let drawing = false;
    for (let i = 0; i <= FOAM_ANGLE_STEPS; i++) {
      const angle = (i / FOAM_ANGLE_STEPS) * Math.PI * 2;
      const r = baseR + shoreWobble(angle, seedOffset, freq)
        + Math.sin(t * FOAM_PULSE_SPEED + angle * 2) * FOAM_PULSE_AMPLITUDE;
      const x = CENTER.x + Math.cos(angle) * r, y = CENTER.y + Math.sin(angle) * r;
      if (x >= left && x <= right && y >= top && y <= bottom) {
        if (drawing) ctx.lineTo(x, y); else { ctx.moveTo(x, y); drawing = true; }
      } else {
        drawing = false;
      }
    }
  }
  function drawFoam(t) {
    const vw = viewW / ZOOM, vh = viewH / ZOOM;
    const margin = FOAM_PULSE_AMPLITUDE + FOAM_WIDTH + 4;
    const left = camX - margin, right = camX + vw + margin, top = camY - margin, bottom = camY + vh + margin;
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${FOAM_ALPHA})`;
    ctx.lineWidth = FOAM_WIDTH;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    traceFoamShoreline(ISLAND_R, ISLAND_SHORE_SEED_OFFSET, ISLAND_SHORE_FREQ, t, left, right, top, bottom);
    traceFoamShoreline(WATER_OUTER_R, OUTER_SHORE_SEED_OFFSET, OUTER_SHORE_FREQ, t, left, right, top, bottom);
    ctx.stroke();
    ctx.restore();
  }

  // Lightweight animated shimmer on the water ring around the island (a few pulsing rings; cheap).
  function drawWaterShimmer(t) {
    const bands = 3;
    for (let i = 0; i < bands; i++) {
      const rr = ISLAND_R + 40 + (i * (WATER_WIDTH - 60)) / bands + Math.sin(t * 0.6 + i) * 6;
      ctx.beginPath(); ctx.arc(CENTER.x, CENTER.y, rr, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.05 + 0.03 * Math.sin(t * 0.8 + i)})`;
      ctx.lineWidth = 8;
      ctx.stroke();
    }
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
    drawGroundTextures();
    drawGrassTextures();
    drawWaterShimmer(t);
    drawFoam(t);
    ctx.drawImage(islandDetail.canvas, islandDetail.worldX, islandDetail.worldY);

    // Cull scenery to the visible world rect (plus a small margin) so a big world with lots of
    // trees still draws only a couple dozen-to-hundred objects per frame.
    const vw = viewW / ZOOM, vh = viewH / ZOOM, margin = 80;
    const visible = scenery.filter(s =>
      s.x > camX - margin && s.x < camX + vw + margin && s.y > camY - margin && s.y < camY + vh + margin);
    drawSceneryWithTurtle(visible);
    ctx.restore();

    drawJoystick(); // screen space
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
  function start() {
    resize();
    if (!window.innerWidth || !window.innerHeight) { requestAnimationFrame(start); return; }
    if (!grassReady) { requestAnimationFrame(start); return; } // wait for grass textures so nothing draws untextured
    spawnTurtle();
    last = performance.now();
    requestAnimationFrame(frame);
  }
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start);
})();
