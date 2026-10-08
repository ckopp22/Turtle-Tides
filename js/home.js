// home.js — the player's wooden hut: exterior on the home island (solid walls, doorway trigger),
// the 192x192 interior scene, and the fade transitions between them. game.js owns the loop and
// turtle drawing; it calls into window.Home (see the API at the bottom) and reads Home.room /
// Home.layout() to draw the interior. Enemies never enter the hut: they can't walk the island at
// all, and Home.isPlayerSafe() / insideHut() give them (and any future code) a flag to read.
(() => {
  'use strict';

  // ---- CONFIG: every tunable number for this system lives here ----
  const CONFIG = {
    hutScale: 1.25,        // exterior draw scale: world px per art px
    fadeSeconds: 0.25,     // each half of a door fade (to black, then back in)
    roomSpeedBoost: 1.3, // extra walking speed in the room on top of matching the outside (the turtle is drawn small there)
    roomTurtleScale: 0.36, // turtle draw size / speed / hitbox inside the room vs. its world size
    exitDropPx: 65,        // world px below the hut's wall base where the turtle reappears
    // Hut position in world px relative to the island center; the anchor is the middle of the wall's
    // bottom edge (art 96,178). Kept well inland: the island is ~260px radius.
    hutOffset: { x: 0, y: 35 },
    // Outdoor campfire (upgrades 9 and 10): center in world px relative to the island center, drawn
    // size, collision radius, and the lit animation's speed (frames/sec; the sheet has 6 frames).
    campfire: { x: -135, y: 120, size: 72, radius: 18, fps: 8 },
    // Other outdoor pieces (offsets from the island center; stones are offsets from the hut's wall base).
    // stones: a path from the door south to the water. garden: right of the hut. onewheel: left of it.
    stones: { size: 72, ys: [60, 120] },
    garden: { x: 190, y: 20, size: 96, radius: 34 },
    onewheel: { x: -165, y: 45, w: 75, radius: 20 },
    // Clickable furniture (tap/click). hitPad = art px added around each hit area for fingers.
    // The turtle must be within nearbyPx (art px) of an item to use it, else a "Come closer" hint
    // shows (the same distance shows the "Tap" prompt). A press only counts as a tap if it moves < tapMaxMovePx and ends
    // within tapMaxMs, so dragging the joystick never triggers furniture.
    hitPad: 5, nearbyPx: 20, tapMaxMovePx: 12, tapMaxMs: 600, hintSeconds: 1.6,
    // Bed -> sleep. Fade to dark, show the turtle asleep on the bed for asleepSeconds, fade back in.
    // Restores all hearts and saves. cooldownSeconds is off by default (0 = none; skipped at full health).
    sleep: { fadeSeconds: 0.5, revealSeconds: 0.4, asleepSeconds: 2.5, dim: 0.8, scale: 1.3, cooldownSeconds: 0 },
  };

  // ---- Home upgrades. The island shop's "Home" track (progression.js TRACKS.home) sells them one at a
  // time: Progression.state.homeLevel = how many are bought. Level 0 = nothing on the island; level 1
  // = the hut itself; then the INDOOR items (chest second, rug last), then the OUTDOOR campfire
  // stages. Walking into the hut shows what's unlocked (new items pop in). `layer` is a full 192x192 transparent PNG drawn at (0,0) over the
  // room. `solids` = collision shapes in room coords (only once unlocked): { rect: [x0, y0, x1, y1] }
  // or { circle: [cx, cy, r] }. `unlocks` = feature ids the item enables (Home.hasFeature): the old
  // home-level perks (sleep, moveSpeed1/2, swimSpeed1/2, dayNight, hideInShell) plus the
  // collectionBook and closet. `perk` is the short text the shop row shows. Costs climb gently; the
  // cheap early pieces make the first few buys quick wins.
  const INDOOR = [
    { id: 'bed',     name: 'Bed',            layer: '01_bed_192.png',              cost: 20, unlocks: ['sleep'],                  perk: 'Sleep',                      solids: [{ rect: [16, 44, 80, 108] }], hotspot: { rect: [16, 44, 80, 108], action: 'sleep' } },
    { id: 'chest',   name: 'Chest',          layer: '08_chest_192.png',            cost: 25, unlocks: ['closet'],                perk: 'Closet',                     solids: [{ rect: [137, 141, 177, 169] }], hotspot: { rect: [137, 141, 177, 169], action: 'closet' } },
    { id: 'table',   name: 'Table & Stools', layer: '04_table_and_stools_192.png', cost: 30, unlocks: ['adventureZone'], perk: 'New area',solids: [{ circle: [152, 82, 18] }, { circle: [152, 112, 8] }, { circle: [128, 82, 8] }], hotspot: { rect: [134, 64, 170, 100], action: 'bible' } },
    { id: 'goggles',  name: 'Goggles',        layer: null,                          cost: 35, unlocks: ['swimSpeed1'],             perk: 'Swim Speed I',               solids: [] }, // drawn in rebuildRoom, hanging on a stool
    { id: 'doormat', name: 'Doormat',        layer: '03_doormat_192.png',          cost: 40, unlocks: ['moveSpeed1'],             perk: 'Move Speed I',               solids: [] },
    { id: 'window',  name: 'Window',         layer: null,                          cost: 45, unlocks: ['dayNight'],              perk: 'Day/Night',                  solids: [], hotspot: { rect: [74, 10, 118, 36], action: 'daynight' } }, // art is in the base room image; no layer
    { id: 'shelf',   name: 'Shelf',          layer: '05_shelf_192.png',            cost: 60, unlocks: ['collectionBook'],         perk: 'Collection Book',            solids: [], hotspot: { rect: [130, 17, 178, 36], action: 'book' } },
    { id: 'plant',   name: 'Plant',          layer: '06_plant_192.png',            cost: 75, unlocks: ['minigame'],              perk: 'Mini game',                  solids: [{ circle: [30, 158, 9] }], hotspot: { rect: [18, 142, 42, 168], action: 'minigame' } },
    { id: 'lantern', name: 'Lantern',        layer: '07_lantern_192.png',          cost: 95, unlocks: ['moveSpeed2'],             perk: 'Move Speed II',               solids: [] },
    { id: 'rug',     name: 'Rug',            layer: '02_rug_192.png',              cost: 120, unlocks: ['swimSpeed2'],             perk: 'Swim Speed II',              solids: [] },
  ];
  // Outdoor upgrades come after the hut items (levels 9-10): the campfire next to the hut, first
  // unlit, then lit (animated) with Hide in Shell. Drawn on the island, not in the room.
  const OUTDOOR = [
    { id: 'campfireUnlit', name: 'Campfire Pit', cost: 150, unlocks: ['hideInShell'], perk: 'Hide in Shell' },
    { id: 'campfireLit',   name: 'Campfire',     cost: 190, unlocks: [],            perk: 'A warm fire' },
    { id: 'stones',        name: 'Stepping Stones', cost: 230, unlocks: [],            perk: 'A path to the water' },
    { id: 'garden',        name: 'Garden Bed',   cost: 280, unlocks: ['slowHunger'],  perk: 'Slower hunger' },
    { id: 'onewheel',      name: 'One Wheel',    cost: 340, unlocks: ['moveSpeed3'],  perk: 'Move Speed III' },
  ];
  const HUT = { id: 'hut', name: 'Hut', cost: 15, unlocks: [], perk: 'A home of your own' }; // level 1
  // Shop order: the Campfire Pit is bought right after the Window (upgrade 8); everything else keeps its relative order.
  const byId = id => INDOOR.concat(OUTDOOR).find(u => u.id === id);
  const UPGRADES = [HUT, 'bed', 'chest', 'table', 'goggles', 'doormat', 'window', 'campfireUnlit', 'shelf', 'plant', 'lantern', 'rug', 'campfireLit', 'stones', 'garden', 'onewheel'].map(x => typeof x === 'string' ? byId(x) : x); // everything the shop's Home row sells, in order
  const UPGRADE_IDX = {};
  UPGRADES.forEach((u, i) => { UPGRADE_IDX[u.id] = i; });
  const DRAW_FIRST = 'rug'; // layered under every other item
  const POP = { startDelay: 0.5, stagger: 0.45, duration: 0.45, overshoot: 1.7 }; // newly unlocked items pop in on entering

  // ---- Art-space geometry (px inside the 192x192 PNGs) ----
  const ART = 192, ANCHOR_X = 96, ANCHOR_Y = 178;
  // Exterior solids [x0, y0, x1, y1]: the two wall+roof-overhang blocks either side of the doorway
  // (x 66-126) and a short back wall inside it. The roof above y 104 is walk-behind (depth-sorted).
  const HUT_SOLIDS = [[4, 104, 66, 178], [126, 104, 188, 178], [66, 104, 126, 120]];
  const DOOR_TRIGGER = [66, 146, 126, 178]; // stepping in here fades to the interior
  // Interior: walkable floor, exit gap in the bottom wall, and where the turtle spawns.
  const FLOOR = { x0: 12, y0: 40, x1: 179, y1: 177 };
  const GAP = { x0: 66, x1: 126 };
  const ROOM_EXIT_Y = 184;   // turtle center past this (inside the gap) leaves the hut
  const ROOM_MAX_Y = 196;
  const ROOM_SPAWN = { x: 96, y: 160 };
  const BED_SPOT = { x: 48, y: 76 }; // where the turtle lies while sleeping (bed center)
  const WAKE_SPOT = { x: 96, y: 76 }; // where it stands up again, just right of the bed

  function load(src) { const i = new Image(); i.onload = rebuildRoom; i.src = src; return i; }
  const hutImg = load('assets/home/hut_exterior_192.png');
  const fireUnlitImg = load('assets/home/campfire_unlit_64.png');
  const stonesImg = load('assets/home/stepping_stones_64.png');
  const gardenImg = load('assets/home/garden_bed_128.png?v=2');
  const onewheelImg = load('assets/home/onewheel_128.png'); // photo cutout, drawn smoothed
  const fireLitImg = load('assets/home/campfire_spritesheet.png'); // 6 frames of 64x64
  const mapImg = load('assets/home/map_64.png');
  const bibleClosedImg = load('assets/home/bible_closed_64.png');
  const gogglesImg = load('assets/items/accessory_goggles.png');
  const bibleOpenImg = load('assets/home/bible_open_64.png');
  const baseImg = load('assets/home/00_hut_interior_empty_192.png');
  const layerImgs = {};
  for (const u of INDOOR) if (u.layer) layerImgs[u.id] = load('assets/home/' + u.layer);

  // The interior (base + every unlocked layer, rug first) is composed once into this canvas and drawn
  // from it every frame; rebuildRoom() only reruns when an image finishes loading or the unlocked
  // item set changes.
  const roomCanvas = document.createElement('canvas');
  roomCanvas.width = roomCanvas.height = ART;
  const roomCtx = roomCanvas.getContext('2d');
  let bibleOpen = false; // table's Bible: tap opens it with a verse, next tap closes it
  const tinyCache = new Map();
  function tiny(img) {
    if (tinyCache.has(img)) return tinyCache.get(img);
    let src = img;
    for (const n of [32, 16]) {
      const c = document.createElement('canvas'); c.width = c.height = n;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, n, n); src = c;
    }
    tinyCache.set(img, src);
    return src;
  }
  function rebuildRoom() {
    roomCtx.clearRect(0, 0, ART, ART);
    if (baseImg.complete && baseImg.naturalWidth) roomCtx.drawImage(baseImg, 0, 0);
    drawLayer(DRAW_FIRST);
    for (const u of INDOOR) if (u.id !== DRAW_FIRST) drawLayer(u.id);
    if (shown.goggles && gogglesImg.complete && gogglesImg.naturalWidth) roomCtx.drawImage(tiny(gogglesImg), 120, 72); // hung on the left stool's back
    if (shown.table) { // map + bible on the table (art px); bible is open while its verse shows
      // Halve 64 -> 32 -> 16 (exact 2:1 steps average cleanly), then draw 1:1 so the little props stay crisp.
      const b = bibleOpen ? bibleOpenImg : bibleClosedImg;
      if (mapImg.complete && mapImg.naturalWidth) roomCtx.drawImage(tiny(mapImg), 140, 71);
      if (b.complete && b.naturalWidth) roomCtx.drawImage(tiny(b), 154, 74);
    }
  }
  function drawLayer(id) {
    const img = layerImgs[id];
    if (img && shown[id] && img.complete && img.naturalWidth) roomCtx.drawImage(img, 0, 0);
  }

  // ---- What the saved home level (Progression.state.homeLevel) means for the room ----
  // `shown` = layers baked into the cached canvas (an item that is mid pop-in is left out until its
  // animation ends); roomSolids = collision shapes for every unlocked item.
  const shown = {};
  const roomSolids = []; // [0, x0, y0, x1, y1] rects, [1, cx, cy, r] circles; rebuilt only when the level changes
  let builtLevel = -1;
  const level = () => Math.min(window.Progression.state.homeLevel, UPGRADES.length);
  const hutBuilt = () => level() >= 1;
  const owned = id => UPGRADE_IDX[id] < level(); // bought yet (indoor or outdoor)
  const fireStage = () => owned('campfireLit') ? 2 : owned('campfireUnlit') ? 1 : 0; // 0 none, 1 pit, 2 lit
  function syncUnlocked() {
    roomSolids.length = 0;
    INDOOR.forEach(u => {
      const have = owned(u.id);
      shown[u.id] = have;
      if (have) for (const sh of u.solids) roomSolids.push(sh.rect ? [0, ...sh.rect] : [1, ...sh.circle]);
    });
    builtLevel = level();
    rebuildRoom();
  }
  // True if a feature id (e.g. 'sleep', 'closet') is unlocked. Called every frame by progression.js's
  // hasSkill, so it's a plain loop with no allocation.
  function hasFeature(name) {
    const lv = level();
    for (let i = 0; i < lv; i++) if (UPGRADES[i].unlocks.includes(name)) return true;
    return false;
  }

  // ---- Pop-in: items unlocked since the player last stood in the hut scale in one after another ----
  const pops = []; // { id, delay, cx, cy } in art px
  let popClock = 0, toast = null, toastTimer = 0;
  function startPops() {
    const P = window.Progression, lv = level(), seen = clamp(Math.min(P.state.homeSeenLevel, lv), 0, UPGRADES.length); // upgrades already seen (UPGRADES index)
    pops.length = 0;
    syncUnlocked(); // clean slate (e.g. an animation cut short by leaving last time)
    if (lv > seen) {
      const names = [];
      let k = 0;
      for (let i = seen; i < lv; i++) {
        const u = UPGRADES[i];
        if (!INDOOR.includes(u)) continue; // outdoor items just appear on the island
        names.push(`${u.name} (${u.perk})`);
        if (!u.layer) continue; // layer-less items (the window) are already in the base art: toast only
        const b = layerBBox(u.id);
        shown[u.id] = false; // keep it out of the cached canvas until its animation is done
        pops.push({ id: u.id, delay: POP.startDelay + (k++) * POP.stagger, cx: b.x + b.w / 2, cy: b.y + b.h / 2, played: false });
      }
      if (names.length) {
        rebuildRoom();
        popClock = 0;
        showToast('New in your home: ' + names.join(', '));
      }
      P.state.homeSeenLevel = lv;
      P.persist();
    }
  }
  function updatePops(dt) {
    if (!pops.length) return;
    popClock += dt;
    let done = true;
    for (const p of pops) {
      if (!p.played && popClock >= p.delay) { p.played = true; if (window.TT_SOUND) window.TT_SOUND.coin(); }
      if (popClock < p.delay + POP.duration) done = false;
    }
    if (done) { pops.length = 0; syncUnlocked(); }
  }
  function drawPops(ctx, lay) {
    for (const p of pops) {
      const t = (popClock - p.delay) / POP.duration;
      if (t < 0) continue;
      const u = Math.min(1, t) - 1, sc = 1 + (POP.overshoot + 1) * u * u * u + POP.overshoot * u * u; // ease-out-back, 0 -> 1
      const img = layerImgs[p.id];
      if (!img.complete || !img.naturalWidth) continue;
      ctx.save();
      ctx.translate(lay.x0 + p.cx * lay.s, lay.y0 + p.cy * lay.s);
      ctx.scale(sc, sc);
      ctx.drawImage(img, -p.cx * lay.s, -p.cy * lay.s, ART * lay.s, ART * lay.s);
      ctx.restore();
    }
  }
  // One small DOM toast, reused. Only touched when something new was unlocked.
  function showToast(text) {
    if (!toast) { toast = document.createElement('div'); toast.id = 'tt-home-toast'; document.body.appendChild(toast); }
    toast.textContent = text;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 4500);
  }
  function hideToast() { if (toast) toast.style.display = 'none'; }

  // Tight alpha bounding box of a layer (art px), measured once per layer (used to center the pop-in).
  const bboxCache = {};
  function layerBBox(id) {
    if (bboxCache[id]) return bboxCache[id];
    const img = layerImgs[id];
    if (!img.complete || !img.naturalWidth) return { x: 0, y: 0, w: ART, h: ART };
    const c = document.createElement('canvas'); c.width = c.height = ART;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, ART, ART).data;
    let x0 = ART, y0 = ART, x1 = -1, y1 = -1;
    for (let y = 0; y < ART; y++) for (let x = 0; x < ART; x++) {
      if (d[(y * ART + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return (bboxCache[id] = x1 < 0 ? { x: 0, y: 0, w: ART, h: ART } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }


  // ---- Clickable furniture + sleeping ----
  const ACTIONS = { sleep: startSleep, closet: openCloset, book: openBook, bible: () => { bibleOpen = true; rebuildRoom(); }, daynight: () => window.Progression.toggleDayNight(), minigame: openMinigame };
  const sleep = { phase: 0, t: 0, dim: 0, msg: '', full: false }; // phase: 0 none, 1 fading to dark, 2 asleep, 3 waking
  const hint = { text: '', timer: 0 };
  let lastSleepAt = -1;
  function showHint(text) { hint.text = text; hint.timer = CONFIG.hintSeconds; }
  function startSleep() {
    const P = window.Progression, c = CONFIG.sleep;
    const full = P.state.hearts >= P.maxHearts(), now = P.state.stats.playSeconds;
    if (!full && c.cooldownSeconds > 0 && lastSleepAt >= 0 && now - lastSleepAt < c.cooldownSeconds) {
      showHint(`Not sleepy yet (${Math.ceil(c.cooldownSeconds - (now - lastSleepAt))}s)`); return;
    }
    sleep.phase = 1; sleep.t = 0; sleep.full = full;
    room.vx = room.vy = room.speed = 0;
  }
  function tickSleep(dt) {
    const c = CONFIG.sleep;
    sleep.t += dt;
    if (sleep.phase === 1) {
      sleep.dim = Math.min(1, sleep.t / c.fadeSeconds);
      if (sleep.t >= c.fadeSeconds) { // fully dark: tuck in, heal, save
        sleep.phase = 2; sleep.t = 0;
        if (window.TT_SOUND) window.TT_SOUND.snore();
        window.Progression.restoreHearts();
        lastSleepAt = window.Progression.state.stats.playSeconds;
        sleep.msg = sleep.full ? 'Fully rested' : 'Hearts restored!';
      }
    } else if (sleep.phase === 2) {
      sleep.dim = 1 - (1 - c.dim) * Math.min(1, sleep.t / c.revealSeconds);
      if (sleep.t >= c.asleepSeconds) { sleep.phase = 3; sleep.t = 0; room.x = WAKE_SPOT.x; room.y = WAKE_SPOT.y; room.angle = 0; }
    } else {
      sleep.dim = c.dim * (1 - Math.min(1, sleep.t / c.fadeSeconds));
      if (sleep.t >= c.fadeSeconds) { sleep.phase = 0; sleep.dim = 0; }
    }
  }
  // Furniture with a hotspot that is unlocked and has an action wired up.
  function spotActive(i) { const u = INDOOR[i]; return !!u.hotspot && !!ACTIONS[u.hotspot.action] && owned(u.id) && (u.hotspot.action !== 'daynight' || hasFeature('dayNight')); } // the window toggle waits for Day/Night (the lit campfire)
  function hitSpot(rx, ry) {
    const pad = CONFIG.hitPad;
    for (let i = 0; i < INDOOR.length; i++) {
      if (!spotActive(i)) continue;
      const r = INDOOR[i].hotspot.rect;
      if (rx >= r[0] - pad && rx <= r[2] + pad && ry >= r[1] - pad && ry <= r[3] + pad) return INDOOR[i];
    }
    return null;
  }
  function tapAt(cx, cy) {
    if (scene !== 'interior' || phase !== 0 || sleep.phase || modal) return;
    if (bibleOpen) { bibleOpen = false; rebuildRoom(); return; } // any tap closes the Bible and its verse
    const u = hitSpot((cx - L.x0) / L.s, (cy - L.y0) / L.s);
    if (!u) return;
    const r = u.hotspot.rect, dx = room.x - clamp(room.x, r[0], r[2]), dy = room.y - clamp(room.y, r[1], r[3]);
    if (Math.hypot(dx, dy) > CONFIG.nearbyPx) { showHint('Come closer'); return; }
    ACTIONS[u.hotspot.action](u);
  }
  // Pointer events (mouse + touch + pen). A tap = short press with little movement.
  const tap = { id: -1, x: 0, y: 0, t: 0 }, mouse = { x: -1, y: -1, over: false };
  function bindPointer() {
    const canvas = document.getElementById('game');
    canvas.addEventListener('pointerdown', e => { tap.id = e.pointerId; tap.x = e.clientX; tap.y = e.clientY; tap.t = e.timeStamp; });
    canvas.addEventListener('pointerup', e => {
      if (e.pointerId !== tap.id) return;
      tap.id = -1;
      if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > CONFIG.tapMaxMovePx || e.timeStamp - tap.t > CONFIG.tapMaxMs) return;
      tapAt(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') { mouse.x = e.clientX; mouse.y = e.clientY; mouse.over = true; } });
    canvas.addEventListener('pointerleave', () => { mouse.over = false; });
    canvas.addEventListener('pointercancel', () => { tap.id = -1; });
  }

  // ---- State ----
  let onEnterInterior = null;
  let speedMult = () => 1, screenScale = () => 1; // game.js's camera zoom: room speed is set so it covers the same screen distance as outside
  let turtle = null, hutX = 0, hutY = 0, bodyR = 22, maxSpeed = 0, accel = 0, decel = 0, onEnter = null;
  let scene = 'world';   // 'world' | 'interior' — which one is drawn/simulated
  let phase = 0;         // 0 = none, 1 = fading to black, 2 = fading back in
  let alpha = 0, pending = null;
  let wheelRidden = false; // true while the turtle is riding it (game.js sets this); the parked sprite is hidden
  let fireX = 0, fireY = 0, gardenX = 0, gardenY = 0, wheelX = 0, wheelY = 0;
  const solids = [];     // world-space copies of HUT_SOLIDS
  const trigger = [0, 0, 0, 0];
  const room = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, speed: 0 }; // room (art px) coords
  const hutEntry = { x: 0, y: 0, type: 'custom', collide: false, draw: drawHut };

  function init(o) {
    turtle = o.turtle; bodyR = o.bodyRadius; maxSpeed = o.maxSpeed; accel = o.accel; decel = o.decel; onEnter = o.onEnter; if (o.screenScale) screenScale = o.screenScale; if (o.speedMult) speedMult = o.speedMult; onEnterInterior = o.onEnterInterior;
    hutX = o.center.x + CONFIG.hutOffset.x;
    hutY = o.center.y + CONFIG.hutOffset.y;
    hutEntry.x = hutX; hutEntry.y = hutY;
    const s = CONFIG.hutScale, wx = ax => hutX + (ax - ANCHOR_X) * s, wy = ay => hutY + (ay - ANCHOR_Y) * s;
    solids.length = 0;
    for (const b of HUT_SOLIDS) solids.push([wx(b[0]), wy(b[1]), wx(b[2]), wy(b[3])]);
    trigger[0] = wx(DOOR_TRIGGER[0]); trigger[1] = wy(DOOR_TRIGGER[1]);
    trigger[2] = wx(DOOR_TRIGGER[2]); trigger[3] = wy(DOOR_TRIGGER[3]);
    bindPointer();
    fireX = o.center.x + CONFIG.campfire.x; fireY = o.center.y + CONFIG.campfire.y;
    gardenX = o.center.x + CONFIG.garden.x; gardenY = o.center.y + CONFIG.garden.y;
    wheelX = o.center.x + CONFIG.onewheel.x; wheelY = o.center.y + CONFIG.onewheel.y;
  }

  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  // Pushes circle (p.x, p.y, r) out of the rect, in place.
  function pushOutRect(p, r, x0, y0, x1, y1) {
    const cx = clamp(p.x, x0, x1), cy = clamp(p.y, y0, y1);
    const dx = p.x - cx, dy = p.y - cy, d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return;
    if (d2 < 1e-6) { // center is inside the rect: eject through the nearest edge
      const l = p.x - x0, rt = x1 - p.x, t = p.y - y0, b = y1 - p.y, m = Math.min(l, rt, t, b);
      if (m === l) p.x = x0 - r; else if (m === rt) p.x = x1 + r; else if (m === t) p.y = y0 - r; else p.y = y1 + r;
      return;
    }
    const k = r / Math.sqrt(d2);
    p.x = cx + dx * k; p.y = cy + dy * k;
  }

  // Keeps the moving circle p (radius r) outside the fixed circle (cx, cy, cr).
  function pushOutCircle(p, r, cx, cy, cr) {
    const dx = p.x - cx, dy = p.y - cy, min = r + cr, d2 = dx * dx + dy * dy;
    if (d2 >= min * min) return;
    const d = Math.sqrt(d2) || 0.001;
    p.x = cx + dx / d * min; p.y = cy + dy / d * min;
  }

  // ---- World side ----
  function collideWorld(t, r) {
    if (hutBuilt()) for (const b of solids) pushOutRect(t, r, b[0], b[1], b[2], b[3]);
    if (fireStage() > 0) pushOutCircle(t, r, fireX, fireY, CONFIG.campfire.radius); // campfire (pit or lit)
  }
  function startFade(swap) { phase = 1; alpha = 0; pending = swap; }
  function enterSwap() {
    scene = 'interior'; bibleOpen = false;
    if (window.TT_SOUND) window.TT_SOUND.fire(0); // the campfire isn't heard indoors
    room.x = ROOM_SPAWN.x; room.y = ROOM_SPAWN.y; room.vx = room.vy = room.speed = 0; room.angle = -Math.PI / 2;
    if (onEnterInterior) onEnterInterior();
    startPops();
  }
  function exitSwap() {
    scene = 'world';
    if (pops.length) { pops.length = 0; syncUnlocked(); } // left mid pop-in: bake the items in
    turtle.x = hutX; turtle.y = hutY + CONFIG.exitDropPx; turtle.vx = turtle.vy = 0; turtle.angle = Math.PI / 2;
  }
  // Called by game.js after the turtle has moved this frame.
  function checkDoor() {
    if (scene !== 'world' || phase !== 0 || !hutBuilt()) return;
    if (turtle.x < trigger[0] || turtle.x > trigger[2] || turtle.y < trigger[1] || turtle.y > trigger[3]) return;
    if (onEnter) onEnter(); // enemies chasing the turtle give up
    startFade(enterSwap);
  }

  // Called first thing in game.js's update(). Returns true while the outside world should stay
  // frozen (mid-fade, or the turtle is inside the hut) — game.js then skips its own update.
  function tick(dt, dir) {
    if (phase === 1) {
      alpha += dt / CONFIG.fadeSeconds;
      if (alpha >= 1) { alpha = 1; pending(); pending = null; phase = 2; }
      return true;
    }
    if (phase === 2) {
      alpha -= dt / CONFIG.fadeSeconds;
      if (alpha <= 0) { alpha = 0; phase = 0; }
      return true;
    }
    if (scene !== 'interior') return false;

    if (hint.timer > 0) hint.timer -= dt;
    if (sleep.phase) { tickSleep(dt); return true; } // asleep: frozen, input ignored
    updatePops(dt);
    if (modal) { room.vx = room.vy = room.speed = 0; return true; } // a screen is open: the room is paused
    // Interior movement (art px): same feel as outside, scaled by the turtle's size in the room.
    const k = CONFIG.roomTurtleScale, hasInput = dir.x !== 0 || dir.y !== 0;
    const kv = screenScale() / L.s; // art px per world px: same on-screen speed as outside
    const mv = kv * speedMult() * CONFIG.roomSpeedBoost; // ...including the Move Speed upgrades
    const tvx = dir.x * maxSpeed * mv, tvy = dir.y * maxSpeed * mv, rate = (hasInput ? accel : decel) * mv * dt;
    const dvx = tvx - room.vx, dvy = tvy - room.vy, dl = Math.hypot(dvx, dvy);
    if (dl <= rate) { room.vx = tvx; room.vy = tvy; }
    else { room.vx += (dvx / dl) * rate; room.vy += (dvy / dl) * rate; }
    room.x += room.vx * dt; room.y += room.vy * dt;
    room.speed = Math.hypot(room.vx, room.vy);

    const br = bodyR * k;
    for (const sh of roomSolids) { // unlocked furniture only
      if (sh[0] === 0) pushOutRect(room, br, sh[1], sh[2], sh[3], sh[4]);
      else pushOutCircle(room, br, sh[1], sh[2], sh[3]);
    }
    const inGap = room.x >= GAP.x0 + br && room.x <= GAP.x1 - br;
    const maxY = inGap ? ROOM_MAX_Y : FLOOR.y1 - br;
    room.x = clamp(room.x, FLOOR.x0 + br, FLOOR.x1 - br);
    room.y = clamp(room.y, FLOOR.y0 + br, maxY);
    if (room.y > FLOOR.y1 - br) room.x = clamp(room.x, GAP.x0 + br, GAP.x1 - br); // below the floor line: stay in the doorway

    if (room.speed > 10) { // face movement direction, turning smoothly
      let diff = Math.atan2(room.vy, room.vx) - room.angle;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      room.angle += diff * Math.min(1, 10 * dt);
    }
    if (room.y >= ROOM_EXIT_Y) { hideToast(); startFade(exitSwap); }
    return true;
  }

  // ---- Drawing ----
  function drawHut(ctx) {
    if (!hutBuilt() || !hutImg.complete || !hutImg.naturalWidth) return;
    const s = CONFIG.hutScale;
    ctx.imageSmoothingEnabled = false; // pixel art
    ctx.drawImage(hutImg, hutX - ANCHOR_X * s, hutY - ANCHOR_Y * s, ART * s, ART * s);
    ctx.imageSmoothingEnabled = true;
  }
  // Night lights (world px): the hut and, once lit, the campfire. game.js cuts holes in the night overlay and adds a warm glow.
  const lightList = [];
  function lights() {
    lightList.length = 0;
    if (hutBuilt()) { const s = CONFIG.hutScale; lightList.push({ x: hutX + (ART / 2 - ANCHOR_X) * s, y: hutY + (ART / 2 - ANCHOR_Y) * s, r: 300, flicker: 0.03 }); }
    if (fireStage() >= 2) lightList.push({ x: fireX, y: fireY, r: 240, flicker: 0.15 });
    return lightList;
  }
  // Flat ground-level pieces on the island, drawn under the turtle/scenery (so no depth sorting): the
  // outdoor campfire. `t` is real time in seconds (drives the flame animation).
  function drawGround(ctx, t) {
    const stage = fireStage(), ok = i => i.complete && i.naturalWidth;
    ctx.imageSmoothingEnabled = false;
    if (owned('stones') && ok(stonesImg)) { // stepping stones from the door down to the water
      const c = CONFIG.stones;
      for (const dy of c.ys) ctx.drawImage(stonesImg, hutX - c.size / 2, hutY + dy - c.size / 2, c.size, c.size);
    }
    if (owned('garden') && ok(gardenImg)) { const c = CONFIG.garden; ctx.drawImage(gardenImg, gardenX - c.size / 2, gardenY - c.size / 2, c.size, c.size); }
    if (owned('onewheel') && !wheelRidden && ok(onewheelImg)) {
      const c = CONFIG.onewheel, h = c.w * onewheelImg.naturalHeight / onewheelImg.naturalWidth;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(onewheelImg, wheelX - c.w / 2, wheelY - h / 2, c.w, h);
      ctx.imageSmoothingEnabled = false;
    }
    if (stage === 0) { ctx.imageSmoothingEnabled = true; return; }
    const c = CONFIG.campfire, x = fireX - c.size / 2, y = fireY - c.size / 2;
    if (stage === 2) { // lit
      if (fireLitImg.complete && fireLitImg.naturalWidth) ctx.drawImage(fireLitImg, (Math.floor(t * c.fps) % 6) * 64, 0, 64, 64, x, y, c.size, c.size);
    } else if (fireUnlitImg.complete && fireUnlitImg.naturalWidth) ctx.drawImage(fireUnlitImg, x, y, c.size, c.size);
    ctx.imageSmoothingEnabled = true;
  }
  // Campfire crackle while the lit fire is on screen-ish: full volume within FIRE_NEAR px, fading to
  // nothing by FIRE_FAR px. Called every world frame by game.js.
  const FIRE_NEAR = 120, FIRE_FAR = 600;
  function updateAmbient() {
    if (!window.TT_SOUND) return;
    if (fireStage() < 2) { window.TT_SOUND.fire(0); return; }
    const d = Math.hypot(turtle.x - fireX, turtle.y - fireY);
    window.TT_SOUND.fire(clamp(1 - (d - FIRE_NEAR) / (FIRE_FAR - FIRE_NEAR), 0, 1));
  }
  // Biggest scale that fits, room centered: whole numbers from 2x up, quarter steps below (short landscape phones). Reused result object (no per-frame allocation).
  const L = { s: 1, x0: 0, y0: 0, tk: CONFIG.roomTurtleScale };
  function layout(w, h) {
    const raw = Math.min(w, h) / ART;
    L.s = Math.max(1, raw >= 2 ? Math.floor(raw) : Math.floor(raw * 4) / 4);
    L.x0 = Math.floor((w - ART * L.s) / 2); L.y0 = Math.floor((h - ART * L.s) / 2);
    return L;
  }
  function drawRoom(ctx, lay, t) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(roomCanvas, lay.x0, lay.y0, ART * lay.s, ART * lay.s);
    drawPops(ctx, lay);
    drawWindowNight(ctx, lay, t);
    ctx.imageSmoothingEnabled = true;
    if (!sleep.phase && !modal) drawFurnitureCues(ctx, lay, t);
  }
  // Window -> night sky over the glass (art px 79..113 x 14..32), eased toward the Day/Night setting.
  let winNight = 0, winLastT = 0;
  function drawWindowNight(ctx, lay, t) {
    const dt = Math.min(0.1, Math.max(0, t - winLastT)); winLastT = t;
    if (!hasFeature('dayNight')) return;
    const target = window.Progression.state.isNight ? 1 : 0;
    winNight = winNight < target ? Math.min(target, winNight + 2 * dt) : Math.max(target, winNight - 2 * dt); // ~0.5s fade
    if (winNight <= 0.001) return;
    const s = lay.s, x = lay.x0 + 79 * s, y = lay.y0 + 14 * s;
    ctx.fillStyle = `rgba(8,16,38,${0.92 * winNight})`;
    ctx.fillRect(x, y, 35 * s, 19 * s);
    ctx.fillStyle = `rgba(255,255,220,${0.9 * winNight})`; // a few stars
    for (const [sx, sy] of [[85, 19], [100, 17], [106, 26], [92, 28]]) ctx.fillRect(lay.x0 + sx * s, lay.y0 + sy * s, s, s);
  }
  // A bobbing "Tap" prompt over a tappable piece while the turtle is within nearbyPx of it, and a pointer
  // cursor while the mouse is over one.
  let cursorOn = false;
  function drawFurnitureCues(ctx, lay, t) {
    const s = lay.s, pad = CONFIG.hitPad, mx = (mouse.x - lay.x0) / s, my = (mouse.y - lay.y0) / s;
    let hovering = false;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.max(14, Math.round(6 * s))}px system-ui, sans-serif`;
    ctx.lineJoin = 'round';
    for (let i = 0; i < INDOOR.length; i++) {
      if (!spotActive(i)) continue;
      const h = INDOOR[i].hotspot, r = h.rect;
      const hov = mouse.over && mx >= r[0] - pad && mx <= r[2] + pad && my >= r[1] - pad && my <= r[3] + pad;
      if (hov) hovering = true;
      const x = lay.x0 + (r[0] - pad) * s, y = lay.y0 + (r[1] - pad) * s, w = (r[2] - r[0] + pad * 2) * s, hh = (r[3] - r[1] + pad * 2) * s;
      const ndx = room.x - clamp(room.x, r[0], r[2]), ndy = room.y - clamp(room.y, r[1], r[3]);
      if (ndx * ndx + ndy * ndy <= CONFIG.nearbyPx * CONFIG.nearbyPx) {
        const ty = y + hh / 2 + Math.sin(t * 5) * s;
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(40,24,8,0.9)'; ctx.fillStyle = '#fff';
        ctx.strokeText('Tap', x + w / 2, ty); ctx.fillText('Tap', x + w / 2, ty);
      }
    }
    ctx.restore();
    if (hovering !== cursorOn) { cursorOn = hovering; document.getElementById('game').style.cursor = hovering ? 'pointer' : ''; }
  }
  function drawSleepDim(ctx, w, h) {
    if (sleep.dim <= 0) return;
    ctx.fillStyle = `rgba(0,0,0,${sleep.dim})`;
    ctx.fillRect(0, 0, w, h);
  }
  // Sleep result text ("Hearts restored!" / "Fully rested") and the "Come closer"/limit hints.
  function drawMessages(ctx, lay) {
    const text = sleep.phase >= 2 ? sleep.msg : bibleOpen ? 'The Lord is my shepherd.\nPsalm 23:1' : hint.timer > 0 ? hint.text : '';
    if (!text) return;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.max(15, Math.round(7 * lay.s))}px system-ui, sans-serif`;
    ctx.lineJoin = 'round'; ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(40,24,8,0.9)'; ctx.fillStyle = '#fff';
    const x = lay.x0 + ART * lay.s / 2, y = lay.y0 + (sleep.phase >= 2 ? 132 : 24) * lay.s;
    text.split('\n').forEach((ln, i) => { const ly = y + i * 9 * lay.s; ctx.strokeText(ln, x, ly); ctx.fillText(ln, x, ly); });
    ctx.restore();
  }
  function drawFade(ctx, w, h) {
    if (alpha <= 0) return;
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fillRect(0, 0, w, h);
  }

  // ---- Closet (chest): buy and wear clothes in one place. A DOM overlay built when it opens and
  // redrawn only when something is tapped. It reuses progression.js's outfit state (state.cosmetics):
  // one equipped item per slot (color / hat / clothes / accessory), so equipping into an occupied slot
  // replaces what's there, and the equipped outfit is what the turtle wears everywhere. Owned items
  // equip / unequip on tap; items you don't own yet are dark silhouettes with a price: tap one, then
  // "Buy & wear" spends banked coins. Opening it pauses the room; Close, the backdrop, Escape and the
  // browser Back button all close it. ----
  const CLOSET_SLOTS = [['color', 'Shell color'], ['hat', 'Hats'], ['clothes', 'Clothes'], ['accessory', 'Accessories']];
  let modal = false, closet = null, book = null, minigame = null, screenPushed = false, pick = null, bookPage = 0;
  function closetTile(item, coins) {
    const P = window.Progression, owned = P.ownsCosmetic(item.id), on = P.equippedIn(item.category) === item.id;
    let art;
    if (item.icon) art = `<img src="${item.icon}" alt="">`;
    else { // shell colors have no icon: a swatch of the tint (natural green for the default)
      const tint = P.getEquippedColorTint({ color: item.id });
      art = `<span class="tt-closet-swatch" style="background:${tint || '#4f9a4a'}"></span>`;
    }
    const label = owned ? `<span class="tt-closet-name">${item.label}</span>`
      : `<span class="tt-closet-price"><img src="assets/items/coin.png" alt="">${item.cost}</span>`;
    const cls = owned ? (on ? ' on' : '') : ` locked${pick === item.id ? ' picked' : ''}${coins < item.cost ? ' poor' : ''}`;
    return `<button type="button" class="tt-closet-item${cls}" data-id="${item.id}" aria-pressed="${on}" aria-label="${owned ? item.label : 'Locked item, ' + item.cost + ' coins'}">
      <span class="tt-closet-art">${art}</span>${label}</button>`;
  }
  function renderCloset() {
    if (!closet) return;
    const P = window.Progression, items = P.getShopItems(), coins = P.state.banked.coins;
    closet.querySelector('.tt-closet-coinnum').textContent = coins;
    closet.querySelector('.tt-closet-grid').innerHTML = CLOSET_SLOTS.map(([cat, label]) =>
      `<h4>${label}</h4><div class="tt-closet-row">${items.filter(i => i.category === cat).map(i => closetTile(i, coins)).join('')}</div>`).join('');
    const bar = closet.querySelector('.tt-closet-buybar'), it = pick && items.find(i => i.id === pick);
    bar.innerHTML = it
      ? `<strong>${it.label}</strong> · ${it.cost} coins<button type="button" class="tt-upgrade-buy tt-closet-buy" ${coins < it.cost ? 'disabled' : ''}>${coins < it.cost ? `Need ${it.cost - coins} more coins` : 'Buy &amp; wear'}</button>`
      : 'Tap a silhouette to buy it.';
    if (window.TurtleGame && window.TurtleGame.renderCosmeticPreview) window.TurtleGame.renderCosmeticPreview(closet.querySelector('.tt-closet-preview'));
  }
  function openCloset() {
    closeScreen();
    modal = true; pick = null;
    if (window.TT_SOUND) window.TT_SOUND.creak(); // the chest lid creaks open
    const wrap = document.createElement('div');
    wrap.className = 'tt-name-prompt';
    wrap.innerHTML = `<div class="tt-name-box tt-upgrade-box tt-closet-box">
      <div class="tt-closet-head"><div class="tt-closet-coins"><img src="assets/items/coin.png" alt=""><span class="tt-closet-coinnum"></span></div><h3>Closet</h3><button type="button" class="tt-closet-x" aria-label="Close">&#x2715;</button></div>
      <canvas class="tt-closet-preview" width="140" height="140"></canvas>
      <div class="tt-closet-grid"></div>
      <div class="tt-closet-buybar"></div>
      <div class="tt-name-actions"><button type="button" class="tt-cancel tt-closet-close">Close</button></div>
    </div>`;
    document.body.appendChild(wrap);
    closet = wrap;
    wrap.addEventListener('click', e => {
      if (e.target === wrap || e.target.closest('.tt-closet-x, .tt-closet-close')) { closeScreen(); return; }
      const P = window.Progression;
      if (e.target.closest('.tt-closet-buy')) { // buy the picked silhouette, then put it on
        const it = P.getShopItems().find(i => i.id === pick);
        if (it && P.buyCosmetic(it.id)) { P.equipCosmetic(it.id); pick = null; renderCloset(); }
        return;
      }
      const tile = e.target.closest('.tt-closet-item');
      if (!tile) return;
      const item = P.getShopItems().find(i => i.id === tile.dataset.id);
      if (!P.ownsCosmetic(item.id)) pick = pick === item.id ? null : item.id; // select/deselect a silhouette
      else if (P.equippedIn(item.category) === item.id) P.unequipCategory(item.category); // tap again = take off (colors can't be removed)
      else P.equipCosmetic(item.id);
      renderCloset();
    });
    renderCloset();
    try { history.pushState({ ttCloset: 1 }, ''); screenPushed = true; } catch { screenPushed = false; } // so Back closes it
  }
  function closeScreen(fromPop) { // closes whichever full-screen panel (closet / collection book) is open
    if (!closet && !book && !minigame) return;
    if (closet) { closet.remove(); closet = null; if (window.TT_SOUND) window.TT_SOUND.door(); } // lid shuts
    if (minigame) { minigame.remove(); minigame = null; } // closing returns to the hut (the room was only paused)
    if (book) { book.remove(); book = null; if (window.TT_SOUND) window.TT_SOUND.bookClose(); }
    modal = false;
    if (screenPushed && !fromPop) { screenPushed = false; try { history.back(); } catch {} }
    screenPushed = false;
  }
  window.addEventListener('popstate', () => closeScreen(true));
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (minigame) window.MiniGames.escape(); // pauses a running game / backs out of a menu
    else if (closet || book) closeScreen();
  });

  // ---- Plant mini games: tap the plant -> minigames.js shows its menu (Baby Turtle Dash / Survival). The room
  // stays paused (modal) until it closes; closeScreen() (Back / Escape / popstate) tears the whole thing down. ----
  function openMinigame() {
    closeScreen();
    modal = true;
    minigame = { remove: () => window.MiniGames.close() }; // closeScreen() only needs .remove()
    window.MiniGames.open(() => closeScreen());
    try { history.pushState({ ttMinigame: 1 }, ''); screenPushed = true; } catch { screenPushed = false; }
  }

  // ---- Collection book (shelf): the 25 finds as pages (Common / Rare / Very Rare) plus a stats page.
  // Found items show their picture, name and how many have been banked; the rest are dark silhouettes
  // with "???". Page through with the arrow buttons, the arrow keys, or a swipe. Built when it opens
  // and redrawn only when the page changes. Shares the closet's modal/Back/Escape handling. ----
  const BOOK_PAGES = [
    { id: 'common', title: 'Common', tier: 'common' },
    { id: 'rare', title: 'Rare', tier: 'rare' },
    { id: 'veryRare', title: 'Very Rare', tier: 'veryRare' },
    { id: 'stats', title: 'Stats', stats: true },
  ];
  const BOOK_SPRITE = 56; // px each find is drawn at (the sheet is 64px cells, scaled whole-number-ish)
  const SWIPE_MIN_PX = 50;
  const PAGE_REWARD_COINS = 100; // paid once per finds page, the first time the book is opened with that page complete
  function pageCounts(page, P) { // { found, total } for a finds page
    let found = 0, total = 0;
    for (const it of P.FINDS.items) if (it.tier === page.tier) { total++; if (P.state.collection[it.id] > 0) found++; }
    return { found, total };
  }
  function fmtPlayTime(sec) {
    const m = Math.floor(sec / 60), h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
  }
  function bookPageHtml(page, P) {
    const F = P.FINDS, col = P.state.collection;
    if (page.stats) {
      const st = P.state.stats;
      const rows = [['Coins found', st.coins], ['Coconuts found', st.coconuts], ['Sandcastles knocked over', st.castles], ['Treasure Chests Found', st.chests], ['Times caught', st.deaths], ['Time played', fmtPlayTime(st.playSeconds)]];
      return `<h4>Stats</h4><div class="tt-book-stats">${rows.map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`).join('')}</div>`;
    }
    let found = 0, total = 0, cells = '';
    F.items.forEach((it, i) => {
      if (it.tier !== page.tier) return;
      total++;
      const n = col[it.id] || 0;
      if (n > 0) found++;
      const sx = -(i % F.cols) * BOOK_SPRITE, sy = -Math.floor(i / F.cols) * BOOK_SPRITE;
      cells += `<div class="tt-book-cell tier-${it.tier}${n ? '' : ' locked'}">
        <span class="tt-book-sprite" style="background-image:url(${F.sheet});background-position:${sx}px ${sy}px"></span>
        <span class="tt-book-name">${n ? it.name : '???'}</span>${n ? `<span class="tt-book-count">x${n}</span>` : ''}</div>`;
    });
    return `<h4>${page.title}<span class="tt-book-prog${found === total ? ' done' : ''}">${found} / ${total}</span></h4><div class="tt-book-grid">${cells}</div>`;
  }
  function renderBook() {
    if (!book) return;
    const P = window.Progression, F = P.FINDS;
    const foundAll = F.items.filter(it => P.state.collection[it.id] > 0).length;
    book.querySelector('.tt-book-total').textContent = `${foundAll} / ${F.items.length} found`;
    book.querySelector('.tt-book-page').innerHTML = bookPageHtml(BOOK_PAGES[bookPage], P);
    book.querySelector('.tt-book-pos').textContent = `${bookPage + 1} / ${BOOK_PAGES.length}`;
    book.querySelector('.tt-book-prev').disabled = bookPage === 0;
    book.querySelector('.tt-book-next').disabled = bookPage === BOOK_PAGES.length - 1;
  }
  function turnPage(d) {
    const n = Math.max(0, Math.min(BOOK_PAGES.length - 1, bookPage + d));
    if (n === bookPage) return;
    if (window.TT_SOUND) window.TT_SOUND.bookPage();
    bookPage = n;
    renderBook();
  }
  function openBook() {
    closeScreen();
    modal = true; bookPage = 0;
    if (window.TT_SOUND) window.TT_SOUND.bookOpen();
    const wrap = document.createElement('div');
    wrap.className = 'tt-name-prompt';
    wrap.innerHTML = `<div class="tt-name-box tt-upgrade-box tt-closet-box tt-book-box">
      <div class="tt-closet-head"><div class="tt-book-total"></div><h3>Collection</h3><button type="button" class="tt-closet-x" aria-label="Close">&#x2715;</button></div>
      <div class="tt-book-note"></div>
      <div class="tt-book-page"></div>
      <div class="tt-book-nav"><button type="button" class="tt-book-prev" aria-label="Previous page">&#x25C0;</button><span class="tt-book-pos"></span><button type="button" class="tt-book-next" aria-label="Next page">&#x25B6;</button></div>
      <div class="tt-name-actions"><button type="button" class="tt-cancel tt-closet-close">Close</button></div>
    </div>`;
    document.body.appendChild(wrap);
    book = wrap;
    wrap.addEventListener('click', e => {
      if (e.target === wrap || e.target.closest('.tt-closet-x, .tt-closet-close')) { closeScreen(); return; }
      if (e.target.closest('.tt-book-prev')) turnPage(-1);
      else if (e.target.closest('.tt-book-next')) turnPage(1);
    });
    // swipe left/right on the page to turn it (vertical drags still scroll)
    const pageEl = wrap.querySelector('.tt-book-page');
    let sx = 0, sy = 0, sid = -1;
    pageEl.addEventListener('pointerdown', e => { sid = e.pointerId; sx = e.clientX; sy = e.clientY; });
    pageEl.addEventListener('pointerup', e => {
      if (e.pointerId !== sid) return;
      sid = -1;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5) turnPage(dx < 0 ? 1 : -1);
    });
    pageEl.addEventListener('pointercancel', () => { sid = -1; });
    // pay out any finds page that is now complete (once each), and say so
    const P = window.Progression, paid = [];
    for (const pg of BOOK_PAGES) {
      if (pg.stats) continue;
      const c = pageCounts(pg, P);
      if (c.found === c.total && P.claimPageReward(pg.id, PAGE_REWARD_COINS)) paid.push(pg.title);
    }
    if (paid.length) {
      wrap.querySelector('.tt-book-note').textContent = `Page complete: ${paid.join(', ')}! +${paid.length * PAGE_REWARD_COINS} coins`;
      if (window.TT_SOUND) window.TT_SOUND.coin();
    }
    renderBook();
    try { history.pushState({ ttBook: 1 }, ''); screenPushed = true; } catch { screenPushed = false; }
  }
  window.addEventListener('keydown', e => {
    if (!book) return;
    if (e.key === 'ArrowLeft') turnPage(-1); else if (e.key === 'ArrowRight') turnPage(1);
  });

  window.Home = {
    syncFromSave: syncUnlocked, refreshInterior: () => { if (scene === 'interior' && builtLevel !== level()) startPops(); }, hasFeature, hutBuilt, UPGRADES,
    init, tick, collideWorld, checkDoor, updateAmbient, layout, drawRoom, drawFade, drawGround, lights, drawSleepDim, drawMessages, hutEntry, room,
    TURTLE_SCALE: CONFIG.roomTurtleScale, worldSpeed: () => room.speed * L.s / screenScale() / speedMult() / CONFIG.roomSpeedBoost, SLEEP_SCALE: CONFIG.sleep.scale, bedSpot: BED_SPOT,
    setWheelRidden: v => { wheelRidden = v; },
    wheelSpot: () => ({ x: wheelX, y: wheelY }), // parked spot on the home island
    isAsleep: () => sleep.phase === 2,
    isInterior: () => scene === 'interior',
    // Safe zone flag for enemies/other systems: true whenever the player is inside the hut.
    insideHut: () => scene === 'interior',
    isPlayerSafe: () => scene === 'interior',
    exitPoint: () => ({ x: hutX, y: hutY + CONFIG.exitDropPx }),
    CONFIG,
  };
})();
