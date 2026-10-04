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
    roomTurtleScale: 0.36, // turtle draw size / speed / hitbox inside the room vs. its world size
    exitDropPx: 65,        // world px below the hut's wall base where the turtle reappears
    // Hut position in world px relative to the island center; the anchor is the middle of the wall's
    // bottom edge (art 96,178). Kept well inland: the island is ~260px radius.
    hutOffset: { x: 0, y: 35 },
    // Outdoor campfire (upgrades 9 and 10): center in world px relative to the island center, drawn
    // size, collision radius, and the lit animation's speed (frames/sec; the sheet has 6 frames).
    campfire: { x: -135, y: 120, size: 72, radius: 18, fps: 8 },
    // Clickable furniture (tap/click). hitPad = art px added around each hit area for fingers.
    // The turtle must be within nearbyPx (art px) of an item to use it, else a "Come closer" hint
    // shows (the same distance shows the "Tap" prompt). A press only counts as a tap if it moves < tapMaxMovePx and ends
    // within tapMaxMs, so dragging the joystick never triggers furniture.
    hitPad: 5, nearbyPx: 36, tapMaxMovePx: 12, tapMaxMs: 600, hintSeconds: 1.6,
    // Bed -> sleep. Fade to dark, show the turtle asleep on the bed for asleepSeconds, fade back in.
    // Restores all hearts and saves. cooldownSeconds is off by default (0 = none; skipped at full health).
    sleep: { fadeSeconds: 0.5, revealSeconds: 0.4, asleepSeconds: 2.5, dim: 0.8, scale: 1.3, cooldownSeconds: 0 },
  };

  // ---- Hut upgrades. The island shop's "Home" track (progression.js TRACKS.home) sells them one at a
  // time, in this order (chest second, rug last): Progression.state.homeLevel = how many are unlocked. Walking into the hut
  // shows them (new ones pop in). `layer` is a full 192x192 transparent PNG drawn at (0,0) over the
  // room. `solids` = collision shapes in room coords (only once unlocked): { rect: [x0, y0, x1, y1] }
  // or { circle: [cx, cy, r] }. `unlocks` = feature ids the item enables (Home.hasFeature): the old
  // home-level perks (sleep, turtleShop, moveSpeed1/2, swimSpeed1/2, dayNight, hideInShell) plus the
  // collectionBook and closet. `perk` is the short text the shop row shows. Costs climb gently; the
  // cheap early pieces make the first few buys quick wins.
  const INDOOR = [
    { id: 'bed',     name: 'Bed',            layer: '01_bed_192.png',              cost: 20, unlocks: ['sleep'],                  perk: 'Sleep',                      solids: [{ rect: [16, 44, 80, 108] }], hotspot: { rect: [16, 44, 80, 108], action: 'sleep' } },
    { id: 'chest',   name: 'Chest',          layer: '08_chest_192.png',            cost: 25, unlocks: ['closet', 'turtleShop'],   perk: 'Closet + Turtle Shop',        solids: [{ rect: [137, 141, 177, 169] }] },
    { id: 'doormat', name: 'Doormat',        layer: '03_doormat_192.png',          cost: 30, unlocks: ['moveSpeed1'],             perk: 'Move Speed I',               solids: [] },
    { id: 'table',   name: 'Table & Stools', layer: '04_table_and_stools_192.png', cost: 45, unlocks: ['swimSpeed1'],             perk: 'Swim Speed I',               solids: [{ circle: [152, 82, 18] }, { circle: [152, 112, 8] }, { circle: [128, 82, 8] }] },
    { id: 'shelf',   name: 'Shelf',          layer: '05_shelf_192.png',            cost: 60, unlocks: ['collectionBook'],         perk: 'Collection Book',            solids: [] },
    { id: 'plant',   name: 'Plant',          layer: '06_plant_192.png',            cost: 75, unlocks: ['moveSpeed2'],             perk: 'Move Speed II',              solids: [{ circle: [30, 158, 9] }] },
    { id: 'lantern', name: 'Lantern',        layer: '07_lantern_192.png',          cost: 95, unlocks: ['dayNight', 'swimSpeed2'], perk: 'Day/Night + Swim Speed II',  solids: [] },
    { id: 'rug',     name: 'Rug',            layer: '02_rug_192.png',              cost: 120, unlocks: [],                       perk: 'Decor',                      solids: [] },
  ];
  // Outdoor upgrades come after the hut items (levels 9-10): the campfire next to the hut, first
  // unlit, then lit (animated) with Hide in Shell. Drawn on the island, not in the room.
  const OUTDOOR = [
    { id: 'campfireUnlit', name: 'Campfire Pit', cost: 150, unlocks: [],              perk: 'A place for a fire' },
    { id: 'campfireLit',   name: 'Campfire',     cost: 190, unlocks: ['hideInShell'], perk: 'Hide in Shell' },
  ];
  const UPGRADES = INDOOR.concat(OUTDOOR); // everything the shop's Home row sells, in order
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
  const fireLitImg = load('assets/home/campfire_spritesheet.png'); // 6 frames of 64x64
  const baseImg = load('assets/home/00_hut_interior_empty_192.png');
  const layerImgs = {};
  for (const u of INDOOR) layerImgs[u.id] = load('assets/home/' + u.layer);

  // The interior (base + every unlocked layer, rug first) is composed once into this canvas and drawn
  // from it every frame; rebuildRoom() only reruns when an image finishes loading or the unlocked
  // item set changes.
  const roomCanvas = document.createElement('canvas');
  roomCanvas.width = roomCanvas.height = ART;
  const roomCtx = roomCanvas.getContext('2d');
  function rebuildRoom() {
    roomCtx.clearRect(0, 0, ART, ART);
    if (baseImg.complete && baseImg.naturalWidth) roomCtx.drawImage(baseImg, 0, 0);
    drawLayer(DRAW_FIRST);
    for (const u of INDOOR) if (u.id !== DRAW_FIRST) drawLayer(u.id);
  }
  function drawLayer(id) {
    const img = layerImgs[id];
    if (shown[id] && img.complete && img.naturalWidth) roomCtx.drawImage(img, 0, 0);
  }

  // ---- What the saved home level (Progression.state.homeLevel) means for the room ----
  // `shown` = layers baked into the cached canvas (an item that is mid pop-in is left out until its
  // animation ends); roomSolids = collision shapes for every unlocked item.
  const shown = {};
  const roomSolids = []; // [0, x0, y0, x1, y1] rects, [1, cx, cy, r] circles; rebuilt only when the level changes
  let builtLevel = -1;
  const level = () => Math.min(window.Progression.state.homeLevel, UPGRADES.length);
  function syncUnlocked() {
    const lv = level();
    roomSolids.length = 0;
    INDOOR.forEach((u, i) => {
      shown[u.id] = i < lv;
      if (i < lv) for (const sh of u.solids) roomSolids.push(sh.rect ? [0, ...sh.rect] : [1, ...sh.circle]);
    });
    builtLevel = lv;
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
    const P = window.Progression, lv = level(), seen = Math.min(P.state.homeSeenLevel, lv);
    pops.length = 0;
    syncUnlocked(); // clean slate (e.g. an animation cut short by leaving last time)
    if (lv > seen) {
      const names = [];
      for (let i = seen; i < Math.min(lv, INDOOR.length); i++) { // outdoor items just appear on the island
        const u = INDOOR[i], b = layerBBox(u.id);
        shown[u.id] = false; // keep it out of the cached canvas until its animation is done
        pops.push({ id: u.id, delay: POP.startDelay + (i - seen) * POP.stagger, cx: b.x + b.w / 2, cy: b.y + b.h / 2, played: false });
        names.push(`${u.name} (${u.perk})`);
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
  const ACTIONS = { sleep: startSleep }; // TODO: steps 4-5 add 'closet' (chest) and 'book' (shelf)
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
  function spotActive(i) { const u = INDOOR[i]; return !!u.hotspot && !!ACTIONS[u.hotspot.action] && i < level(); }
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
    if (scene !== 'interior' || phase !== 0 || sleep.phase) return;
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
  let turtle = null, hutX = 0, hutY = 0, bodyR = 22, maxSpeed = 0, accel = 0, decel = 0, onEnter = null;
  let scene = 'world';   // 'world' | 'interior' — which one is drawn/simulated
  let phase = 0;         // 0 = none, 1 = fading to black, 2 = fading back in
  let alpha = 0, pending = null;
  let fireX = 0, fireY = 0;
  const solids = [];     // world-space copies of HUT_SOLIDS
  const trigger = [0, 0, 0, 0];
  const room = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, speed: 0 }; // room (art px) coords
  const hutEntry = { x: 0, y: 0, type: 'custom', collide: false, draw: drawHut };

  function init(o) {
    turtle = o.turtle; bodyR = o.bodyRadius; maxSpeed = o.maxSpeed; accel = o.accel; decel = o.decel; onEnter = o.onEnter; onEnterInterior = o.onEnterInterior;
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
    for (const b of solids) pushOutRect(t, r, b[0], b[1], b[2], b[3]);
    if (level() > INDOOR.length) pushOutCircle(t, r, fireX, fireY, CONFIG.campfire.radius); // campfire (pit or lit)
  }
  function startFade(swap) { phase = 1; alpha = 0; pending = swap; }
  function enterSwap() {
    scene = 'interior';
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
    if (scene !== 'world' || phase !== 0) return;
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
    // Interior movement (art px): same feel as outside, scaled by the turtle's size in the room.
    const k = CONFIG.roomTurtleScale, hasInput = dir.x !== 0 || dir.y !== 0;
    const tvx = dir.x * maxSpeed * k, tvy = dir.y * maxSpeed * k, rate = (hasInput ? accel : decel) * k * dt;
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
    if (!hutImg.complete || !hutImg.naturalWidth) return;
    const s = CONFIG.hutScale;
    ctx.imageSmoothingEnabled = false; // pixel art
    ctx.drawImage(hutImg, hutX - ANCHOR_X * s, hutY - ANCHOR_Y * s, ART * s, ART * s);
    ctx.imageSmoothingEnabled = true;
  }
  // Flat ground-level pieces on the island, drawn under the turtle/scenery (so no depth sorting): the
  // outdoor campfire. `t` is real time in seconds (drives the flame animation).
  function drawGround(ctx, t) {
    const lv = level();
    if (lv <= INDOOR.length) return;
    const c = CONFIG.campfire, x = fireX - c.size / 2, y = fireY - c.size / 2;
    ctx.imageSmoothingEnabled = false;
    if (lv > INDOOR.length + 1) { // lit
      if (fireLitImg.complete && fireLitImg.naturalWidth) ctx.drawImage(fireLitImg, (Math.floor(t * c.fps) % 6) * 64, 0, 64, 64, x, y, c.size, c.size);
    } else if (fireUnlitImg.complete && fireUnlitImg.naturalWidth) ctx.drawImage(fireUnlitImg, x, y, c.size, c.size);
    ctx.imageSmoothingEnabled = true;
  }
  // Biggest whole-number scale that fits, room centered. Reused result object (no per-frame allocation).
  const L = { s: 1, x0: 0, y0: 0, tk: CONFIG.roomTurtleScale };
  function layout(w, h) {
    L.s = Math.max(1, Math.floor(Math.min(w, h) / ART));
    L.x0 = Math.floor((w - ART * L.s) / 2); L.y0 = Math.floor((h - ART * L.s) / 2);
    return L;
  }
  function drawRoom(ctx, lay, t) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(roomCanvas, lay.x0, lay.y0, ART * lay.s, ART * lay.s);
    drawPops(ctx, lay);
    ctx.imageSmoothingEnabled = true;
    if (!sleep.phase) drawFurnitureCues(ctx, lay, t);
  }
  // Pulsing outline on every tappable piece (brighter under the mouse), plus a bobbing "Tap" prompt
  // while the turtle is within nearbyPx of it.
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
      const pulse = 0.5 + 0.5 * Math.sin(t * 3);
      ctx.fillStyle = `rgba(255,255,255,${hov ? 0.18 : 0.04 + 0.05 * pulse})`;
      ctx.fillRect(x, y, w, hh);
      ctx.strokeStyle = `rgba(255,255,255,${hov ? 0.9 : 0.25 + 0.3 * pulse})`;
      ctx.lineWidth = Math.max(2, s);
      ctx.strokeRect(x, y, w, hh);
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
    const text = sleep.phase >= 2 ? sleep.msg : hint.timer > 0 ? hint.text : '';
    if (!text) return;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.max(15, Math.round(7 * lay.s))}px system-ui, sans-serif`;
    ctx.lineJoin = 'round'; ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(40,24,8,0.9)'; ctx.fillStyle = '#fff';
    const x = lay.x0 + ART * lay.s / 2, y = lay.y0 + (sleep.phase >= 2 ? 132 : 24) * lay.s;
    ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
    ctx.restore();
  }
  function drawFade(ctx, w, h) {
    if (alpha <= 0) return;
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fillRect(0, 0, w, h);
  }

  window.Home = {
    syncFromSave: syncUnlocked, hasFeature, UPGRADES,
    init, tick, collideWorld, checkDoor, layout, drawRoom, drawFade, drawGround, drawSleepDim, drawMessages, hutEntry, room,
    TURTLE_SCALE: CONFIG.roomTurtleScale, SLEEP_SCALE: CONFIG.sleep.scale, bedSpot: BED_SPOT,
    isAsleep: () => sleep.phase === 2,
    isInterior: () => scene === 'interior',
    // Safe zone flag for enemies/other systems: true whenever the player is inside the hut.
    insideHut: () => scene === 'interior',
    isPlayerSafe: () => scene === 'interior',
    exitPoint: () => ({ x: hutX, y: hutY + CONFIG.exitDropPx }),
    CONFIG,
  };
})();
