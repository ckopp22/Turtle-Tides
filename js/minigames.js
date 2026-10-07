// minigames.js — the plant's two mini games: Baby Turtle Dash and Survival. Opened from home.js (MiniGames.open) while the hut room
// is paused. game.js hooks in through MiniGames.mode()/update()/renderDash()/drawWorld(); it also hands over the turtle's own
// movement, the map's collision and the world render via TurtleGame.mini, and enemies.js provides the real enemy AI as an
// isolated "arena" pool. Nothing here touches the main world's enemies, hearts, turtle position or map state: game.js's
// miniEnter()/miniExit() save and restore the turtle, and Enemies.arena.stop() puts the main pool back.
// Every tunable number lives in CONFIG below.
(() => {
  'use strict';

  const CONFIG = {
    maxDt: 0.05,                  // seconds: frame time clamp
    mobileWidth: 768,             // px: viewports this narrow or less use the mobile caps below

    // ---------------- Baby Turtle Dash ----------------
    dash: {
      targetViewW: 1000,          // beach units shown across the screen at scale 1; scale = viewW / this, clamped:
      minScale: 0.45, maxScale: 1.3, // (phones get a smaller, wider-looking beach so the crossing isn't tiny)
      nestW: 130, waterW: 150,    // beach units: nest zone on the left (hazards stay out), water strip on the right
      turtleR: 11,                // beach units: baby turtle's body radius (hit tests + obstacle collision)
      turtleSpeedMult: 1,         // x the main turtle's land speed
      startGraceSeconds: 1,       // no hazard can hit for this long at the start of each round
      bannerSeconds: 1.6,         // "Round N complete!" pause before the next round starts
      gridCell: 24,               // winnable-path check grid (beach units)
      pathPad: 6,                 // extra clearance the path check keeps around obstacles, on top of turtleR
      obstacleGap: 36,            // min empty space between two static obstacles
      maxObstacleCircles: 64, placeAttempts: 14,
      // Per-round scaling: value = clamp(base + per * (round - 1), lo, hi). Counts are floored. The caps keep rounds winnable and phones smooth.
      ramp: {
        obstacles:   { base: 7,   per: 1,     lo: 0,    hi: 18 },   // static groups (rock / driftwood / shell / tide pool)
        crabs:       { base: 2,   per: 0.5,   lo: 0,    hi: 7 },
        dogs:        { base: 0.6, per: 0.4,   lo: 0,    hi: 4 },    // first dog in round 2
        seagulls:    { base: 1,   per: 0.35,  lo: 0,    hi: 4 },
        people:      { base: 1,   per: 0.4,   lo: 0,    hi: 5 },
        crabSpeed:   { base: 55,  per: 4,     lo: 0,    hi: 110 }, // beach units/s
        personSpeed: { base: 45,  per: 3,     lo: 0,    hi: 90 },
        dogWander:   { base: 40,  per: 2,     lo: 0,    hi: 70 },
        dogChase:    { base: 0.6, per: 0.03,  lo: 0,    hi: 0.88 }, // x turtle speed: always slower than the turtle, so a dog can be outrun
        dogDetect:   { base: 170, per: 14,    lo: 0,    hi: 320 },  // beach units: wider every round
        gullInterval:{ base: 5,   per: -0.4,  lo: 1.8,  hi: 5 },    // seconds between one gull's swoops: more frequent every round
        gullTrack:   { base: 1.5, per: -0.06, lo: 0.9,  hi: 1.5 },  // seconds the shadow follows the turtle before it locks
      },
      crabLen: [140, 260], personLen: [260, 600], // patrol path lengths (people are clamped to the beach)
      dogLeash: 130,              // wander radius around its home spot
      dogLoseMult: 1.7, dogLoseSeconds: 2,   // gives up once the turtle is this x detect away for this long
      gullLockSeconds: 0.55, gullSwoopSeconds: 0.28, gullSnatchR: 34, gullTrackSpeed: 85, gullDive: 420,
      hitR: { crab: 17, dog: 19 },            // hazard body radius added to the turtle's
      personFeet: { rx: 20, ry: 11 },        // a person's feet ellipse: the turtle's centre inside it is a hit
      // Coins at the end of each completed round: base + perRound * (round - 1), capped, plus a speed bonus.
      coins: { base: 3, perRound: 2, max: 60, parSeconds: 12, bonusPerSecond: 0.5, bonusMax: 5 },
      pools: { crabs: 7, dogs: 4, gulls: 4, people: 5 }, // = the ramp caps above
    },

    // ---------------- Survival ----------------
    survival: {
      startEnemies: 3, addEverySeconds: 10, maxEnemies: 12, maxEnemiesMobile: 8, // live enemy target = start + elapsed / addEvery, capped
      detectEverySeconds: 15, detectBonusPx: 40, detectBonusMax: 240,           // every enemy's detect radius grows by this much per step
      speedEverySeconds: 20, speedStep: 0.03, speedMax: 1.2,                     // optional small speed ramp (x base)
      maxSpeedFrac: 0.95,                                                        // a slow type never gets faster than this x the turtle (the snake is exempt, as in the main game)
      weights: { crab: 3, bear: 2, snake: 2, seagull: 2 },                       // spawn mix
      startGraceSeconds: 1.5,     // first telegraph comes this long after the start
      spawn: {
        tickSeconds: 0.25,        // how often the spawner runs
        attempts: 10,             // tries to find a valid spot per tick
        marginMin: 60, marginMax: 260, // world px outside the camera view a spawn appears
        minPlayerDist: 380,       // never closer than this to the turtle
        telegraphSeconds: 0.9,    // warning marker before the enemy appears
        maxPending: 3,            // warnings at once
        recycleScreens: 2.2,      // an enemy this many screens away is removed so a new one spawns near the turtle
      },
      startRing: [250, 650],      // the turtle starts this far (world px) beyond the water ring, on the mainland
      // Coins: perChunk every perSeconds survived, plus a one-time bonus at each milestone (seconds, coins). Paid as it's earned.
      coins: { perSeconds: 10, perChunk: 1, milestones: [[30, 5], [60, 12], [120, 30], [180, 50]] },
    },
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Asset map. EVERY sprite goes through here. `src` = real art (a sprite sheet of `cols` frames per row, `rows` by name, drawn at
  // `size` px; `faces` says which way the art points). With no `src` (or while it loads) the placeholder `draw(g, size, t)` runs:
  // it draws centred on (0,0) facing +x, `size` px across. To swap in real art: set `src` (+ cols/rows/faces) and nothing else changes.
  // ---------------------------------------------------------------------------------------------------------------
  const ASSETS = {
    babyTurtle: { src: 'assets/minigames/baby_turtle_walk_4f.png', cols: 4, rows: {}, size: 44, faces: 'right', draw: drawBabyTurtle },
    seagull:    { src: 'assets/enemies/seagull_spritesheet.png', cols: 6, rows: { fly: 3, attack: 2 }, size: 64, faces: 'up' }, // existing
    crab:       { src: 'assets/enemies/crab_spritesheet.png', cols: 6, rows: { walk: 1 }, size: 56, faces: 'side' },              // existing
    dog:        { src: 'assets/minigames/dog_walk_4f.png', cols: 4, rows: {}, size: 64, faces: 'right', draw: drawDog },
    dogRun:     { src: 'assets/minigames/dog_run_4f.png', cols: 4, rows: {}, size: 64, faces: 'right', draw: drawDog }, // used while chasing
    person:     { src: 'assets/minigames/person_walk_4f.png', cols: 4, rows: {}, size: 60, faces: 'right', draw: drawPerson },  // top-down, centred on the person (feet ellipse = the hit area)
    person2:    { src: 'assets/minigames/person2_walk_4f.png', cols: 4, rows: {}, size: 60, faces: 'right', draw: drawPerson },
    rock: { src: 'assets/minigames/rock.png', cols: 1, rows: {}, size: 64, faces: 'right', draw: drawRock },
    driftwood: { src: 'assets/minigames/driftwood.png', cols: 1, rows: {}, size: 64, faces: 'right', draw: drawDriftwood },
    shell: { src: 'assets/minigames/big_shell.png', cols: 1, rows: {}, size: 64, faces: 'right', draw: drawShell },
    tidepool: { src: 'assets/minigames/tide_pool.png', cols: 1, rows: {}, size: 64, faces: 'right', draw: drawTidePool },
    nest: { src: 'assets/minigames/nest_128.png', cols: 1, rows: {}, size: 128, faces: 'right', draw: drawNest },
    notice:     { src: 'assets/enemies/notice_exclaim.png', cols: 1, rows: {}, size: 24, faces: 'up' }, // existing "!"
  };
  const images = {};
  for (const k in ASSETS) if (ASSETS[k].src) { const img = new Image(); img.onload = () => { if (D) bakeBackground(); }; img.src = ASSETS[k].src; images[k] = img; } // re-bake the static scene once art arrives

  // Draws asset `key` centred at (x, y). frame/row pick the sheet cell (ignored by placeholders; `t` is their animation clock).
  // rot: heading in radians (0 = right). flip: -1 mirrors a sideways sprite. scale multiplies the asset's size.
  function drawArt(g, key, x, y, rot, flip, scale, frame, row, t) {
    const a = ASSETS[key], img = images[key], size = a.size * scale;
    g.save();
    g.translate(x, y);
    if (img && img.complete && img.naturalWidth) {
      const F = img.naturalWidth / a.cols;
      if (a.faces === 'side') { if (flip < 0) g.scale(-1, 1); }
      else g.rotate(rot + (a.faces === 'up' ? Math.PI / 2 : 0));
      g.drawImage(img, frame * F, (a.rows[row] || 0) * F, F, F, -size / 2, -size / 2, size, size);
    } else if (a.draw) {
      g.rotate(rot);
      if (flip < 0) g.scale(1, -1);
      a.draw(g, size, t);
    } // sheet art that hasn't loaded yet: skip this frame
    g.restore();
  }

  // ---- Placeholder art (simple shapes, all in one place so they're easy to delete once real art exists) ----
  function drawBabyTurtle(g, size, t) {
    const r = size / 2, w = Math.sin(t * 16) * 0.35;
    g.fillStyle = '#7bc47f';
    for (const [fx, fy, a] of [[0.35, -0.55, -0.6 + w], [0.35, 0.55, 0.6 - w], [-0.4, -0.5, -2.3 - w], [-0.4, 0.5, 2.3 + w]]) {
      g.save(); g.translate(fx * r, fy * r); g.rotate(a); g.beginPath(); g.ellipse(r * 0.22, 0, r * 0.4, r * 0.18, 0, 0, 7); g.fill(); g.restore();
    }
    g.beginPath(); g.arc(r * 0.85, 0, r * 0.3, 0, 7); g.fill();          // head
    g.fillStyle = '#3f8f55'; g.beginPath(); g.ellipse(0, 0, r * 0.8, r * 0.62, 0, 0, 7); g.fill(); // shell
    g.strokeStyle = '#2b6b3d'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(-r * 0.4, 0); g.lineTo(r * 0.4, 0); g.moveTo(0, -r * 0.45); g.lineTo(0, r * 0.45); g.stroke();
  }
  function drawDog(g, size, t) {
    const r = size / 2, leg = Math.sin(t * 14) * r * 0.18;
    g.fillStyle = '#6b4a2b'; g.fillRect(-r * 0.5 + leg, -r * 0.42, r * 0.22, r * 0.84); g.fillRect(r * 0.2 - leg, -r * 0.42, r * 0.22, r * 0.84); // legs (top view)
    g.fillStyle = '#a9743f'; g.beginPath(); g.ellipse(-r * 0.05, 0, r * 0.62, r * 0.38, 0, 0, 7); g.fill();   // body
    g.beginPath(); g.arc(r * 0.62, 0, r * 0.3, 0, 7); g.fill();                                              // head
    g.fillStyle = '#5a3a1c'; g.beginPath(); g.ellipse(r * 0.55, -r * 0.28, r * 0.12, r * 0.18, 0, 0, 7); g.ellipse(r * 0.55, r * 0.28, r * 0.12, r * 0.18, 0, 0, 7); g.fill(); // ears
    g.strokeStyle = '#a9743f'; g.lineWidth = 3; g.beginPath(); g.moveTo(-r * 0.62, 0); g.lineTo(-r * 0.95, Math.sin(t * 12) * r * 0.2); g.stroke(); // tail
  }
  function drawPerson(g, size, t) { // drawn upright (screen up), ignoring rotation: feet at (0,0)... shifted so the feet sit at the draw point
    g.rotate(0);
    const h = size, sw = Math.sin(t * 8) * h * 0.06;
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.beginPath(); g.ellipse(0, 0, h * 0.28, h * 0.1, 0, 0, 7); g.fill(); // shadow
    g.fillStyle = '#3b5b8c'; g.fillRect(-h * 0.14 + sw, -h * 0.34, h * 0.11, h * 0.34); g.fillRect(h * 0.03 - sw, -h * 0.34, h * 0.11, h * 0.34); // legs
    g.fillStyle = '#e0674d'; g.fillRect(-h * 0.2, -h * 0.68, h * 0.4, h * 0.36);                                  // shirt
    g.fillStyle = '#f0c8a0'; g.beginPath(); g.arc(0, -h * 0.8, h * 0.13, 0, 7); g.fill();                         // head
    g.fillStyle = '#f2d36a'; g.beginPath(); g.ellipse(0, -h * 0.86, h * 0.2, h * 0.07, 0, 0, 7); g.fill();         // sun hat
  }
  function drawRock(g, size) {
    const r = size / 2;
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.beginPath(); g.ellipse(r * 0.08, r * 0.14, r * 0.95, r * 0.8, 0, 0, 7); g.fill();
    g.fillStyle = '#8a8a8a'; g.beginPath(); g.moveTo(-r * 0.9, r * 0.1); g.lineTo(-r * 0.5, -r * 0.7); g.lineTo(r * 0.3, -r * 0.8); g.lineTo(r * 0.9, -r * 0.1); g.lineTo(r * 0.55, r * 0.7); g.lineTo(-r * 0.4, r * 0.8); g.closePath(); g.fill();
    g.fillStyle = '#a8a8a8'; g.beginPath(); g.moveTo(-r * 0.5, -r * 0.7); g.lineTo(r * 0.3, -r * 0.8); g.lineTo(r * 0.1, -r * 0.1); g.lineTo(-r * 0.5, -r * 0.2); g.closePath(); g.fill();
  }
  function drawDriftwood(g, size) { // size = length; the log is a rounded bar
    const L = size, w = Math.min(size * 0.3, 26);
    g.fillStyle = 'rgba(0,0,0,0.15)'; g.beginPath(); g.ellipse(2, 5, L / 2, w / 2 + 2, 0, 0, 7); g.fill();
    g.fillStyle = '#9a7650'; g.beginPath(); g.roundRect(-L / 2, -w / 2, L, w, w / 2); g.fill();
    g.strokeStyle = '#6f5436'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(-L * 0.35, -w * 0.12); g.lineTo(L * 0.3, -w * 0.12); g.moveTo(-L * 0.25, w * 0.2); g.lineTo(L * 0.35, w * 0.2); g.stroke();
  }
  function drawShell(g, size) {
    const r = size / 2;
    g.fillStyle = 'rgba(0,0,0,0.15)'; g.beginPath(); g.ellipse(2, 3, r * 0.95, r * 0.8, 0, 0, 7); g.fill();
    g.fillStyle = '#f4c4b0'; g.beginPath(); g.moveTo(-r * 0.9, r * 0.5); g.quadraticCurveTo(-r, -r * 0.9, 0, -r * 0.9); g.quadraticCurveTo(r, -r * 0.9, r * 0.9, r * 0.5); g.closePath(); g.fill();
    g.strokeStyle = '#d99a85'; g.lineWidth = 1.5; g.beginPath(); for (let i = -2; i <= 2; i++) { g.moveTo(i * r * 0.3, r * 0.5); g.lineTo(i * r * 0.15, -r * 0.8); } g.stroke();
  }
  function drawTidePool(g, size) {
    const r = size / 2;
    g.fillStyle = '#c9ad74'; g.beginPath(); g.ellipse(0, 0, r, r * 0.82, 0, 0, 7); g.fill();       // wet rim
    g.fillStyle = '#4fa8d8'; g.beginPath(); g.ellipse(0, 0, r * 0.82, r * 0.64, 0, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.ellipse(-r * 0.25, -r * 0.2, r * 0.3, r * 0.1, -0.3, 0, 7); g.fill();
  }
  function drawNest(g, size) {
    const r = size / 2;
    g.fillStyle = '#c9a869'; g.beginPath(); g.ellipse(0, 0, r * 0.72, r * 0.6, 0, 0, 7); g.fill();
    g.fillStyle = '#b08f4f'; g.beginPath(); g.ellipse(0, 0, r * 0.52, r * 0.42, 0, 0, 7); g.fill();
    g.fillStyle = '#fbf3df'; for (const [x, y] of [[-0.2, -0.08], [0.15, -0.15], [0.05, 0.14], [-0.28, 0.16]]) { g.beginPath(); g.ellipse(x * r, y * r, r * 0.1, r * 0.13, 0.4, 0, 7); g.fill(); } // hatched shells
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------------------------------------------
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const ramp = (R, r) => clamp(R.base + R.per * (r - 1), R.lo, R.hi);
  const fmtTime = sec => { const s = Math.floor(sec); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const isMobile = () => window.innerWidth <= CONFIG.mobileWidth;
  const P = () => window.Progression;
  const sfxCoin = () => { if (window.TT_SOUND) window.TT_SOUND.coin(); };
  const api = () => window.TurtleGame.mini;

  // ---------------------------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------------------------
  let onDone = null;          // home.js's closeScreen: leaves the minigame screen, back to the hut
  let overlay = null;         // menu / pause / results overlay (one at a time)
  let hud = null, hudA = null, hudB = null, banner = null; // in-game DOM HUD
  let view = null;            // null (not open) | 'menu' | 'dash' | 'survival'
  let phase = 'menu';         // 'play' | 'banner' | 'paused' | 'over'  (dash and survival share these)
  let D = null, S = null;     // dash / survival runtime, null when not running

  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  function setOverlay(box) { // swaps the overlay for a new card (or removes it with null)
    if (overlay) { overlay.remove(); overlay = null; }
    if (!box) return;
    overlay = el('div', 'tt-name-prompt tt-mg-overlay');
    overlay.appendChild(box);
    overlay.addEventListener('click', onOverlayClick);
    document.body.appendChild(overlay);
  }
  function onOverlayClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'dash') startDash();
    else if (act === 'survival') startSurvival();
    else if (act === 'close') { if (onDone) onDone(); else close(); }
    else if (act === 'resume') setPaused(false);
    else if (act === 'quit') finishRun(false);
    else if (act === 'again') { const v = view; stopGame(); if (v === 'dash') startDash(); else startSurvival(); }
    else if (act === 'menu') { stopGame(); showMenu(); }
  }

  function showMenu() {
    view = 'menu'; phase = 'menu';
    const best = P().state.minigames;
    const box = el('div', 'tt-name-box tt-mg-box');
    box.innerHTML = `<h3>Mini games</h3>
      <button type="button" class="tt-mg-big" data-act="dash"><strong>Baby Turtle Dash</strong><span>Best: ${best.dashBest} ${best.dashBest === 1 ? 'round' : 'rounds'}</span></button>
      <button type="button" class="tt-mg-big" data-act="survival"><strong>Survival</strong><span>Best: ${fmtTime(best.survivalBest)}</span></button>
      <div class="tt-name-actions"><button type="button" class="tt-cancel" data-act="close">Close</button></div>`;
    setOverlay(box);
  }

  // In-game DOM HUD: a stat pill (top centre) and a pause button. DOM text is only touched when its value changes.
  function buildHud(a, b) {
    hud = el('div', 'tt-mg-hud');
    hudA = el('span', 'tt-mg-a', a); hudB = el('span', 'tt-mg-b');
    const pill = el('div', 'tt-mg-pill'); pill.append(hudA, hudB); if (!b) hudB.style.display = 'none';
    const pause = el('button', 'tt-mg-pause', '&#10074;&#10074;'); pause.type = 'button'; pause.setAttribute('aria-label', 'Pause');
    pause.addEventListener('click', () => { if (phase === 'play') setPaused(true); });
    hud.append(pill, pause);
    document.body.appendChild(hud);
    document.body.classList.add('tt-mg-running'); // hides the shop/compass icons while a game runs
  }
  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
  function showBanner(title, sub) {
    if (!banner) { banner = el('div', 'tt-mg-banner'); document.body.appendChild(banner); }
    banner.innerHTML = `<strong>${title}</strong><span>${sub}</span>`;
    banner.style.display = 'flex';
  }
  function hideBanner() { if (banner) banner.style.display = 'none'; }

  function setPaused(on) {
    if (on && phase === 'play') {
      phase = 'paused';
      const box = el('div', 'tt-name-box tt-mg-box');
      box.innerHTML = `<h3>Paused</h3><div class="tt-mg-col"><button type="button" class="tt-upgrade-buy" data-act="resume">Resume</button><button type="button" class="tt-cancel" data-act="quit">Quit run</button></div>`;
      setOverlay(box);
    } else if (!on && phase === 'paused') { phase = 'play'; setOverlay(null); }
  }

  // Results card for both games. `rows` = [label, value] pairs.
  function showResults(title, rows, record) {
    phase = 'over'; hideBanner();
    const box = el('div', 'tt-name-box tt-mg-box');
    box.innerHTML = `<h3>${title}</h3>${record ? '<div class="tt-mg-record">New Record!</div>' : ''}
      <div class="tt-mg-rows">${rows.map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`).join('')}</div>
      <div class="tt-name-actions"><button type="button" class="tt-cancel" data-act="menu">Back to Menu</button><button type="button" class="tt-upgrade-buy" data-act="again">Play Again</button></div>`;
    setOverlay(box);
  }

  // Ends the current run (caught, or "Quit run" from the pause card) and shows the results.
  function finishRun(caught) {
    if (phase === 'over') return;
    if (view === 'dash') {
      const rounds = D.rounds, rec = rounds > D.bestAtStart;
      P().setMinigameBest('dashBest', rounds);
      if (window.TT_SOUND && caught) window.TT_SOUND.gameover();
      showResults(caught ? 'Oh no!' : 'Run over', [['Rounds completed', rounds], ['Coins earned', D.coinsRun], ['Best', Math.max(rounds, D.bestAtStart) + (Math.max(rounds, D.bestAtStart) === 1 ? ' round' : ' rounds')]], rec);
    } else if (view === 'survival') {
      const t = S.elapsed, rec = t > S.bestAtStart;
      P().setMinigameBest('survivalBest', t);
      if (window.TT_SOUND && caught) window.TT_SOUND.gameover();
      showResults(caught ? 'Oh no!' : 'Run over', [['Time survived', fmtTime(t)], ['Coins earned', S.paid], ['Best', fmtTime(Math.max(t, S.bestAtStart))]], rec);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Public API (home.js / game.js)
  // ---------------------------------------------------------------------------------------------------------------
  function open(done) {
    onDone = done;
    document.addEventListener('visibilitychange', onHidden);
    showMenu();
  }
  function onHidden() { if (document.hidden) setPaused(true); } // tab hidden: pause a running game
  // Idempotent full teardown: running game, DOM, listeners. Does NOT call onDone (that's home.js calling us).
  function close() {
    if (view === 'dash' || view === 'survival') {
      if (view === 'survival' && S) P().setMinigameBest('survivalBest', S.elapsed); // closing mid-run still keeps the time
      stopGame();
    }
    setOverlay(null);
    document.removeEventListener('visibilitychange', onHidden);
    onDone = null; view = null; phase = 'menu';
  }
  function escape() { // Escape key (routed from home.js)
    if (view === 'menu') { if (onDone) onDone(); else close(); }
    else if (phase === 'play') setPaused(true);
    else if (phase === 'paused') setPaused(false);
    else if (phase === 'over') { stopGame(); showMenu(); }
  }
  // game.js asks this each frame: which game owns the frame (null = the normal hut/world). Stays set on the results card so the
  // frozen scene shows behind it.
  function mode() { return view === 'dash' || view === 'survival' ? view : null; }
  function update(dt) {
    dt = Math.min(dt, CONFIG.maxDt);
    if (view === 'dash') updateDash(dt); else if (view === 'survival') updateSurvival(dt);
  }
  // Releases the running game: pools, canvases, DOM HUD, the saved turtle (back to the hut), and the arena enemies.
  function stopGame() {
    if (view === 'dash') releaseDash();
    else if (view === 'survival') releaseSurvival();
    if (hud) { hud.remove(); hud = hudA = hudB = null; }
    hideBanner(); if (banner) { banner.remove(); banner = null; }
    document.body.classList.remove('tt-mg-running');
    setOverlay(null);
    api().exit();
    view = 'menu'; phase = 'menu';
  }

  // ===============================================================================================================
  // Baby Turtle Dash
  // ===============================================================================================================
  const DC = CONFIG.dash;
  function makeDash() {
    const pool = (n, make) => { const a = []; for (let i = 0; i < n; i++) a.push(make()); return a; };
    const m = DC.maxObstacleCircles;
    return {
      round: 1, rounds: 0, coinsRun: 0, bestAtStart: P().state.minigames.dashBest,
      t: 0, grace: 0, bannerT: 0, clock: 0, walk: 0,
      vw: 0, vh: 0, s: 1, W: 0, H: 0, goalX: 0, nestX: 0, nestY: 0, bgScale: 1,
      bg: document.createElement('canvas'), cols: 0, rows: 0, grid: new Uint8Array(1), queue: new Int32Array(1),
      v: { crabSpeed: 0, personSpeed: 0, dogWander: 0, dogChase: 0, dogDetect: 0, gullInterval: 0, gullTrack: 0 }, // this round's ramp values
      on: 0, ox: new Float32Array(m), oy: new Float32Array(m), or: new Float32Array(m), ok: new Uint8Array(m), oa: new Float32Array(m), // static circles; ok: kind
      crabs: pool(DC.pools.crabs, makePatroller), people: pool(DC.pools.people, makePatroller),
      dogs: pool(DC.pools.dogs, () => ({ on: false, x: 0, y: 0, hx: 0, hy: 0, tx: 0, ty: 0, chasing: false, hasT: false, pause: 0, lose: 0, ang: 0, notice: 0 })),
      gulls: pool(DC.pools.gulls, () => ({ on: false, st: 0, timer: 0, sx: 0, sy: 0, tx: 0, ty: 0, ex: 0, ey: 0, ang: 0, u: 0, snatch: false })),
    };
  }
  function makePatroller() { return { on: false, x0: 0, y0: 0, x1: 0, y1: 0, len: 1, u: 0, dir: 1, speed: 0, x: 0, y: 0, flip: 1, pause: 0 }; }

  function startDash() {
    if (!window.TurtleGame) return;
    setOverlay(null);
    view = 'dash'; phase = 'play';
    D = makeDash();
    api().enter();
    buildHud('Round 1', false);
    startRound(1);
  }
  function releaseDash() {
    if (!D) return;
    for (const list of [D.crabs, D.people, D.dogs, D.gulls]) for (const h of list) h.on = false;
    D.on = 0; D.bg.width = D.bg.height = 0; D = null; // drops the baked background
  }

  // Lays out a fresh, winnable beach for `round`, resets every hazard, and puts the turtle back in the nest. No allocation: all pools are reused.
  function startRound(round) {
    const m = api(), sz = m.size(), tt = m.turtle;
    D.round = round; D.t = 0; D.grace = DC.startGraceSeconds; D.bannerT = 0;
    D.vw = sz.w; D.vh = sz.h;
    D.s = clamp(sz.w / DC.targetViewW, DC.minScale, DC.maxScale);
    D.W = sz.w / D.s; D.H = sz.h / D.s;
    D.goalX = D.W - DC.waterW + 18;
    D.nestX = DC.nestW * 0.5; D.nestY = D.H * 0.5 + rand(-0.15, 0.15) * D.H;
    const v = D.v, R = DC.ramp;
    v.crabSpeed = ramp(R.crabSpeed, round); v.personSpeed = ramp(R.personSpeed, round);
    v.dogWander = ramp(R.dogWander, round); v.dogChase = ramp(R.dogChase, round) * m.basePlayerSpeed;
    v.dogDetect = ramp(R.dogDetect, round); v.gullInterval = ramp(R.gullInterval, round); v.gullTrack = ramp(R.gullTrack, round);
    // path-check grid (resized only when the view changes)
    const c = DC.gridCell, cols = Math.ceil(D.W / c), rows = Math.ceil(D.H / c);
    if (cols * rows > D.grid.length) { D.grid = new Uint8Array(cols * rows); D.queue = new Int32Array(cols * rows); }
    D.cols = cols; D.rows = rows;
    placeObstacles(Math.floor(ramp(R.obstacles, round)));
    placeHazards(round);
    tt.x = D.nestX; tt.y = D.nestY; tt.vx = tt.vy = 0; tt.angle = 0;
    bakeBackground();
    setText(hudA, 'Round ' + round);
    hideBanner();
    phase = 'play';
  }

  // ---- winnable-path guarantee: obstacles are only kept if a flood fill still reaches the water from the nest ----
  function markCircle(cx, cy, rr) {
    const c = DC.gridCell, cols = D.cols, rows = D.rows, g = D.grid;
    const x0 = Math.max(0, Math.floor((cx - rr) / c)), x1 = Math.min(cols - 1, Math.floor((cx + rr) / c));
    const y0 = Math.max(0, Math.floor((cy - rr) / c)), y1 = Math.min(rows - 1, Math.floor((cy + rr) / c));
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
      const dx = (gx + 0.5) * c - cx, dy = (gy + 0.5) * c - cy;
      if (dx * dx + dy * dy < rr * rr) g[gy * cols + gx] = 1;
    }
  }
  function rasterize() {
    D.grid.fill(0, 0, D.cols * D.rows);
    for (let i = 0; i < D.on; i++) markCircle(D.ox[i], D.oy[i], D.or[i] + DC.turtleR + DC.pathPad);
  }
  function reachable() { // 8-way flood fill from the nest to any cell at/after the shoreline
    const c = DC.gridCell, cols = D.cols, rows = D.rows, g = D.grid, q = D.queue;
    const sx = clamp(Math.floor(D.nestX / c), 0, cols - 1), sy = clamp(Math.floor(D.nestY / c), 0, rows - 1);
    const seen = reachSeen(cols * rows);
    let head = 0, tail = 0;
    q[tail++] = sy * cols + sx; seen[sy * cols + sx] = 1;
    while (head < tail) {
      const k = q[head++], cx = k % cols, cy = (k - cx) / cols;
      if ((cx + 0.5) * c >= D.goalX) return true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const nk = ny * cols + nx;
        if (seen[nk] || g[nk]) continue;
        if (dx && dy && (g[cy * cols + nx] || g[ny * cols + cx])) continue; // no squeezing diagonally between two blocked cells
        seen[nk] = 1; q[tail++] = nk;
      }
    }
    return false;
  }
  let seenBuf = new Uint8Array(1);
  function reachSeen(n) { if (seenBuf.length < n) seenBuf = new Uint8Array(n); seenBuf.fill(0, 0, n); return seenBuf; }

  // Kinds: 0 rock, 1 driftwood (head circle: drawn as the whole log), 2 driftwood (collision-only circle), 3 shell, 4 tide pool
  function placeObstacles(groups) {
    D.on = 0; rasterize();
    const x0 = DC.nestW + 50, x1 = D.goalX - 60;
    for (let n = 0; n < groups; n++) {
      for (let attempt = 0; attempt < DC.placeAttempts; attempt++) {
        const roll = Math.random(), kind = roll < 0.3 ? 0 : roll < 0.5 ? 1 : roll < 0.75 ? 3 : 4;
        const x = rand(x0, x1), y = rand(50, D.H - 50), before = D.on;
        if (kind === 1) {
          const a = rand(0, Math.PI); // log along a random angle: three overlapping circles
          for (let i = -1; i <= 1; i++) pushObstacle(i === -1 ? 1 : 2, x + Math.cos(a) * 24 * i, y + Math.sin(a) * 24 * i, 13, a);
        } else pushObstacle(kind, x, y, kind === 0 ? rand(18, 30) : kind === 3 ? rand(11, 16) : rand(28, 44), rand(0, 6.28));
        if (D.on > before && fits(before)) {
          for (let i = before; i < D.on; i++) markCircle(D.ox[i], D.oy[i], D.or[i] + DC.turtleR + DC.pathPad);
          if (reachable()) break; // kept
        }
        D.on = before; rasterize(); // rejected: undo
      }
    }
  }
  function pushObstacle(kind, x, y, r, a) {
    const i = D.on;
    if (i >= DC.maxObstacleCircles || x - r < DC.nestW + 20 || x + r > D.goalX - 20 || y - r < 20 || y + r > D.H - 20) { D.on = DC.maxObstacleCircles + 1; return; } // out of room/bounds: poison so fits() fails
    D.ox[i] = x; D.oy[i] = y; D.or[i] = r; D.ok[i] = kind; D.oa[i] = a; D.on++;
  }
  function fits(before) { // new circles (from `before`) keep a gap from every older circle
    if (D.on > DC.maxObstacleCircles) return false;
    for (let i = before; i < D.on; i++) for (let j = 0; j < before; j++) {
      const dx = D.ox[i] - D.ox[j], dy = D.oy[i] - D.oy[j], m = D.or[i] + D.or[j] + DC.obstacleGap;
      if (dx * dx + dy * dy < m * m) return false;
    }
    return true;
  }
  function clearOfObstacles(x, y, pad) {
    for (let i = 0; i < D.on; i++) { const dx = x - D.ox[i], dy = y - D.oy[i], m = D.or[i] + pad; if (dx * dx + dy * dy < m * m) return false; }
    return true;
  }
  function laneClear(x0, y0, x1, y1, pad) { // sample along a patrol segment
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 28);
    for (let i = 0; i <= n; i++) if (!clearOfObstacles(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, pad)) return false;
    return true;
  }

  function setPatrol(h, x0, y0, x1, y1, speed) {
    h.on = true; h.x0 = x0; h.y0 = y0; h.x1 = x1; h.y1 = y1; h.len = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
    h.u = Math.random(); h.dir = Math.random() < 0.5 ? 1 : -1; h.speed = speed; h.pause = 0; h.flip = 1;
    h.x = x0 + (x1 - x0) * h.u; h.y = y0 + (y1 - y0) * h.u;
  }
  function placeHazards(round) {
    const R = DC.ramp, v = D.v, xMin = DC.nestW + 40, xMax = D.goalX - 30;
    for (const list of [D.crabs, D.people, D.dogs, D.gulls]) for (const h of list) h.on = false;
    // crabs: sideways patrols (mostly horizontal, a little slant)
    const nCrab = Math.min(D.crabs.length, Math.floor(ramp(R.crabs, round)));
    for (let i = 0, placed = 0; placed < nCrab && i < nCrab * 8; i++) {
      const len = rand(DC.crabLen[0], DC.crabLen[1]), x0 = rand(xMin + 20, xMax - len - 10), y0 = rand(50, D.H - 50), y1 = clamp(y0 + rand(-40, 40), 40, D.H - 40);
      if (x0 + len > xMax || !laneClear(x0, y0, x0 + len, y1, 24)) continue;
      setPatrol(D.crabs[placed++], x0, y0, x0 + len, y1, v.crabSpeed);
    }
    // people: long walks, horizontal or vertical, on separate lanes
    const nPer = Math.min(D.people.length, Math.floor(ramp(R.people, round)));
    for (let i = 0, placed = 0; placed < nPer && i < nPer * 10; i++) {
      const vertical = Math.random() < 0.5;
      let x0, y0, x1, y1;
      if (vertical) { x0 = x1 = rand(xMin + 40, xMax - 40); y0 = rand(30, D.H * 0.35); y1 = rand(D.H * 0.65, D.H - 30); }
      else { y0 = y1 = rand(60, D.H - 60); x0 = rand(xMin, xMin + 120); x1 = rand(xMax - 160, xMax); }
      let apart = true; // lanes at least 110 apart so a few people never wall the beach off
      for (let j = 0; j < placed; j++) { const p = D.people[j]; const same = (p.x0 === p.x1) === vertical; if (same && Math.abs(vertical ? p.x0 - x0 : p.y0 - y0) < 110) apart = false; }
      if (!apart || !laneClear(x0, y0, x1, y1, 30)) continue;
      setPatrol(D.people[placed++], x0, y0, x1, y1, v.personSpeed);
    }
    // dogs: home spot away from the nest, wandering until the turtle comes close
    const nDog = Math.min(D.dogs.length, Math.floor(ramp(R.dogs, round)));
    for (let i = 0, placed = 0; placed < nDog && i < nDog * 12; i++) {
      const x = rand(Math.max(xMin + 200, D.W * 0.4), xMax - 40), y = rand(60, D.H - 60);
      if (!clearOfObstacles(x, y, 40)) continue;
      const d = D.dogs[placed++];
      d.on = true; d.x = d.hx = x; d.y = d.hy = y; d.chasing = false; d.hasT = false; d.pause = rand(0.5, 2); d.lose = 0; d.ang = rand(0, 6.28); d.notice = 0;
    }
    // gulls: first swoop only after the grace period
    const nGull = Math.min(D.gulls.length, Math.floor(ramp(R.seagulls, round)));
    for (let i = 0; i < nGull; i++) { const g = D.gulls[i]; g.on = true; g.st = 0; g.timer = DC.startGraceSeconds + rand(1.5, v.gullInterval + 1.5); }
  }

  // ---- baked background: sand, water, nest and every static obstacle, drawn once per round ----
  function bakeBackground() {
    D.bgScale = Math.min(window.devicePixelRatio || 1, 1.5);
    const bg = D.bg, w = Math.round(D.vw * D.bgScale), h = Math.round(D.vh * D.bgScale);
    if (bg.width !== w || bg.height !== h) { bg.width = w; bg.height = h; }
    const g = bg.getContext('2d'), k = D.bgScale * D.s;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, h);
    g.setTransform(k, 0, 0, k, 0, 0);
    const wx = D.W - DC.waterW;
    const sand = g.createLinearGradient(0, 0, wx, 0); sand.addColorStop(0, '#f1dca4'); sand.addColorStop(0.7, '#ecd59b'); sand.addColorStop(1, '#d6bb82'); // wetter near the water
    g.fillStyle = sand; g.fillRect(0, 0, wx + 20, D.H);
    g.fillStyle = 'rgba(150,120,70,0.22)';
    for (let i = 0; i < 160; i++) { g.beginPath(); g.arc(rand(0, wx), rand(0, D.H), rand(0.8, 2.2), 0, 7); g.fill(); } // sand speckles
    const water = g.createLinearGradient(wx, 0, D.W, 0); water.addColorStop(0, '#5cb8e0'); water.addColorStop(1, '#1d6fa8');
    g.fillStyle = water; g.beginPath(); g.moveTo(wx, 0);
    for (let y = 0; y <= D.H + 20; y += 20) g.lineTo(wx + Math.sin(y * 0.05) * 7, y); // wavy shoreline
    g.lineTo(D.W, D.H); g.lineTo(D.W, 0); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 3; g.beginPath();
    for (let y = 0; y <= D.H + 20; y += 20) { const x = wx + Math.sin(y * 0.05) * 7; if (y === 0) g.moveTo(x, y); else g.lineTo(x, y); }
    g.stroke();
    drawArt(g, 'nest', D.nestX, D.nestY, 0, 1, 1, 0, 'idle', 0);
    for (let i = 0; i < D.on; i++) {
      const kind = D.ok[i], r = D.or[i];
      if (kind === 2) continue; // the log is drawn once, from its head circle
      if (kind === 1) drawArt(g, 'driftwood', D.ox[i] + Math.cos(D.oa[i]) * 24, D.oy[i] + Math.sin(D.oa[i]) * 24, D.oa[i], 1, 100 / ASSETS.driftwood.size, 0, 'idle', 0); // centre of the 3 circles, ~100 long
      else drawArt(g, kind === 0 ? 'rock' : kind === 3 ? 'shell' : 'tidepool', D.ox[i], D.oy[i], kind === 3 ? D.oa[i] * 0.3 : 0, 1, r * 2 / ASSETS.rock.size * (kind === 0 ? 1.1 : 1.05), 0, 'idle', 0);
    }
  }

  // ---- per-frame ----
  function updateDash(dt) {
    if (phase === 'banner') { D.bannerT -= dt; if (D.bannerT <= 0) startRound(D.round + 1); return; }
    if (phase !== 'play') return;
    const m = api(), tt = m.turtle, sz = m.size();
    if (Math.abs(sz.w - D.vw) > 1 || Math.abs(sz.h - D.vh) > 1) { startRound(D.round); return; } // window resized / phone rotated: re-lay this round to fit
    D.t += dt; D.clock += dt; if (D.grace > 0) D.grace -= dt;
    const speed = m.move(dt, DC.turtleSpeedMult, false);
    // static obstacles: push the turtle out of any circle it overlaps
    const R = DC.turtleR;
    for (let i = 0; i < D.on; i++) {
      const dx = tt.x - D.ox[i], dy = tt.y - D.oy[i], min = R + D.or[i], d2 = dx * dx + dy * dy;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2) || 0.001, k = (min - d) / d;
      if (d2 < 1e-6) tt.x += min; else { tt.x += dx * k; tt.y += dy * k; }
    }
    tt.x = clamp(tt.x, R, D.W - R); tt.y = clamp(tt.y, R, D.H - R);
    if (speed > 5) D.walk += dt; // the placeholder walk cycle only runs while moving
    updateHazards(dt, tt);
    if (D.grace <= 0 && hitTest(tt)) { finishRun(true); return; }
    if (tt.x >= D.goalX) roundComplete();
  }

  function updateHazards(dt, tt) {
    const v = D.v, W = D.W, H = D.H, xMin = DC.nestW + 10, xMax = D.goalX - 10;
    for (const list of [D.crabs, D.people]) for (const h of list) {
      if (!h.on) continue;
      if (h.pause > 0) { h.pause -= dt; continue; }
      h.u += h.dir * h.speed * dt / h.len;
      if (h.u >= 1 || h.u <= 0) { h.u = clamp(h.u, 0, 1); h.dir = -h.dir; h.pause = 0.35; }
      const px = h.x; h.x = h.x0 + (h.x1 - h.x0) * h.u; h.y = h.y0 + (h.y1 - h.y0) * h.u;
      if (Math.abs(h.x - px) > 0.01) h.flip = h.x > px ? 1 : -1;
    }
    const detect2 = v.dogDetect * v.dogDetect, lose2 = (v.dogDetect * DC.dogLoseMult) ** 2, leash2 = DC.dogLeash * DC.dogLeash;
    for (const d of D.dogs) {
      if (!d.on) continue;
      const dx = tt.x - d.x, dy = tt.y - d.y, d2 = dx * dx + dy * dy;
      if (d.notice > 0) d.notice -= dt;
      let tx = d.x, ty = d.y, sp = 0;
      if (d.chasing) {
        if (d2 > lose2) { d.lose += dt; if (d.lose > DC.dogLoseSeconds) { d.chasing = false; d.hasT = false; d.lose = 0; } } else d.lose = 0;
        tx = tt.x; ty = tt.y; sp = v.dogChase;
        if (tt.x < DC.nestW) { d.chasing = false; d.hasT = false; } // the nest zone is safe
      } else {
        if (D.grace <= 0 && d2 < detect2 && tt.x > DC.nestW) { d.chasing = true; d.notice = 0.7; d.lose = 0; }
        else if (d.hasT) {
          tx = d.tx; ty = d.ty; sp = v.dogWander;
          if ((tx - d.x) ** 2 + (ty - d.y) ** 2 < 100) { d.hasT = false; d.pause = rand(0.8, 2.2); }
        } else {
          d.pause -= dt;
          if (d.pause <= 0) { // pick a wander spot within the leash that's clear of obstacles
            for (let k = 0; k < 4; k++) {
              const a = rand(0, 6.28), r = rand(0.4, 1) * DC.dogLeash, x = d.hx + Math.cos(a) * r, y = d.hy + Math.sin(a) * r;
              if (x > xMin + 20 && x < xMax - 20 && y > 30 && y < H - 30 && clearOfObstacles(x, y, 34)) { d.tx = x; d.ty = y; d.hasT = true; break; }
            }
            if (!d.hasT) d.pause = 1;
          }
        }
      }
      if (sp > 0) {
        const ux = tx - d.x, uy = ty - d.y, l = Math.hypot(ux, uy);
        if (l > 1) { d.x += ux / l * sp * dt; d.y += uy / l * sp * dt; d.ang = Math.atan2(uy, ux); }
        for (let i = 0; i < D.on; i++) { // slide around obstacles
          const ex = d.x - D.ox[i], ey = d.y - D.oy[i], min = 18 + D.or[i], e2 = ex * ex + ey * ey;
          if (e2 < min * min && e2 > 1e-6) { const e = Math.sqrt(e2), k = (min - e) / e; d.x += ex * k; d.y += ey * k; }
        }
        d.x = clamp(d.x, xMin, xMax); d.y = clamp(d.y, 20, H - 20);
      }
    }
    // seagulls: idle -> shadow tracks the turtle -> shadow locks (warning) -> swoop -> leave
    for (const g of D.gulls) {
      if (!g.on) continue;
      g.timer -= dt;
      if (g.st === 0) { // idle between swoops
        if (g.timer <= 0) { // start tracking: the shadow appears a screen-ish away and drifts toward the turtle
          const a = rand(0, 6.28);
          g.sx = clamp(tt.x + Math.cos(a) * 280, 40, W - 40); g.sy = clamp(tt.y + Math.sin(a) * 280, 40, H - 40);
          g.st = 1; g.timer = v.gullTrack;
        }
      } else if (g.st === 1) { // tracking
        const dx = tt.x - g.sx, dy = tt.y - g.sy, l = Math.hypot(dx, dy) || 1, step = Math.min(DC.gullTrackSpeed * dt, l);
        g.sx += dx / l * step; g.sy += dy / l * step;
        if (g.timer <= 0) { g.st = 2; g.timer = DC.gullLockSeconds; g.tx = g.sx; g.ty = g.sy; }
      } else if (g.st === 2) { // locked: the shadow holds still and grows; the turtle can still run
        if (g.timer <= 0) { g.st = 3; g.timer = DC.gullSwoopSeconds; g.ang = Math.atan2(DC.gullDive, 300); }
      } else if (g.st === 3) { // swoop in
        g.u = 1 - Math.max(0, g.timer) / DC.gullSwoopSeconds;
        if (g.timer <= 0) { g.st = 4; g.timer = 0.45; g.snatch = true; }
      } else { // leaving
        g.u = 1 - Math.max(0, g.timer) / 0.45;
        if (g.timer <= 0) { g.st = 0; g.timer = rand(0.6, 1) * v.gullInterval; g.snatch = false; }
      }
    }
  }

  // One hit ends the run. Returns true if the turtle is caught this frame.
  function hitTest(tt) {
    const R = DC.turtleR;
    for (const c of D.crabs) if (c.on) { const m = R + DC.hitR.crab, dx = tt.x - c.x, dy = tt.y - c.y; if (dx * dx + dy * dy < m * m) return true; }
    for (const d of D.dogs) if (d.on) { const m = R + DC.hitR.dog, dx = tt.x - d.x, dy = tt.y - d.y; if (dx * dx + dy * dy < m * m) return true; }
    const F = DC.personFeet;
    for (const p of D.people) if (p.on) { const dx = (tt.x - p.x) / (F.rx + R * 0.5), dy = (tt.y - p.y) / (F.ry + R * 0.5); if (dx * dx + dy * dy < 1) return true; }
    for (const g of D.gulls) if (g.on && g.st === 4 && g.snatch) { // the swoop just landed: snatch if the turtle is under it
      g.snatch = false;
      const m = DC.gullSnatchR + R, dx = tt.x - g.tx, dy = tt.y - g.ty;
      if (dx * dx + dy * dy < m * m) return true;
    }
    return false;
  }

  function roundComplete() {
    const C = DC.coins, n = D.round;
    const bonus = Math.min(C.bonusMax, Math.max(0, Math.floor((C.parSeconds - D.t) * C.bonusPerSecond)));
    const coins = Math.min(C.max, C.base + C.perRound * (n - 1)) + bonus;
    P().grantBankedCoins(coins); sfxCoin(); // into the real coin total right now, so a failed next round loses nothing
    D.coinsRun += coins; D.rounds = n;
    P().setMinigameBest('dashBest', n);
    phase = 'banner'; D.bannerT = DC.bannerSeconds;
    showBanner(`Round ${n} complete!`, `+${coins} coins${bonus ? ` (speed bonus +${bonus})` : ''}`);
  }

  // Draws the whole Dash scene (game.js calls this instead of the world render). Only moving things are drawn each frame.
  function renderDash(g, vw, vh, t) {
    if (!D) return;
    g.drawImage(D.bg, 0, 0, vw, vh);
    g.save(); g.scale(D.s, D.s);
    const wx = D.W - DC.waterW;
    g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 2; g.beginPath(); // drifting water glints
    for (let i = 0; i < 7; i++) {
      const y = (i * D.H / 7 + t * 14) % D.H, x = wx + 40 + ((i * 37) % (DC.waterW - 80));
      g.moveTo(x, y); g.quadraticCurveTo(x + 12, y - 4, x + 24, y);
    }
    g.stroke();
    const tt = api().turtle, clock = D.clock;
    // gull shadows (the warning) go on the ground, under everything
    for (const gl of D.gulls) {
      if (!gl.on || gl.st === 0 || gl.st === 4) continue;
      const sx = gl.st === 3 ? gl.tx : gl.sx, sy = gl.st === 3 ? gl.ty : gl.sy;
      const k = gl.st === 1 ? 0.5 : gl.st === 2 ? 0.7 + 0.5 * (1 - gl.timer / DC.gullLockSeconds) : 1.2;
      g.fillStyle = gl.st === 1 ? 'rgba(0,0,0,0.22)' : 'rgba(40,0,0,0.38)';
      g.beginPath(); g.ellipse(sx, sy, 24 * k, 12 * k, 0, 0, 7); g.fill();
      if (gl.st === 2) { g.strokeStyle = 'rgba(220,40,40,0.8)'; g.lineWidth = 2; g.beginPath(); g.ellipse(sx, sy, DC.gullSnatchR, DC.gullSnatchR * 0.55, 0, 0, 7); g.stroke(); }
    }
    for (const c of D.crabs) if (c.on) drawArt(g, 'crab', c.x, c.y, 0, c.flip, 0.8, Math.floor(clock * 8) % 6, 'walk', clock);
    for (const d of D.dogs) if (d.on) {
      drawArt(g, d.chasing ? 'dogRun' : 'dog', d.x, d.y, d.ang, 1, 1, Math.floor(clock * (d.chasing ? 14 : 8)) % 4, 'idle', clock * (d.chasing ? 1.4 : 1));
      if (d.notice > 0) drawArt(g, 'notice', d.x, d.y - 40, 0, 1, 1, 0, 'idle', 0);
    }
    for (let i = 0; i < D.people.length; i++) { const p = D.people[i]; if (p.on && p.y <= tt.y) drawArt(g, i & 1 ? 'person2' : 'person', p.x, p.y, 0, 1, 1, Math.floor(clock * 6) % 4, 'idle', clock); }
    drawArt(g, 'babyTurtle', tt.x, tt.y, tt.angle, 1, 1, Math.floor(D.walk * 8) % 4, 'idle', D.walk);
    for (let i = 0; i < D.people.length; i++) { const p = D.people[i]; if (p.on && p.y > tt.y) drawArt(g, i & 1 ? 'person2' : 'person', p.x, p.y, 0, 1, 1, Math.floor(clock * 6) % 4, 'idle', clock); }
    for (const gl of D.gulls) { // gulls in the air, above everything
      if (!gl.on || (gl.st !== 3 && gl.st !== 4)) continue;
      const u = gl.u, dive = DC.gullDive;
      // swoop: from up-left of the target down onto it; leave: on past it, up to the right
      const x = gl.st === 3 ? gl.tx - 300 * (1 - u) : gl.tx + 300 * u, y = gl.st === 3 ? gl.ty - dive * (1 - u) : gl.ty - dive * u;
      const ang = gl.st === 3 ? Math.atan2(dive, 300) : Math.atan2(-dive, 300);
      g.globalAlpha = gl.st === 4 ? 1 - u * 0.5 : 1;
      drawArt(g, 'seagull', x, y, ang, 1, 1, Math.floor(clock * 10) % 6, gl.st === 3 ? 'attack' : 'fly', clock);
      g.globalAlpha = 1;
    }
    g.restore();
  }

  // ===============================================================================================================
  // Survival
  // ===============================================================================================================
  const SC = CONFIG.survival;
  let survApi = null, weightKeys = null, weightSum = 0;

  function startSurvival() {
    const m = window.TurtleGame && api();
    if (!m || !window.Enemies) return;
    setOverlay(null);
    view = 'survival'; phase = 'play';
    const cap = isMobile() ? SC.maxEnemiesMobile : SC.maxEnemies;
    S = { elapsed: 0, hit: false, paid: 0, lastSec: -1, lastCount: -1, bestAtStart: P().state.minigames.survivalBest, cap,
      detectStep: -1, speedStep: -1, spawnTimer: SC.startGraceSeconds, pendN: 0,
      px: new Float32Array(SC.spawn.maxPending), py: new Float32Array(SC.spawn.maxPending), pt: new Float32Array(SC.spawn.maxPending),
      pk: new Array(SC.spawn.maxPending).fill(''), pon: new Uint8Array(SC.spawn.maxPending), clock: 0 };
    m.enter();
    // Start on the mainland (not the home island) so land enemies can reach the turtle.
    const tt = m.turtle, C = m.center;
    let placed = false;
    for (let i = 0; i < 60 && !placed; i++) {
      const a = Math.random() * 6.283, r = m.waterOuterR + rand(SC.startRing[0], SC.startRing[1]), x = C.x + Math.cos(a) * r, y = C.y + Math.sin(a) * r;
      if (m.walkable(x, y) && !m.blockedAt(x, y, 60)) { tt.x = x; tt.y = y; placed = true; }
    }
    if (!placed) { tt.x = C.x; tt.y = C.y - m.waterOuterR - 300; }
    tt.vx = tt.vy = 0; tt.angle = Math.random() * 6.283;
    m.ensureGroundAt(tt.x, tt.y);
    if (!weightKeys) { weightKeys = Object.keys(SC.weights); weightSum = weightKeys.reduce((s, k) => s + SC.weights[k], 0); }
    survApi = {
      turtle: tt, worldSize: m.worldSize, center: C, worldMin: m.worldMin(), worldMax: m.worldMax(), inHomeZone: m.inHomeZone,
      walkable: m.walkable, flyable: m.flyable, blockedAt: m.blockedAt, isHomeIsland: () => false, inSandText: () => false, // no safe zones
      biomeAt: () => '', view: m.view, turtleAlive: () => !S.hit, isNight: () => false, basePlayerSpeed: m.basePlayerSpeed,
      takeHit: () => { if (S) S.hit = true; return true; }, // one hit ends the run (no hearts)
    };
    window.Enemies.arena.start(survApi, cap, SC.maxSpeedFrac);
    buildHud('0:00', true);
    setText(hudB, '0 enemies');
    updateSurvivalDifficulty();
    // the spawner fills the first few slots one telegraph at a time
  }
  function releaseSurvival() {
    if (window.Enemies) window.Enemies.arena.stop();
    survApi = null; S = null;
  }

  function coinsFor(sec) {
    const C = SC.coins;
    let n = Math.floor(sec / C.perSeconds) * C.perChunk;
    for (const [at, bonus] of C.milestones) if (sec >= at) n += bonus;
    return n;
  }
  function updateSurvivalDifficulty() {
    const e = S.elapsed, ds = Math.floor(e / SC.detectEverySeconds), ss = Math.floor(e / SC.speedEverySeconds);
    if (ds === S.detectStep && ss === S.speedStep) return;
    S.detectStep = ds; S.speedStep = ss;
    window.Enemies.arena.setDifficulty(Math.min(SC.detectBonusMax, ds * SC.detectBonusPx), Math.min(SC.speedMax, 1 + ss * SC.speedStep));
  }

  function updateSurvival(dt) {
    if (phase !== 'play') return;
    const m = api(), tt = m.turtle, E = window.Enemies;
    S.elapsed += dt; S.clock += dt;
    m.move(dt, 1, true);
    m.collide();
    E.update(dt);
    if (S.hit) { finishRun(true); return; }
    updateSurvivalDifficulty();
    // spawner + telegraphs
    for (let i = 0; i < S.pon.length; i++) {
      if (!S.pon[i]) continue;
      S.pt[i] -= dt;
      if (S.pt[i] <= 0) {
        S.pon[i] = 0; S.pendN--;
        const dx = S.px[i] - tt.x, dy = S.py[i] - tt.y;
        if (dx * dx + dy * dy >= (SC.spawn.minPlayerDist * 0.8) ** 2) E.arena.spawn(S.pk[i], S.px[i], S.py[i]); // skipped if the turtle walked up to the spot meanwhile
      }
    }
    S.spawnTimer -= dt;
    if (S.spawnTimer <= 0) {
      S.spawnTimer = SC.spawn.tickSeconds;
      const v = m.view(), far = SC.spawn.recycleScreens * Math.max(v.w, v.h);
      E.arena.recycleFar(tt.x, tt.y, far * far); // frees enemies the turtle left far behind
      const target = Math.min(S.cap, SC.startEnemies + Math.floor(S.elapsed / SC.addEverySeconds));
      if (E.arena.count() + S.pendN < target && S.pendN < SC.spawn.maxPending) pickSpawn(m, v);
    }
    // HUD + coins, only when something changed
    const sec = Math.floor(S.elapsed);
    if (sec !== S.lastSec) {
      S.lastSec = sec; setText(hudA, fmtTime(S.elapsed));
      const due = coinsFor(sec) - S.paid;
      if (due > 0) { P().grantBankedCoins(due); S.paid += due; sfxCoin(); P().setMinigameBest('survivalBest', S.elapsed); }
    }
    const cnt = E.arena.count();
    if (cnt !== S.lastCount) { S.lastCount = cnt; setText(hudB, cnt + (cnt === 1 ? ' enemy' : ' enemies')); }
  }
  // Picks a point just outside the camera view (not near the turtle) and starts its warning marker.
  function pickSpawn(m, v) {
    const sp = SC.spawn, tt = m.turtle;
    let key = weightKeys[0], r = Math.random() * weightSum;
    for (const k of weightKeys) { r -= SC.weights[k]; if (r <= 0) { key = k; break; } }
    for (let i = 0; i < sp.attempts; i++) {
      const mg = rand(sp.marginMin, sp.marginMax), u = Math.random(), side = (Math.random() * 4) | 0;
      const x = side === 0 ? v.x - mg : side === 1 ? v.x + v.w + mg : v.x - mg + u * (v.w + 2 * mg);
      const y = side === 2 ? v.y - mg : side === 3 ? v.y + v.h + mg : v.y - mg + u * (v.h + 2 * mg);
      const dx = x - tt.x, dy = y - tt.y;
      if (dx * dx + dy * dy < sp.minPlayerDist * sp.minPlayerDist) continue;
      if (key === 'seagull' ? !m.flyable(x, y) : (!m.walkable(x, y) || m.blockedAt(x, y, 34))) continue;
      for (let s = 0; s < S.pon.length; s++) if (!S.pon[s]) { S.pon[s] = 1; S.px[s] = x; S.py[s] = y; S.pt[s] = sp.telegraphSeconds; S.pk[s] = key; S.pendN++; return; }
    }
  }

  // Spawn warnings: a pulsing marker pinned to the screen edge, pointing at where the enemy will appear (game.js calls this inside the world transform).
  function drawWorld(g, camX, camY, vw, vh) {
    if (!S) return;
    for (let i = 0; i < S.pon.length; i++) {
      if (!S.pon[i]) continue;
      const m = 40, x = clamp(S.px[i], camX + m, camX + vw - m), y = clamp(S.py[i], camY + m, camY + vh - m);
      const k = 1 + 0.25 * Math.sin(S.clock * 14), a = 0.55 + 0.4 * Math.sin(S.clock * 14);
      g.fillStyle = `rgba(230,60,50,${a})`; g.beginPath(); g.arc(x, y, 20 * k, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 24px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('!', x, y + 1);
    }
  }

  window.MiniGames = { open, close, escape, mode, update, renderDash, drawWorld, CONFIG, ASSETS };
})();
