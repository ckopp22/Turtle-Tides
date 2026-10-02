// intro.js — pre-game flow: egg intro -> hatch/crawl -> beach menu -> save slots -> zoom into the
// island, handing off to game.js's own loop once the player is in. Runs as its own state machine
// on the same canvas game.js uses, so it matches the game's rendering approach (canvas draws each
// frame via requestAnimationFrame) and reuses the turtle sprite sheet. Stops driving the canvas the
// moment TurtleGame.start() takes over (see the master loop at the bottom).
//
// Placeholder art/audio note: no egg/cloud/palm sprites or sound files exist yet, so those are
// drawn with canvas shapes and "played" as simple WebAudio beeps below. Swap in real art/audio by
// replacing the draw*() shape code and the Sound.* beep() calls — everything that needs replacing
// is called out inline with a comment.
(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // ---- Config (tune freely) ----
  const CONFIG = {
    eggTaps: 5,          // taps to fully hatch (5 stages: see EGG_CRACK_STAGES below)
    slotCount: 4,
    nameMaxLen: 12,
    hatchWalkDuration: 2.2,  // seconds, egg spot -> water edge
    zoomInDuration: 0.5,
    zoomOutDuration: 0.6,
    colors: {
      sand: '#e6d6a8', water: '#1f7fa0', foam: 'rgba(255,255,255,0.85)',
      eggShade: '#cdb98d',
    },
  };

  // ---- Save data + sound preference (localStorage), wrapped so a private-browsing/corrupt read
  // never throws or wedges a scene. ----
  const SOUND_KEY = 'tt_soundOn';
  const slotKey = n => `tt_slot_${n}`;
  function readSound() {
    try { const v = localStorage.getItem(SOUND_KEY); return v === null ? true : v === '1'; }
    catch { return true; }
  }
  function writeSound(on) { try { localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch {} }
  function readSlot(n) {
    try {
      const raw = localStorage.getItem(slotKey(n));
      if (!raw) return null;
      const data = JSON.parse(raw);
      return (data && typeof data === 'object' && data.name) ? data : null;
    } catch { return null; } // corrupted JSON: treat the slot as empty rather than crash
  }
  function writeSlot(n, data) { try { localStorage.setItem(slotKey(n), JSON.stringify(data)); } catch {} }
  function deleteSlot(n) { try { localStorage.removeItem(slotKey(n)); } catch {} }
  // Bridge so progression.js (a separate module/IIFE) can read/write the same save slots without
  // duplicating the localStorage wrapper above.
  window.TT_SAVE = { readSlot, writeSlot, slotKey };

  // ---- Audio: WebAudio placeholder blips, gated by the mute toggle, started only after the first
  // tap (browsers block audio before user interaction). Replace beep() calls with real <audio> clips
  // once sound assets exist. ----
  let soundOn = readSound();
  let audioCtx = null;
  function unlockAudio() {
    if (audioCtx) return;
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
  function beep(freq, duration, type) {
    if (!soundOn || !audioCtx) return;
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.type = type || 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + duration);
  }
  // Real crack SFX (assets/sfx/egg-crack{1,2,3}.mp3): preloaded, one picked at random per tap.
  const crackClips = ['egg-crack2', 'egg-crack3'].map(name => {
    const a = new Audio(`assets/sfx/${name}.mp3`);
    a.volume = 0.6;
    return a;
  });
  // Real splash SFX (assets/sfx/splash.mp3): played whenever a save lands on the island (see launchIsland).
  const splashClip = new Audio('assets/sfx/splash.mp3');
  splashClip.volume = 0.6;
  // Coconut pickup SFX (assets/sfx/bag.m4a), played from game.js via TT_SOUND.coconut.
  const coconutClip = new Audio('assets/sfx/bag.m4a');
  coconutClip.volume = 0.6;
  // Coin pickup SFX (assets/sfx/coin.mp3), played from game.js via TT_SOUND.coin.
  const coinClip = new Audio('assets/sfx/coin.mp3');
  coinClip.volume = 0.6;
  // Bite SFX (assets/sfx/bite.mp3), played from progression.js via TT_SOUND.bite when eating from the HUD.
  const biteClip = new Audio('assets/sfx/bite.mp3');
  biteClip.volume = 0.6;
  // Shell pickup SFX (assets/sfx/shell.mp3), played from game.js via TT_SOUND.shell.
  const shellClip = new Audio('assets/sfx/shell.mp3');
  shellClip.volume = 0.6;
  // Walking loop (assets/sfx/walking.mp3), driven from game.js via TT_SOUND.walking(active) while moving on ground.
  const walkClip = new Audio('assets/sfx/walking.mp3');
  walkClip.loop = true;
  walkClip.volume = 0.6;
  // Swimming loop (assets/sfx/water-walking.mp3), same driver as the walking loop but while in water.
  const swimClip = new Audio('assets/sfx/water-walking.mp3');
  swimClip.loop = true;
  swimClip.volume = 0.1;
  swimClip.playbackRate = 0.7;
  const Sound = {
    crack: () => {
      if (!soundOn) return;
      const clip = crackClips[Math.floor(Math.random() * crackClips.length)];
      clip.currentTime = 0;
      clip.play().catch(() => {}); // autoplay can still be blocked pre-interaction; fail silently
    },
    splash: () => {
      if (!soundOn) return;
      splashClip.currentTime = 0;
      splashClip.play().catch(() => {});
    },
    bite: () => {
      if (!soundOn) return;
      biteClip.currentTime = 0;
      biteClip.play().catch(() => {});
    },
    coin: () => {
      if (!soundOn) return;
      coinClip.currentTime = 0;
      coinClip.play().catch(() => {});
    },
    coconut: () => {
      if (!soundOn) return;
      coconutClip.currentTime = 0;
      coconutClip.play().catch(() => {});
    },
    shell: () => {
      if (!soundOn) return;
      shellClip.currentTime = 0;
      shellClip.play().catch(() => {});
    },
    walking: active => {
      if (active && soundOn) { if (walkClip.paused) walkClip.play().catch(() => {}); }
      else if (!walkClip.paused) walkClip.pause();
    },
    swimming: (active, floating) => {
      swimClip.playbackRate = floating ? 0.5 : 1; // slower while just floating
      if (active && soundOn) { if (swimClip.paused) swimClip.play().catch(() => {}); }
      else if (!swimClip.paused) swimClip.pause();
    },
    hatch: () => beep(520, 0.35, 'triangle'),
    click: () => beep(440, 0.08, 'sine'),
    whoosh: () => beep(280, 0.45, 'sawtooth'),
  };
  // Bridge so the in-game HUD's sound toggle (progression.js) reads/writes the same on/off
  // preference as this screen's own mute button, instead of tracking a second copy of it.
  window.TT_SOUND = {
    get: () => soundOn,
    coconut: () => Sound.coconut(),
    coin: () => Sound.coin(),
    bite: () => Sound.bite(),
    shell: () => Sound.shell(),
    walking: active => Sound.walking(active),
    swimming: (active, floating) => Sound.swimming(active, floating),
    toggle: () => { soundOn = !soundOn; writeSound(soundOn); return soundOn; },
  };

  // ---- Sizing (mirrors game.js's own resize() so both agree on the same viewport). ----
  let dpr = 1, viewW = 0, viewH = 0;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    viewW = window.innerWidth; viewH = window.innerHeight;
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  // ---- Tiny scene manager: each scene is {enter, exit, update(dt), draw()}. on() tracks listeners
  // so exit() (via goto/teardownScene) can remove them — nothing leaks between scenes. ----
  let currentScene = null;
  let cleanupFns = [];
  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    cleanupFns.push(() => target.removeEventListener(type, fn, opts));
  }
  function teardownScene() {
    cleanupFns.forEach(fn => fn());
    cleanupFns = [];
    if (currentScene && currentScene.exit) currentScene.exit();
  }
  function goto(name, data) {
    teardownScene();
    currentScene = SCENES[name];
    if (currentScene.enter) currentScene.enter(data);
  }

  // ---- Zoom overlay: a simple eased whiteout used both for egg->menu and slot->island transitions,
  // independent of whichever scene is current so it can fade over a scene switch mid-transition. ----
  let overlay = null; // { t, phase: 'in'|'out', onPeak }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function startZoom(onPeak) { overlay = { t: 0, phase: 'in', onPeak }; }
  function updateOverlay(dt) {
    if (!overlay) return;
    if (overlay.phase === 'in') {
      overlay.t += dt / CONFIG.zoomInDuration;
      if (overlay.t >= 1) {
        overlay.t = 1;
        if (overlay.onPeak) overlay.onPeak();
        overlay.phase = 'out'; overlay.t = 0;
      }
    } else {
      overlay.t += dt / CONFIG.zoomOutDuration;
      if (overlay.t >= 1) overlay = null;
    }
  }
  function drawOverlay() {
    if (!overlay) return;
    const alpha = overlay.phase === 'in' ? easeOutCubic(overlay.t) : 1 - easeOutCubic(overlay.t);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.fillRect(0, 0, viewW, viewH);
    ctx.restore();
  }

  // ---- Pointer helpers (canvas fills the viewport, so client coords need no offset). ----
  function pointerPos(e) { return { x: e.clientX, y: e.clientY }; }
  function inRect(x, y, r) { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

  // ---- Shared UI drawing ----
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawButton(r, label, primary) {
    ctx.save();
    roundRect(r.x, r.y, r.w, r.h, 16);
    ctx.fillStyle = primary ? '#ffb347' : 'rgba(255,255,255,0.8)';
    ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#7a5a1e'; ctx.stroke();
    ctx.fillStyle = '#3a2a10';
    ctx.font = '700 24px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 2);
    ctx.restore();
  }
  // Matches the in-game sound button (progression.js SOUND_ON/OFF_SVG, style.css #tt-sound-btn):
  // same colors and 26x26 icon paths, drawn slightly transparent.
  function drawMuteIcon(r, on) {
    ctx.save();
    ctx.globalAlpha = 0.8;
    roundRect(r.x, r.y, r.w, r.h, 10);
    ctx.fillStyle = '#ffcb80'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#c9a15f'; ctx.stroke();
    ctx.translate(r.x + r.w / 2 - 13, r.y + r.h / 2 - 13);
    ctx.fillStyle = '#3a2a10';
    ctx.fill(new Path2D('M4 10h4l6-5v16l-6-5H4z'));
    ctx.lineCap = 'round';
    if (on) {
      ctx.strokeStyle = '#2f8fd4'; ctx.lineWidth = 2;
      ctx.stroke(new Path2D('M16 9a5 5 0 0 1 0 8'));
      ctx.stroke(new Path2D('M18.5 6.5a9 9 0 0 1 0 13'));
    } else {
      ctx.strokeStyle = '#d33a3a'; ctx.lineWidth = 2.5;
      ctx.stroke(new Path2D('M16 8l7 7M23 8l-7 7'));
    }
    ctx.restore();
  }
  // Beach backdrop shared by every scene: no sky — a straight-down sand view with a water band at
  // the bottom, matching the game's own top-down look, textured with the game's real ground tiles
  // (assets/tiles/*) instead of flat color. Neither tile loops cleanly on its own (opposite edges
  // don't match) — buildSeamlessTile() fixes that once per image at load, same trick game.js uses on
  // the same source files. `dim` gives the egg-intro/save-slots scenes a darker, moodier look.
  function buildSeamlessTile(img) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const hw = Math.round(w / 2), hh = Math.round(h / 2);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(img, -hw, -hh); g.drawImage(img, w - hw, -hh);
    g.drawImage(img, -hw, h - hh); g.drawImage(img, w - hw, h - hh);
    return c;
  }
  const groundTiles = { sand: { img: new Image(), pattern: null }, water: { img: new Image(), pattern: null } };
  groundTiles.sand.img.onload = () => { groundTiles.sand.pattern = ctx.createPattern(buildSeamlessTile(groundTiles.sand.img), 'repeat'); };
  groundTiles.sand.img.src = 'assets/tiles/sand3.png';
  groundTiles.water.img.onload = () => { groundTiles.water.pattern = ctx.createPattern(buildSeamlessTile(groundTiles.water.img), 'repeat'); };
  groundTiles.water.img.src = 'assets/tiles/water1.png';

  function beachLayout() {
    return { waterY: viewH * 0.72 }; // sand fills the rest of the view above this line
  }
  function drawBeach(t, dim) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { waterY } = beachLayout();
    ctx.fillStyle = groundTiles.sand.pattern || CONFIG.colors.sand; // flat fallback until the tile loads
    ctx.fillRect(0, 0, viewW, waterY);

    ctx.save();
    ctx.translate(0, waterY);
    ctx.fillStyle = groundTiles.water.pattern || CONFIG.colors.water;
    ctx.fillRect(0, 0, viewW, viewH - waterY);
    ctx.restore();

    ctx.strokeStyle = CONFIG.colors.foam;
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (let x = 0; x <= viewW; x += 20) {
      const yy = waterY + Math.sin(x * 0.02 + t * 1.6) * 5;
      if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    }
    ctx.stroke();
    // dim scenes (egg intro, save slots) get a single translucent overlay rather than their own
    // darker palette, so the real sand/water art still reads underneath instead of being recolored.
    if (dim) { ctx.fillStyle = 'rgba(8, 18, 32, 0.45)'; ctx.fillRect(0, 0, viewW, viewH); }
  }

  // A few of the real game's own scenery sprites (assets/scenery/*), scattered at fixed spots on the
  // menu's sand so it reads as the same island rather than an empty placeholder beach.
  const MENU_SCENERY_SPRITES = {};
  for (const name of ['round_tree_single', 'oak_tree', 'rock_beach', 'driftwood_stick']) {
    const img = new Image();
    img.src = `assets/scenery/${name}.png`;
    MENU_SCENERY_SPRITES[name] = img;
  }
  const MENU_SCENERY = [
    { sprite: 'round_tree_single', xf: 0.08, h: 130 },
    { sprite: 'oak_tree', xf: 0.95, h: 145 },
    { sprite: 'rock_beach', xf: 0.18, h: 58 },
    { sprite: 'driftwood_stick', xf: 0.84, h: 50 },
  ];
  function drawMenuScenery() {
    const { waterY } = beachLayout();
    for (const s of MENU_SCENERY) {
      const img = MENU_SCENERY_SPRITES[s.sprite];
      if (!img.complete || !img.naturalWidth) continue;
      const k = Math.min(1, viewW / 600); // shrink scenery on narrow portrait screens
      const dh = s.h * k, dw = dh * (img.naturalWidth / img.naturalHeight);
      const x = viewW * (viewW < 500 ? Math.min(0.88, Math.max(0.12, s.xf)) : s.xf), y = waterY - 4; // anchored at the shoreline, same as game.js's scenery
      ctx.drawImage(img, x - dw / 2, y - dh, dw, dh);
    }
  }
  // ---- Wandering menu turtle: reuses the main game's own sprite sheet (same row layout as
  // game.js's drawTurtle — row0 walk, row1 swim, row2 sleep, row4 shell) so it matches the in-game
  // turtle exactly, and just cycles through a few idle behaviors on the beach menu's sand/water bands.
  const menuSprite = new Image();
  menuSprite.src = 'assets/turtle-sheet.png';
  const MENU_BEHAVIOR_WEIGHT = { walk: 5, sleep: 2, shell: 1, swim: 2 }; // 'walk' is the default/most common
  function pickMenuBehavior(exclude) {
    const opts = Object.keys(MENU_BEHAVIOR_WEIGHT).filter(b => b !== exclude);
    let r = Math.random() * opts.reduce((s, b) => s + MENU_BEHAVIOR_WEIGHT[b], 0);
    for (const b of opts) { r -= MENU_BEHAVIOR_WEIGHT[b]; if (r <= 0) return b; }
    return opts[0];
  }
  const menuTurtle = { x: 0, y: 0, dir: 1, behavior: 'walk', timer: 0, walkFrame: 0 };
  function resetMenuTurtle() {
    const { waterY } = beachLayout();
    menuTurtle.x = viewW * 0.5; menuTurtle.y = waterY * 0.75;
    menuTurtle.dir = 1; menuTurtle.behavior = 'walk'; menuTurtle.timer = 3 + Math.random() * 3;
    menuTurtle.walkFrame = 0;
  }
  function updateMenuTurtle(dt) {
    const { waterY } = beachLayout();
    const walkY = waterY * 0.75, swimY = waterY + (viewH - waterY) * 0.35;
    const xMin = viewW * 0.12, xMax = viewW * 0.88;
    menuTurtle.timer -= dt;
    if (menuTurtle.behavior === 'walk' || menuTurtle.behavior === 'swim') {
      const speed = menuTurtle.behavior === 'swim' ? 55 : 40;
      menuTurtle.x += menuTurtle.dir * speed * dt;
      if (menuTurtle.x <= xMin) { menuTurtle.x = xMin; menuTurtle.dir = 1; }
      if (menuTurtle.x >= xMax) { menuTurtle.x = xMax; menuTurtle.dir = -1; }
      menuTurtle.walkFrame += speed * dt * 0.03;
      const targetY = menuTurtle.behavior === 'swim' ? swimY : walkY;
      menuTurtle.y += (targetY - menuTurtle.y) * Math.min(1, dt * 2); // ease across the shoreline, not a snap-cut
    }
    if (menuTurtle.timer <= 0) {
      menuTurtle.behavior = pickMenuBehavior(menuTurtle.behavior);
      menuTurtle.timer =
        menuTurtle.behavior === 'walk' ? 4 + Math.random() * 4 :
        menuTurtle.behavior === 'swim' ? 3 + Math.random() * 3 :
        menuTurtle.behavior === 'sleep' ? 2.5 + Math.random() * 2 :
        1.6 + Math.random() * 1.2; // shell
    }
  }
  function drawMenuTurtle(t) {
    if (!menuSprite.complete || !menuSprite.naturalWidth) return;
    const fw = menuSprite.naturalWidth / 8, fh = menuSprite.naturalHeight / 5;
    const dh = 60, dw = dh * fw / fh;
    let row = 0, f = 0, rotate = true;
    if (menuTurtle.behavior === 'sleep') { row = 2; f = Math.floor(t * 2) % 4; rotate = false; }
    else if (menuTurtle.behavior === 'shell') { row = 4; f = 0; rotate = false; }
    else if (menuTurtle.behavior === 'swim') { row = 1; f = Math.floor(menuTurtle.walkFrame) % 4; }
    else { row = 0; f = Math.floor(menuTurtle.walkFrame) % 4; }
    ctx.save();
    ctx.translate(menuTurtle.x, menuTurtle.y);
    if (rotate) ctx.rotate(menuTurtle.dir > 0 ? Math.PI / 2 : -Math.PI / 2); // sheet art faces up by default
    ctx.drawImage(menuSprite, f * fw, row * fh, fw, fh, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
  // Exactly the in-world "TURTLE TIDES / by Wesley Kopp" sand-drawn easter egg (game.js's
  // SAND_TEXT/SAND_SUBTEXT + strokeGroove/drawSandText) — a dug groove, not printed letters: a wide
  // soft dark stroke (the shadowed underside), then a thin bright stroke offset up-left (sand pushed
  // up on the near edge), no fill. Sized up from the in-world 72px/32px since this fills the screen
  // rather than a small patch of ground.
  function strokeGroove(text, x, y, weight) {
    ctx.lineWidth = weight;
    ctx.strokeStyle = 'rgba(110, 82, 44, 0.55)';
    ctx.strokeText(text, x + 3, y + 3);
    ctx.lineWidth = Math.max(1, weight * 0.3);
    ctx.strokeStyle = 'rgba(255, 246, 224, 0.5)';
    ctx.strokeText(text, x - 1.5, y - 1.5);
  }
  function drawTitle() {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    // Scale the title down on narrow (portrait phone) viewports so "TURTLE TIDES" never
    // runs past the screen edges; 96px is the size it was designed at, on a wide-enough view.
    const portrait = viewW < viewH * 0.8; // assumption: stack the title on two lines in portrait
    const titleSize = portrait ? Math.min(96, viewW * 0.24) : Math.min(96, viewW * 0.15);
    const subSize = titleSize * 42 / 96;
    const y0 = viewH * (portrait ? 0.14 : 0.22);
    ctx.font = `italic ${titleSize}px "Bradley Hand", "Comic Sans MS", cursive`;
    let subY = y0 + subSize * 74 / 42;
    if (portrait) {
      strokeGroove('TURTLE', viewW / 2, y0, titleSize * 13 / 96);
      strokeGroove('TIDES', viewW / 2, y0 + titleSize * 0.95, titleSize * 13 / 96);
      subY = y0 + titleSize * 0.95 + subSize * 1.6;
    } else {
      strokeGroove('TURTLE TIDES', viewW / 2, y0, titleSize * 13 / 96);
    }
    ctx.font = `italic ${subSize}px "Bradley Hand", "Comic Sans MS", cursive`;
    strokeGroove('by Wesley Kopp', viewW / 2, subY, subSize * 3 / 42);
    ctx.restore();
  }
  let pulseClock = 0;
  function drawPrompt(text, x, y) {
    const s = 1 + Math.sin(pulseClock * 3) * 0.08;
    ctx.save();
    ctx.translate(x, y); ctx.scale(s, s);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '600 22px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  // ---- Hatching-cycle reference art (assets/hatch/*.png) — a generated reference sheet, sliced
  // into 8 frames, each a full sand/beach still (not a transparent sprite), so they're drawn as
  // whole-screen "cover" backdrops rather than positioned sprites. Used for the egg/hatch scenes;
  // the main game's own turtle-sheet.png sprite is reused for the small idle icon on the beach menu.
  const HATCH_IMAGES = {};
  for (const name of ['egg1', 'egg2', 'egg3', 'hatch_emerge', 'hatch_out', 'walk1', 'stand', 'wave']) {
    const img = new Image();
    img.src = `assets/hatch/${name}.png`;
    HATCH_IMAGES[name] = img;
  }
  // Draws `img` as a framed panel over whatever backdrop the caller already drew, capped at its
  // native resolution (only ever downscaled, never upscaled) — stretching this low-res reference
  // art edge-to-edge across a big viewport just turns its soft shading into a blurry blow-up, so it
  // reads much better as a centered illustration than as a full-bleed background.
  function drawArtPanel(img) {
    if (!img.complete || !img.naturalWidth) return;
    const maxDim = Math.min(viewW, viewH) * 0.62;
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
    const x = (viewW - dw) / 2, y = (viewH - dh) / 2 - viewH * 0.04;
    ctx.save();
    roundRect(x, y, dw, dh, 18);
    ctx.save(); ctx.clip(); ctx.drawImage(img, x, y, dw, dh); ctx.restore();
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
    ctx.restore();
  }

  // ================= SCENE 1: EGG INTRO =================
  // 5 tap stages, each stepping to the next reference-art frame: small crack, bigger cracks, the
  // shell wobbling/chipping (held for 2 taps), then bursting open.
  const EGG_STAGE_IMAGES = ['egg1', 'egg2', 'egg3', 'hatch_emerge', 'hatch_emerge', 'hatch_out'];
  const eggState = { taps: 0, shakeTime: 0, burst: [], done: false };
  // New-game data riding along through EGG -> HATCH so the hatch finishes by dropping the player
  // straight onto the island instead of back at the beach menu. Null means "replaying the intro
  // standalone", which still just lands on BEACH_MENU.
  let pendingNewGame = null;
  function drawShardParticle(p) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - p.age / 0.6);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot + p.age * 4);
    ctx.fillStyle = CONFIG.colors.eggShade;
    ctx.beginPath(); ctx.moveTo(-6, -8); ctx.lineTo(6, -4); ctx.lineTo(2, 8); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  function spawnEggBurst() {
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      eggState.burst.push({
        x: viewW / 2, y: viewH / 2 + 40,
        vx: Math.cos(a) * 160, vy: Math.sin(a) * 160 - 80,
        age: 0, rot: Math.random() * Math.PI,
      });
    }
    Sound.hatch();
  }
  function onEggTap(e) {
    e.preventDefault();
    unlockAudio(); // first-ever interaction: safe point to create the AudioContext
    if (eggState.done) return;
    eggState.taps++;
    eggState.shakeTime = 0.15;
    Sound.crack();
    if (eggState.taps >= CONFIG.eggTaps) {
      eggState.done = true;
      spawnEggBurst();
      setTimeout(() => goto('HATCH'), 1400); // hold on the hatched-out art so it actually reads before cutting away
    }
  }
  const EGG = {
    enter(data) {
      pendingNewGame = data || null;
      eggState.taps = 0; eggState.shakeTime = 0; eggState.burst = []; eggState.done = false;
      on(canvas, 'pointerdown', onEggTap);
    },
    update(dt) {
      pulseClock += dt;
      if (eggState.shakeTime > 0) eggState.shakeTime = Math.max(0, eggState.shakeTime - dt);
      for (const p of eggState.burst) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 500 * dt; p.age += dt; }
    },
    draw() {
      const stage = Math.min(eggState.taps, EGG_STAGE_IMAGES.length - 1);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBeach(performance.now() / 1000, true);
      ctx.save();
      if (eggState.shakeTime > 0) {
        const s = eggState.shakeTime * 40;
        ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
      }
      drawArtPanel(HATCH_IMAGES[EGG_STAGE_IMAGES[stage]]);
      ctx.restore();
      if (!eggState.done) drawPrompt('Tap to crack', viewW / 2, viewH * 0.86);
      for (const p of eggState.burst) drawShardParticle(p);
    },
  };

  // ================= SCENE 2: HATCH & CRAWL =================
  // The reference art is a whole-scene still (turtle already on the sand, water in frame), so the
  // "crawl toward the water" motion is conveyed as: hold on the just-hatched frame a beat, crossfade
  // into the walking frame, then a slow Ken Burns zoom-in on it — rather than sliding a separate
  // sprite across a background.
  const HATCH_HOLD = 0.6;  // seconds holding on hatch_out before crossfading to walk1
  const HATCH_FADE = 0.7;  // crossfade duration
  let hatchT = 0, hatchDone = false;
  const HATCH = {
    enter() { hatchT = 0; hatchDone = false; },
    update(dt) {
      hatchT = Math.min(1, hatchT + dt / CONFIG.hatchWalkDuration);
      if (hatchT >= 1 && !hatchDone) {
        hatchDone = true;
        Sound.whoosh();
        // New game: skip the beach menu and drop straight onto the island. Replaying the intro
        // standalone (no pending save) just lands back on the menu.
        const newGame = pendingNewGame; pendingNewGame = null;
        startZoom(() => newGame ? launchIsland(newGame.data, newGame.slot) : goto('BEACH_MENU'));
      }
    },
    draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBeach(performance.now() / 1000, false);
      const elapsed = hatchT * CONFIG.hatchWalkDuration;
      const fade = Math.max(0, Math.min(1, (elapsed - HATCH_HOLD) / HATCH_FADE));
      const zoom = 1 + easeOutCubic(hatchT) * 0.06;
      ctx.save();
      ctx.translate(viewW / 2, viewH / 2); ctx.scale(zoom, zoom); ctx.translate(-viewW / 2, -viewH / 2);
      if (fade < 1) drawArtPanel(HATCH_IMAGES.hatch_out);
      if (fade > 0) { ctx.globalAlpha = fade; drawArtPanel(HATCH_IMAGES.walk1); ctx.globalAlpha = 1; }
      ctx.restore();
    },
  };

  // ================= SCENE 3: BEACH MENU =================
  function layoutMenu() {
    const portrait = viewW < viewH * 0.8;
    const playW = portrait ? Math.min(240, viewW * 0.6) : 200, playH = portrait ? 72 : 64;
    return {
      play: { x: viewW / 2 - playW / 2, y: viewH * (portrait ? 0.46 : 0.58), w: playW, h: playH },
      mute: { x: viewW - 64, y: 20, w: 44, h: 44 },
    };
  }
  function onMenuTap(e) {
    e.preventDefault();
    unlockAudio();
    const { x, y } = pointerPos(e);
    const L = layoutMenu();
    if (inRect(x, y, L.mute)) { soundOn = !soundOn; writeSound(soundOn); Sound.click(); return; }
    if (inRect(x, y, L.play)) { Sound.click(); goto('SAVE_SLOTS'); }
  }
  const BEACH_MENU = {
    enter() { resetMenuTurtle(); on(canvas, 'pointerdown', onMenuTap); },
    update(dt) { updateMenuTurtle(dt); },
    draw() {
      const t = performance.now() / 1000;
      drawBeach(t, false);
      drawMenuScenery();
      drawTitle();
      const L = layoutMenu();
      drawButton(L.play, 'PLAY', true);
      drawMenuTurtle(t); // after the button so the turtle walks over it
      drawMuteIcon(L.mute, soundOn);
    },
  };

  // ================= SCENE 4: SAVE SLOT SELECT =================
  let slotsCache = [];
  function refreshSlotsCache() {
    slotsCache = [];
    for (let i = 1; i <= CONFIG.slotCount; i++) slotsCache.push(readSlot(i));
  }
  function layoutSlots() {
    const pad = 20, top = viewH * 0.16;
    const cardH = Math.min(90, (viewH * 0.76) / CONFIG.slotCount - 14);
    const cardW = Math.min(420, viewW - pad * 2);
    const cards = [];
    for (let i = 0; i < CONFIG.slotCount; i++) {
      cards.push({ x: viewW / 2 - cardW / 2, y: top + i * (cardH +14), w: cardW, h: cardH, slot: i + 1 });
    }
    return { cards, back: { x: 20, y: 20, w: 90, h: 40 } };
  }
  function formatDate(iso) { try { return new Date(iso).toLocaleDateString(); } catch { return ''; } }
  // Same HUD art/badge style as progression.js's in-game panel (coin_hud.png/coconut.png icons,
  // #ffb347-fill + #7a5a1e-border level badge) so this screen reads as the same game.
  const slotCoinImg = new Image();
  slotCoinImg.src = 'assets/items/coin_hud.png';
  const slotCoconutImg = new Image();
  slotCoconutImg.src = 'assets/items/coconut.png';
  function drawSlotCard(r, data) {
    roundRect(r.x, r.y, r.w, r.h, 14);
    ctx.fillStyle = data ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.55)';
    ctx.fill();
    ctx.strokeStyle = '#3a2a10'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#2a2a2a'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    if (data) {
      ctx.font = '700 20px system-ui, sans-serif';
      ctx.fillText(data.name, r.x + 18, r.y + r.h * 0.34);

      const iconR = 10, rowY = r.y + r.h * 0.72;
      let ix = r.x + 18;
      ctx.font = '400 14px system-ui, sans-serif';
      if (slotCoinImg.complete && slotCoinImg.naturalWidth) ctx.drawImage(slotCoinImg, ix - iconR, rowY - iconR, iconR * 2, iconR * 2);
      ix += iconR * 2 + 4;
      const coinText = `${data.banked?.coins ?? 0}`;
      ctx.fillText(coinText, ix, rowY);
      ix += ctx.measureText(coinText).width + 16;
      if (slotCoconutImg.complete && slotCoconutImg.naturalWidth) ctx.drawImage(slotCoconutImg, ix - iconR, rowY - iconR, iconR * 2, iconR * 2);
      ix += iconR * 2 + 4;
      const coconutText = `${data.banked?.coconuts ?? 0}`;
      ctx.fillText(coconutText, ix, rowY);
      ix += ctx.measureText(coconutText).width + 14;

      ctx.font = '700 13px system-ui, sans-serif';
      const lvText = `Lv ${data.homeLevel ?? 0}`;
      const badgeW = ctx.measureText(lvText).width + 16, badgeH = 22;
      ctx.fillStyle = '#ffb347'; ctx.strokeStyle = '#7a5a1e'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(ix, rowY - badgeH / 2, badgeW, badgeH, 10); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#3a2a10'; ctx.textAlign = 'center';
      ctx.fillText(lvText, ix + badgeW / 2, rowY + 1);
      ix += badgeW + 14;

      ctx.textAlign = 'left'; ctx.fillStyle = '#2a2a2a'; ctx.font = '400 14px system-ui, sans-serif';
      ctx.fillText(formatDate(data.lastPlayedAt), ix, rowY);

      ctx.textAlign = 'center';
      ctx.fillStyle = '#b23a3a'; ctx.font = '700 20px system-ui, sans-serif';
      ctx.fillText('✕', r.x + r.w - 24, r.y + 20);
    } else {
      ctx.font = '700 18px system-ui, sans-serif';
      ctx.fillText('+ New Game', r.x + 18, r.y + r.h / 2);
    }
  }
  function onSlotsTap(e) {
    e.preventDefault();
    unlockAudio();
    const { x, y } = pointerPos(e);
    const L = layoutSlots();
    if (inRect(x, y, L.back)) { Sound.click(); goto('BEACH_MENU'); return; }
    for (const c of L.cards) {
      const data = slotsCache[c.slot - 1];
      if (data) {
        const delRect = { x: c.x + c.w - 40, y: c.y, w: 40, h: 36 };
        if (inRect(x, y, delRect)) {
          if (confirm(`Delete save "${data.name}"? This can't be undone.`)) {
            deleteSlot(c.slot); refreshSlotsCache(); Sound.click();
          }
          return;
        }
      }
      if (inRect(x, y, c)) {
        Sound.click();
        if (data) startZoomToIsland(data, c.slot);
        else openNameInput(c.slot);
        return;
      }
    }
  }
  const SAVE_SLOTS = {
    enter() { refreshSlotsCache(); on(canvas, 'pointerdown', onSlotsTap); },
    exit() { closeNameInput(); },
    draw() {
      drawBeach(performance.now() / 1000, true);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '700 26px system-ui, sans-serif';
      ctx.fillText('Your Game', viewW / 2, viewH * 0.08);
      const L = layoutSlots();
      L.cards.forEach(c => drawSlotCard(c, slotsCache[c.slot - 1]));
      drawButton(L.back, 'Back', false);
      ctx.restore();
    },
  };

  // Naming a new save needs a real text input (mobile keyboard, IME, etc.) — a small DOM overlay is
  // simplest here rather than hand-rolling text entry on canvas. Styling lives in style.css.
  let nameFormEl = null, nameInputEl = null;
  function openNameInput(slot) {
    closeNameInput();
    const wrap = document.createElement('div');
    wrap.className = 'tt-name-prompt';
    wrap.innerHTML =
      '<div class="tt-name-box">' +
        `<label for="tt-save-name">Name your save (max ${CONFIG.nameMaxLen} chars)</label>` +
        `<input id="tt-save-name" name="saveName" type="text" maxlength="${CONFIG.nameMaxLen}">` +
        '<div class="tt-name-actions">' +
          '<button type="button" class="tt-cancel">Cancel</button>' +
          '<button type="button" class="tt-confirm">Start</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    nameFormEl = wrap;
    nameInputEl = wrap.querySelector('input');
    nameInputEl.focus();
    wrap.querySelector('.tt-cancel').addEventListener('click', closeNameInput);
    wrap.querySelector('.tt-confirm').addEventListener('click', () => confirmName(slot));
    nameInputEl.addEventListener('keydown', e => { if (e.key === 'Enter') confirmName(slot); });
  }
  function confirmName(slot) {
    const name = (nameInputEl.value || '').trim();
    if (!name) { nameInputEl.focus(); return; } // validate: not blank
    const now = new Date().toISOString();
    // Schema matches progression.js's getSaveData()/loadFromSave() — see that file's CONFIG for what
    // each level means. Progression fills in defaults for any field an older save is missing.
    const data = {
      slotId: slot, name, createdAt: now, lastPlayedAt: now,
      heartsLevel: 0, hullLevel: 0, homeLevel: 0,
      banked: { coins: 0, coconuts: 0, shells: 0 },
      shellCollection: [],
    };
    writeSlot(slot, data);
    closeNameInput();
    goto('EGG', { data, slot }); // new save: hatch the turtle before dropping it on the island
  }
  function closeNameInput() {
    if (nameFormEl) { nameFormEl.remove(); nameFormEl = null; nameInputEl = null; }
  }

  // ================= SCENE 5: ZOOM TO HOME ISLAND =================
  // No separate scene object — startZoom()'s onPeak callback (below) starts game.js's own loop and
  // switches to the no-op GAME_HANDOFF scene, and the shared overlay (see above) handles the
  // zoom-in/zoom-out visuals for both this and the egg->menu transition.
  const GAME_HANDOFF = { enter() {}, exit() {}, update() {}, draw() {} };
  // The actual handoff, with no zoom of its own — callers that are already mid-transition (HATCH's
  // own zoom, for the new-game path) call this directly in their onPeak instead of nesting another
  // startZoom() call, which would stomp the in-flight overlay object and skip this entirely.
  function launchIsland(data, slot) {
    data.lastPlayedAt = new Date().toISOString();
    writeSlot(slot, data);
    goto('GAME_HANDOFF');
    Sound.splash(); // every arrival on the island, new or loaded save
    if (window.TurtleGame && window.TurtleGame.start) window.TurtleGame.start(slot, data);
  }
  function startZoomToIsland(data, slot) {
    Sound.whoosh();
    startZoom(() => launchIsland(data, slot));
  }

  const SCENES = { EGG, HATCH, BEACH_MENU, SAVE_SLOTS, GAME_HANDOFF };

  // ---- Master loop: drives the intro scenes until GAME_HANDOFF's zoom-out finishes, then stops
  // rescheduling itself — game.js's own requestAnimationFrame loop (started in startZoomToIsland's
  // onPeak) takes over the canvas completely from there. ----
  let lastT = 0;
  function loop(now) {
    const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
    lastT = now;
    if (currentScene && currentScene.update) currentScene.update(dt);
    updateOverlay(dt);
    if (currentScene && currentScene.draw) currentScene.draw();
    drawOverlay();
    if (currentScene !== SCENES.GAME_HANDOFF || overlay) requestAnimationFrame(loop);
  }
  function beginIntro() {
    resize();
    if (!window.innerWidth || !window.innerHeight) { requestAnimationFrame(beginIntro); return; }
    lastT = performance.now();
    goto('BEACH_MENU'); // land on the menu; EGG only plays when starting a new save (see confirmName)
    requestAnimationFrame(loop);
  }
  if (document.readyState === 'complete') beginIntro();
  else window.addEventListener('load', beginIntro);
})();
