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
    hutOffset: { x: 0, y: 55 },
  };

  // ---- Hut upgrades, bought in this order (one at a time) with banked coins. `layer` is a full
  // 192x192 transparent PNG drawn at (0,0) over the room. `solids` = collision shapes in room coords
  // (only active once bought): { rect: [x0, y0, x1, y1] } or { circle: [cx, cy, r] }. `unlocks` names
  // the feature this item enables (Home.hasFeature) for the sleep / book / closet steps.
  // Costs climb gently; the cheap early pieces make the first few buys quick wins.
  const UPGRADES = [
    { id: 'bed',     name: 'Bed',            layer: '01_bed_192.png',            cost: 20,  unlocks: 'sleep',          blurb: 'Tap it to sleep and restore all your hearts.', solids: [{ rect: [16, 44, 80, 108] }] },
    { id: 'rug',     name: 'Rug',            layer: '02_rug_192.png',            cost: 25,  unlocks: null,             blurb: 'A cozy woven rug for the middle of the room.', solids: [] },
    { id: 'doormat', name: 'Doormat',        layer: '03_doormat_192.png',        cost: 30,  unlocks: null,             blurb: 'Wipe your flippers on the way in.', solids: [] },
    { id: 'table',   name: 'Table & Stools', layer: '04_table_and_stools_192.png', cost: 45, unlocks: null,            blurb: 'A round table with two little stools.', solids: [{ circle: [152, 82, 18] }, { circle: [152, 112, 8] }, { circle: [128, 82, 8] }] },
    { id: 'shelf',   name: 'Shelf',          layer: '05_shelf_192.png',          cost: 60,  unlocks: 'collectionBook', blurb: 'Tap it to open your collection book.', solids: [] },
    { id: 'plant',   name: 'Plant',          layer: '06_plant_192.png',          cost: 75,  unlocks: null,             blurb: 'A little green friend for the corner.', solids: [{ circle: [30, 158, 9] }] },
    { id: 'lantern', name: 'Lantern',        layer: '07_lantern_192.png',        cost: 95,  unlocks: null,             blurb: 'A warm glow on the back wall.', solids: [] },
    { id: 'chest',   name: 'Chest',          layer: '08_chest_192.png',          cost: 120, unlocks: 'closet',         blurb: 'Tap it to open your closet and change outfits.', solids: [{ rect: [137, 141, 177, 169] }] },
  ];
  const DRAW_FIRST = 'rug'; // layered under every other item

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

  function load(src) { const i = new Image(); i.onload = rebuildRoom; i.src = src; return i; }
  const hutImg = load('assets/home/hut_exterior_192.png');
  const baseImg = load('assets/home/00_hut_interior_empty_192.png');
  const layerImgs = {};
  for (const u of UPGRADES) layerImgs[u.id] = load('assets/home/' + u.layer);

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
    for (const u of UPGRADES) if (u.id !== DRAW_FIRST) drawLayer(u.id);
  }
  function drawLayer(id) {
    const img = layerImgs[id];
    if (unlocked[id] && img.complete && img.naturalWidth) roomCtx.drawImage(img, 0, 0);
  }

  // ---- Unlocked set (saved in Progression.state.homeItems) + the collision shapes it implies ----
  const unlocked = {};
  const roomSolids = []; // rebuilt only when the set changes: [0, x0, y0, x1, y1] rects, [1, cx, cy, r] circles
  function syncUnlocked() {
    for (const u of UPGRADES) unlocked[u.id] = window.Progression.state.homeItems.includes(u.id);
    roomSolids.length = 0;
    for (const u of UPGRADES) {
      if (!unlocked[u.id]) continue;
      for (const sh of u.solids) roomSolids.push(sh.rect ? [0, ...sh.rect] : [1, ...sh.circle]);
    }
    rebuildRoom();
  }
  function nextUpgrade() { return UPGRADES.find(u => !unlocked[u.id]) || null; }
  function buyNext() {
    const u = nextUpgrade(), P = window.Progression;
    if (!u || !P.spendCoins(u.cost)) return false;
    P.unlockHomeItem(u.id);
    syncUnlocked();
    if (window.TT_SOUND) window.TT_SOUND.purchase();
    // TODO: step 6 — "pop in" scale/flash on the newly bought item.
    return true;
  }
  function hasFeature(name) { return UPGRADES.some(u => unlocked[u.id] && u.unlocks === name); }


  // ---- State ----
  let onEnterInterior = null;
  let turtle = null, hutX = 0, hutY = 0, bodyR = 22, maxSpeed = 0, accel = 0, decel = 0, onEnter = null;
  let scene = 'world';   // 'world' | 'interior' — which one is drawn/simulated
  let phase = 0;         // 0 = none, 1 = fading to black, 2 = fading back in
  let alpha = 0, pending = null;
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
  }
  function startFade(swap) { phase = 1; alpha = 0; pending = swap; }
  function enterSwap() {
    scene = 'interior';
    room.x = ROOM_SPAWN.x; room.y = ROOM_SPAWN.y; room.vx = room.vy = room.speed = 0; room.angle = -Math.PI / 2;
    if (onEnterInterior) onEnterInterior();
    setUiVisible(true);
  }
  function exitSwap() {
    scene = 'world';
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

    if (modal) { room.vx = room.vy = room.speed = 0; return true; } // a panel is open: the room is paused
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
    if (room.y >= ROOM_EXIT_Y) { setUiVisible(false); startFade(exitSwap); }
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
  // Biggest whole-number scale that fits, room centered. Reused result object (no per-frame allocation).
  const L = { s: 1, x0: 0, y0: 0, tk: CONFIG.roomTurtleScale };
  function layout(w, h) {
    L.s = Math.max(1, Math.floor(Math.min(w, h) / ART));
    L.x0 = Math.floor((w - ART * L.s) / 2); L.y0 = Math.floor((h - ART * L.s) / 2);
    return L;
  }
  function drawRoom(ctx, lay) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(roomCanvas, lay.x0, lay.y0, ART * lay.s, ART * lay.s);
    ctx.imageSmoothingEnabled = true;
  }
  function drawFade(ctx, w, h) {
    if (alpha <= 0) return;
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fillRect(0, 0, w, h);
  }

  // ---- UI: "Upgrade home" button (only inside the hut) + the upgrade panel. DOM, built on demand and
  // only redrawn when it opens or something is bought — nothing here runs per frame. ----
  let modal = false, upgradeBtn = null, panel = null;
  function setUiVisible(v) {
    if (!upgradeBtn) {
      upgradeBtn = document.createElement('button');
      upgradeBtn.id = 'tt-home-upgrade-btn';
      upgradeBtn.type = 'button';
      upgradeBtn.textContent = 'Upgrade home';
      upgradeBtn.addEventListener('click', openPanel);
      document.body.appendChild(upgradeBtn);
    }
    upgradeBtn.style.display = v ? 'block' : 'none';
    if (!v) closePanel();
  }
  // Tight alpha bounding box of a layer (art px), measured once per layer, so the preview can crop to
  // just the item instead of showing a mostly empty 192x192.
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
  function drawPreview(canvas, u) {
    const g = canvas.getContext('2d'), b = layerBBox(u.id), W = canvas.width;
    g.clearRect(0, 0, W, W);
    g.imageSmoothingEnabled = false;
    const sc = Math.max(1, Math.floor((W - 8) / Math.max(b.w, b.h))); // whole-number scale
    g.drawImage(layerImgs[u.id], b.x, b.y, b.w, b.h, Math.round((W - b.w * sc) / 2), Math.round((W - b.h * sc) / 2), b.w * sc, b.h * sc);
  }
  function openPanel() {
    closePanel();
    modal = true;
    const u = nextUpgrade(), coins = window.Progression.state.banked.coins, n = UPGRADES.filter(x => unlocked[x.id]).length;
    const wrap = document.createElement('div');
    wrap.className = 'tt-name-prompt';
    wrap.innerHTML = `<div class="tt-name-box tt-upgrade-box tt-home-box">
      <div class="tt-shop-header">
        <h3>Upgrade home</h3>
        <div class="tt-shop-coins"><img src="assets/items/coin.png" alt="">${coins}</div>
      </div>
      ${u ? `<canvas class="tt-home-preview" width="160" height="160"></canvas>
        <div class="tt-home-info"><strong>${u.name}</strong>
          <div class="tt-upgrade-detail">${u.blurb}</div>
          <div class="tt-upgrade-detail">Upgrade ${n + 1} of ${UPGRADES.length} · ${u.cost} coins</div></div>
        <button type="button" class="tt-upgrade-buy tt-home-buy" ${coins < u.cost ? 'disabled' : ''}>Buy — ${u.cost}</button>`
      : `<div class="tt-home-info"><strong>All done!</strong><div class="tt-upgrade-detail">Your home is fully upgraded.</div></div>`}
      <div class="tt-name-actions"><button type="button" class="tt-cancel tt-home-close">Close</button></div>
    </div>`;
    document.body.appendChild(wrap);
    panel = wrap;
    if (u) {
      drawPreview(wrap.querySelector('.tt-home-preview'), u);
      wrap.querySelector('.tt-home-buy').addEventListener('click', () => { if (buyNext()) openPanel(); });
    }
    wrap.querySelector('.tt-home-close').addEventListener('click', closePanel);
    wrap.addEventListener('click', e => { if (e.target === wrap) closePanel(); }); // tap the dim backdrop to close
  }
  function closePanel() {
    if (panel) { panel.remove(); panel = null; }
    modal = false;
  }
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && panel) closePanel(); });

  window.Home = {
    syncFromSave: syncUnlocked, hasFeature, UPGRADES,
    init, tick, collideWorld, checkDoor, layout, drawRoom, drawFade, hutEntry, room,
    TURTLE_SCALE: CONFIG.roomTurtleScale,
    isInterior: () => scene === 'interior',
    // Safe zone flag for enemies/other systems: true whenever the player is inside the hut.
    insideHut: () => scene === 'interior',
    isPlayerSafe: () => scene === 'interior',
    exitPoint: () => ({ x: hutX, y: hutY + CONFIG.exitDropPx }),
    CONFIG,
  };
})();
