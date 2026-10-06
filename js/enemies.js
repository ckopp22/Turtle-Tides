// enemies.js — enemy config, spawning, and per-enemy state machine. Kept separate from game.js like
// progression.js: game.js hands over a small world API via Enemies.init(), then calls update()/
// collectVisible()/drawDebug() each frame. Every tunable number lives in CONFIG below.
// Each enemy type is one CONFIG.types entry; special behavior hangs off flags (burrowTime, sleepChance, straightLine, flies).
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const DEBUG = params.get('debug') === '1';

  const U = 64; // world px per "sprite width"; every distance in CONFIG.types is in these units
  const CONFIG = {
    drawSize: 64,            // world px an enemy sprite is drawn at (turtle is 100 tall)
    maxTotal: 12,            // hard cap on live enemies
    graceSeconds: 8,         // no enemies spawn for this long after the game starts
    respawnSeconds: 20,      // delay before a removed enemy's slot spawns a new one
    minCenterFrac: 0.3,      // spawn at least this fraction of the map radius away from the world center
    spawnMinScreens: 1.5,    // spawn at least this many screen widths (of the larger screen side) from the turtle
    activeScreens: 2.5,      // enemies farther than this many screen widths from the turtle are frozen
    spawnAttemptsPerFrame: 6,
    spawnRetrySeconds: 0.25, // wait this long after a failed spawn batch
    wanderSpeedMult: 0.5,    // wander/return speed as a fraction of chase speed
    wanderRadius: 3,         // sprite widths: how far a wander target can be from the enemy
    leash: 6,                // sprite widths: wander targets stay within this of the spawn point
    pauseMin: 1.5, pauseMax: 4, // seconds idling between wander moves
    loseInterestDist: 7,     // sprite widths: farther than this from the turtle starts the give-up timer
    loseInterestSeconds: 3,  // ...and this long beyond it ends the chase
    unreachableSeconds: 3,   // land enemies give up after the turtle spends this long where they can't follow
    stuckSeconds: 2,         // give up after being blocked this long while chasing
    giveUpCooldown: 4,       // seconds after giving up before the enemy can notice the turtle again
    hitRangeSlack: 1.2,      // the hit lands if the turtle is within attackRange * this at the hit frame
    animFps: 8,
    separation: 0.8,         // sprite widths: enemies push apart when closer than this, so a pack doesn't stack into one
    flankRadius: 70,         // world px: chasers aim at a personal spot this far around the turtle until they get close
    farScreens: 1,           // enemies farther than this many screen widths update at a lower rate (off-screen anyway)
    farTickSeconds: 0.1,     // ...once per this long, with the accumulated dt so they move at the same speed
    debugSpawnOffset: 150,   // world px: ?debug=1 spawn key puts the enemy this far from the turtle
    cutLeadSeconds: 1.1,     // cut-off wolves aim this many seconds ahead of the turtle's velocity...
    cutMinAhead: 150,        // ...but at least this many world px ahead
    cutSpread: 130,          // world px: how far the flankers sit to either side of the lead spot
    spawnTickSeconds: 0.2,   // the spawner runs at most this often
    spawnsPerTick: 6,        // ...and places at most this many enemies per run (a big zone pool fills in over a few seconds)
    spawnFailsPerTick: 3,    // ...and gives up for spawnRetrySeconds after this many failed slots in one run
    types: {
      crab: {
        sheet: 'assets/enemies/crab_spritesheet.png',
        biome: 'beach', count: 3,
        speed: 0.55,         // x player's base land speed
        detect: 3, ambush: 1.8, attackRange: 0.9, // sprite widths
        damage: 1, windup: 0.36, attackTime: 0.72, cooldown: 1.2, // seconds; hit lands at `windup`
        bodyRadius: 18,      // world px, for obstacle collision
        flipsSideways: true,
        lunge: 12,           // world px the crab lunges toward the turtle around the pinch's hit frame
        burrowChance: 0.5, burrowTime: 0.6, hiddenMin: 3, hiddenMax: 7, // seconds
        rows: { idle: 0, walk: 1, attack: 2, burrow: 3 },
        debugKey: '5',
      },
      bear: {
        sheet: 'assets/enemies/bear_spritesheet.png',
        biome: 'forestThick', count: 3,
        speed: 0.45, detect: 4.5, attackRange: 1.1,
        damage: 2, windup: 0.6, attackTime: 0.9, cooldown: 2, // long recovery: stands still this long after a swipe
        bodyRadius: 24,
        sleepChance: 0.35, sleepMin: 5, sleepMax: 12, // seconds asleep
        sleepDetectMult: 0.5, // a sleeping bear's detection radius is this fraction of normal
        wakeTime: 1,          // seconds to wake up before it starts chasing
        rows: { idle: 0, walk: 1, attack: 2, sleep: 3 },
        debugKey: '6',
      },
      snake: {
        sheet: 'assets/enemies/snake_spritesheet.png',
        biome: 'deadTrees', count: 3,
        speed: 1.15,         // faster than the player's base land speed
        detect: 4, attackRange: 0.8,
        damage: 1, windup: 0.25, attackTime: 0.5, cooldown: 1,
        bodyRadius: 14,
        straightLine: true,  // chase = straight line at the turtle, no steering; being blocked stuns it
        stunTime: 1,         // seconds
        dodgeChance: 0.5,    // chance, per obstacle it runs at, that it steers around it instead of getting stunned
        rows: { idle: 0, walk: 1, attack: 2, sleep: 3 }, // walk = slither, attack = strike, sleep = coil_sleep
        debugKey: '7',
      },
      seagull: {
        sheet: 'assets/enemies/seagull_spritesheet.png',
        biome: 'forestOpen', count: 3,
        speed: 0.85,
        detect: 9, attackRange: 0.9, // detection is about 2x the others
        damage: 1, windup: 0.35, attackTime: 0.7, cooldown: 1.5,
        bodyRadius: 14,
        flies: true,         // chase/return flight ignores water and obstacles (never enters the home island)
        rows: { idle: 0, walk: 1, attack: 2, fly: 3 }, // attack = peck
        debugKey: '8',
      },
      wolf: {
        sheet: 'assets/enemies/wolf_spritesheet.png',
        biomes: ['forestOpen', 'deadTrees', 'forestThick', 'beach'], count: 6, advCount: 32, // slots cycle through the biomes, so every biome gets a pack
        cutOff: true,        // pack tactic: chasing wolves run ahead of the turtle's heading, each to a different spot, to cut it off
        nocturnal: true,     // only exists at night; the day/night toggle removes it, and it ignores the live-enemy caps
        speed: 1.3, detect: 6, attackRange: 1, // faster than the turtle: it can run around it, but only bites from in front / beside (see CHASE)
        damage: 1, windup: 0.35, attackTime: 0.7, cooldown: 1.4,
        bodyRadius: 20,
        rows: { idle: 0, walk: 1, attack: 2, sleep: 3 }, // howl on notice (TT_SOUND.enemy), bark on attack (TT_SOUND.enemyAttack)
        debugKey: '9',
      },
    },
  };

  // Convert the sprite-width distances to squared world px once, so per-frame checks are just d2 < x2.
  const sq = v => (v * U) * (v * U);
  function derive(c) {
    c.detect2 = sq(c.detect); c.attack2 = sq(c.attackRange); c.hit2 = sq(c.attackRange * CONFIG.hitRangeSlack);
    c.ambush2 = c.ambush ? sq(c.ambush) : 0;
    c.sleepDetect2 = c.sleepChance ? c.detect2 * c.sleepDetectMult * c.sleepDetectMult : 0;
  }
  for (const k in CONFIG.types) derive(CONFIG.types[k]);
  // Adventure Zone variants (numbers come from game.js's ADVENTURE.enemies via init): a little faster, wider detection,
  // shorter attack cooldown; damage and everything else stay the same. The player-is-faster rule is enforced here:
  // any type slower than the player (speed < 1) is clamped below maxSpeedFrac, so only the snake can ever outrun the turtle.
  const ADV_TYPES = {};
  function buildAdventureTypes(m) {
    for (const k in CONFIG.types) {
      const base = CONFIG.types[k], c = Object.assign({}, base);
      c.speed = base.speed < 1 ? Math.min(base.speed * m.speedMult, m.maxSpeedFrac) : base.speed * m.speedMult;
      c.detect = base.detect * m.detectMult;
      if (base.ambush) c.ambush = base.ambush * m.detectMult;
      c.cooldown = base.cooldown * m.cooldownMult;
      derive(c);
      ADV_TYPES[k] = c;
    }
  }
  const LOSE2 = sq(CONFIG.loseInterestDist), LEASH2 = sq(CONFIG.leash);

  const WANDER = 'wander', BURROW = 'burrow', HIDDEN = 'hidden', EMERGE = 'emerge',
    CHASE = 'chase', ATTACK = 'attack', RETURN = 'return', SLEEP = 'sleep', WAKE = 'wake', STUN = 'stun';
  const FRAMES = 6;

  let api = null;
  let now = 0, nextSpawnTry = 0, playerSpeed = 160;
let adv = null, advOn = false; // adv = ADVENTURE.enemies config from game.js; advOn = zone unlocked
  const sheets = {};
  const pool = []; // fixed-size: one slot per configured enemy (home pool, then the Adventure Zone pool), plus a few extra for debug spawns
  const nearList = []; // enemies close enough to simulate this frame (rebuilt each update, reused)
  let ctxRef = null;

  // Turtle velocity (smoothed), measured from its position each update; the pack uses it to predict where it's heading.
  let tvx = 0, tvy = 0, lastTx = null, lastTy = 0;
  function trackTurtle(dt) {
    const T = api.turtle;
    if (lastTx !== null && dt > 0) {
      const vx = (T.x - lastTx) / dt, vy = (T.y - lastTy) / dt;
      if (vx * vx + vy * vy > 1e6 * 4) { tvx = tvy = 0; } // teleport (respawn / hut): reset
      else { const k = Math.min(1, dt * 6); tvx += (vx - tvx) * k; tvy += (vy - tvy) * k; }
    }
    lastTx = T.x; lastTy = T.y;
  }
  // Each chasing cut-off wolf gets a role: 0 = straight ahead of the turtle, 1/2 = ahead to the left/right, then behind.
  function assignRoles() {
    let n = 0;
    for (const e of pool) if (e.active && e.state === CHASE && e.cfg.cutOff) e.role = n++;
    return n;
  }
  // Returns true and sets out.x/out.y to this wolf's intercept spot, or false when the turtle is (nearly) still.
  const cutAim = { x: 0, y: 0 };
  function cutOffAim(e) {
    const T = api.turtle, sp = Math.hypot(tvx, tvy);
    if (sp < 25) return false; // not moving: just surround it (the normal flank)
    const ux = tvx / sp, uy = tvy / sp, px = -uy, py = ux;
    const ahead = Math.max(CONFIG.cutMinAhead, sp * CONFIG.cutLeadSeconds);
    const side = [0, 1, -1, 0.5, -0.5][e.role % 5] * CONFIG.cutSpread;
    const back = e.role >= 3 ? -ahead * 1.5 : 0; // extra wolves close in from behind
    const ax = T.x + ux * (ahead + back) + px * side, ay = T.y + uy * (ahead + back) + py * side;
    if (!api.walkable(ax, ay) || api.blockedAt(ax, ay, e.cfg.bodyRadius)) return false; // spot unusable: fall back to the flank
    cutAim.x = ax; cutAim.y = ay; return true;
  }

  const rnd = (a, b) => a + Math.random() * (b - a);

  function makeSlot(type, respawnAt) {
    const e = {
      type, cfg: type ? CONFIG.types[type] : null, active: false, respawnAt, debug: false, pool: 'home',
      x: 0, y: 0, sx: 0, sy: 0, biome: '', state: WANDER, t: 0, anim: 0, row: 0, frame: 0,
      tx: 0, ty: 0, hasTarget: false, pause: 0, flip: 1, angle: 0, cd: 0, giveUp: 0, steer: 0, steerT: 0, dodge: 0, dodgeT: 0, flank: 0, atkAngle: 0, acc: 0,
      role: 0, lose: 0, stuck: 0, unreach: 0, nightSleep: false, want: '', path: null, pi: 0, pathLen: 0, replans: 0, hiddenFor: 0, emergeToChase: false, hitDone: false,
      proxy: null,
    };
    // Depth-sort entry: game.js's scenery sort wants {x, y (ground contact), type:'custom', draw}.
    e.proxy = { x: 0, y: 0, type: 'custom', draw: () => drawEnemy(e) };
    return e;
  }

  function init(a) {
    api = a;
    playerSpeed = api.basePlayerSpeed;
    for (const k in CONFIG.types) {
      const img = new Image(); img.src = CONFIG.types[k].sheet; sheets[k] = img;
      for (let i = 0; i < CONFIG.types[k].count && (CONFIG.types[k].nocturnal || countPool('home') < CONFIG.maxTotal); i++) { const e = makeSlot(k, CONFIG.graceSeconds); e.want = pickBiome(k, i); pool.push(e); }
    }
    adv = a.adventure || null;
    if (adv) { // Adventure Zone pool: idle (never spawns, never simulated) until game.js calls setAdventure(true)
      buildAdventureTypes(adv);
      for (const k in CONFIG.types) for (let i = 0; i < (CONFIG.types[k].advCount || adv.countPerType) && (CONFIG.types[k].nocturnal || countPool('adv') < adv.maxTotal); i++) { const e = makeSlot(k, Infinity); e.pool = 'adv'; e.want = pickBiome(k, i); pool.push(e); }
    }
    if (DEBUG) for (let i = 0; i < 4; i++) pool.push(makeSlot(null, 0));
    nearList.length = pool.length;
  }
  const pickBiome = (k, i) => { const c = CONFIG.types[k]; return c.biomes ? c.biomes[i % c.biomes.length] : c.biome; }; // slot i's home biome
  function countPool(which) { let n = 0; for (const e of pool) if (e.pool === which) n++; return n; }
  // The zone opens (first spawns after the usual grace period) or closes (everything in it is removed, nothing simulated).
  function setAdventure(on) {
    if (!adv || on === advOn) return;
    advOn = on;
    for (const e of pool) {
      if (e.pool !== 'adv') continue;
      if (on) e.respawnAt = now + CONFIG.graceSeconds;
      else { e.active = false; e.respawnAt = Infinity; }
    }
  }

  // ---- Spawning ----
  function placeEnemy(e, type, x, y, biome) {
    e.type = type; e.active = true;
    e.cfg = adv && !api.inHomeZone(x, y) ? ADV_TYPES[type] : CONFIG.types[type]; // stats follow where it spawned
    e.x = e.sx = x; e.y = e.sy = y; e.biome = biome;
    e.state = WANDER; e.t = 0; e.anim = 0; e.hasTarget = false; e.pause = rnd(0.5, 2); e.nightSleep = false;
    e.cd = 0; e.steer = 0; e.steerT = 0; e.dodge = 0; e.dodgeT = 0; e.giveUp = 0; e.lose = 0; e.stuck = 0; e.unreach = 0; e.flip = Math.random() < 0.5 ? 1 : -1;
  }

  function trySpawn(e) {
    const c = e.cfg, v = api.view();
    const minTurtle = CONFIG.spawnMinScreens * Math.max(v.w, v.h), minTurtle2 = minTurtle * minTurtle;
    const mapR = api.worldSize / 2, minC2 = (CONFIG.minCenterFrac * mapR) ** 2;
    const T = api.turtle;
    const zone = e.pool === 'adv', span = api.worldMax - api.worldMin;
    for (let i = 0; i < CONFIG.spawnAttemptsPerFrame; i++) {
      const x = zone ? api.worldMin + Math.random() * span : Math.random() * api.worldSize;
      const y = zone ? api.worldMin + Math.random() * span : Math.random() * api.worldSize;
      if (zone && api.inHomeZone(x, y)) continue; // the zone pool only spawns outside the original map
      const cx = x - api.center.x, cy = y - api.center.y;
      if (cx * cx + cy * cy < minC2) continue;
      if (!zone && api.homeSpawnR2 && cx * cx + cy * cy > api.homeSpawnR2) continue; // home spawns keep to the original walkable circle
      const tx = x - T.x, ty = y - T.y;
      if (tx * tx + ty * ty < minTurtle2) continue;
      if (!api.walkable(x, y) || api.inSandText(x, y)) continue;
      const want = e.want || c.biome;
      if (api.biomeAt(x, y) !== want) continue;
      if (api.blockedAt(x, y, c.bodyRadius + 10)) continue;
      placeEnemy(e, e.type, x, y, want);
      return true;
    }
    return false;
  }

  function updateSpawner() {
    if (now < nextSpawnTry) return;
    nextSpawnTry = now + CONFIG.spawnTickSeconds;
    const night = api.isNight();
    let liveHome = 0, liveAdv = 0;
    for (const e of pool) if (e.active && !e.cfg.nocturnal) { if (e.pool === 'adv') liveAdv++; else liveHome++; }
    let spawned = 0, failed = 0;
    for (const e of pool) {
      if (e.active || !e.type || e.debug || now < e.respawnAt) continue;
      const noct = e.cfg.nocturnal;
      if (noct && !night) continue; // wolves only spawn at night
      if (e.pool === 'adv') { if (!advOn || (!noct && liveAdv >= adv.maxTotal)) continue; }
      else if (!noct && liveHome >= CONFIG.maxTotal) continue;
      if (trySpawn(e)) { if (!noct) { if (e.pool === 'adv') liveAdv++; else liveHome++; } if (++spawned >= CONFIG.spawnsPerTick) return; }
      else if (++failed >= CONFIG.spawnFailsPerTick) { nextSpawnTry = now + CONFIG.spawnRetrySeconds; return; } // a few misses per pass, then wait
    }
  }

  // ---- Movement (land enemies): axis-sliding against water, the island, obstacles, and the world edge ----
  function open(e, x, y, fly) { return fly ? api.flyable(x, y) : api.walkable(x, y) && !api.blockedAt(x, y, e.cfg.bodyRadius); }
  function tryMove(e, mx, my, fly) {
    if (open(e, e.x + mx, e.y + my, fly)) { e.x += mx; e.y += my; return; }
    if (mx !== 0 && open(e, e.x + mx, e.y, fly)) { e.x += mx; return; }
    if (my !== 0 && open(e, e.x, e.y + my, fly)) { e.y += my; }
  }
  // Obstacle avoidance for walkers: look a little ahead along the heading; if that's blocked, try
  // headings rotated further and further to one side (the side it last steered around, so it doesn't
  // flip-flop at a corner) and then the other. Cheap: a handful of open() checks, no allocation.
  // A big concave pocket can still trap it; the caller's stuck timer then makes it give up.
  const STEER_COS = [1, Math.cos(0.5), Math.cos(1.0), Math.cos(1.5), Math.cos(2.0), Math.cos(2.5)];
  const STEER_SIN = [0, Math.sin(0.5), Math.sin(1.0), Math.sin(1.5), Math.sin(2.0), Math.sin(2.5)];
  function clearAhead(e, hx, hy, step, look) {
    return open(e, e.x + hx * step, e.y + hy * step) && open(e, e.x + hx * look, e.y + hy * look);
  }
  // Returns the fraction (0..1) of the intended step actually travelled.
  function steerMove(e, ux, uy, step) {
    const look = e.cfg.bodyRadius * 1.2 + step;
    // While committed to a steer (steerT > 0) skip the direct heading, so it doesn't flip between "blocked" and
    // "clear" every frame at a wall edge (that was the shaking).
    const committed = e.steerT > 0 && e.steer !== 0;
    let hx = ux, hy = uy, found = !committed && clearAhead(e, ux, uy, step, look);
    if (!found) {
      const first = e.steer || (Math.random() < 0.5 ? 1 : -1);
      for (let i = 1; i < STEER_COS.length && !found; i++) {
        for (let k = 0; k < 2 && !found; k++) {
          const sg = k === 0 ? first : -first, c = STEER_COS[i], sn = STEER_SIN[i] * sg;
          hx = ux * c - uy * sn; hy = ux * sn + uy * c;
          if (clearAhead(e, hx, hy, step, look)) { found = true; e.steer = sg; if (!committed) e.steerT = 0.5; }
        }
      }
    }
    if (!found && committed) { e.steerT = 0; return steerMove(e, ux, uy, step); } // nothing clear while committed: re-evaluate fresh
    if (!found) { const ox = e.x, oy = e.y; tryMove(e, ux * step, uy * step); return step > 0 ? Math.hypot(e.x - ox, e.y - oy) / step : 1; }
    e.x += hx * step; e.y += hy * step;
    if (e.cfg.flipsSideways) { if (Math.abs(hx) > 0.2) e.flip = hx > 0 ? 1 : -1; }
    else e.angle = Math.atan2(hy, hx);
    return 1;
  }
  // Steps toward (tx, ty); returns the fraction (0..1) of the intended step that made progress along
  // the heading, so callers can tell "blocked / sliding along a wall" from "moving freely".
  function stepToward(e, tx, ty, speed, dt, fly) {
    const dx = tx - e.x, dy = ty - e.y, dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return 1;
    const step = Math.min(speed * dt, dist), ux = dx / dist, uy = dy / dist;
    if (!fly) return steerMove(e, ux, uy, step);
    const ox = e.x, oy = e.y;
    tryMove(e, ux * step, uy * step, fly);
    if (e.cfg.flipsSideways) { if (Math.abs(ux) > 0.2) e.flip = ux > 0 ? 1 : -1; }
    else e.angle = Math.atan2(uy, ux);
    return step > 0 ? ((e.x - ox) * ux + (e.y - oy) * uy) / step : 1;
  }

  // ---- Return pathing (land enemies): grid A* from the enemy to its spawn, treating water, the home island,
  // obstacles and the world edge as blocked. Runs once when RETURN starts (and again if it gets stuck), so a
  // chaser that ended up behind a tree cluster / lake / the home island walks around instead of grinding on it.
  // Cells are lazily tested (only expanded ones), the grid is capped (~80 cells a side), and a failed search
  // just falls back to the old straight-line steering.
  const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  function lineClear(e, x0, y0, x1, y1) {
    const d = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(d / 12);
    for (let i = 1; i <= n; i++) { const u = i / n; if (!open(e, x0 + (x1 - x0) * u, y0 + (y1 - y0) * u)) return false; }
    return true;
  }
  function planReturn(e) {
    e.path = []; e.pi = 0; e.pathLen = 0;
    const sx = e.sx, sy = e.sy;
    if (lineClear(e, e.x, e.y, sx, sy)) return; // straight shot: no waypoints needed
    const M = 700; // search margin around the two points: must clear the home island (radius ~560) so it can detour around it
    const cs = Math.max(32, Math.ceil((Math.max(Math.abs(sx - e.x), Math.abs(sy - e.y)) + 2 * M) / 80));
    const ox = Math.min(e.x, sx) - M, oy = Math.min(e.y, sy) - M;
    const w = Math.ceil((Math.abs(sx - e.x) + 2 * M) / cs) + 1, h = Math.ceil((Math.abs(sy - e.y) + 2 * M) / cs) + 1;
    const cell = (x, y) => Math.max(0, Math.min(h - 1, Math.floor((y - oy) / cs))) * w + Math.max(0, Math.min(w - 1, Math.floor((x - ox) / cs)));
    const N = w * h, start = cell(e.x, e.y), goal = cell(sx, sy);
    const g = new Float32Array(N).fill(Infinity), par = new Int32Array(N).fill(-1), blk = new Uint8Array(N), done = new Uint8Array(N);
    const isOpen = k => { // 0 unknown, 1 open, 2 blocked
      if (blk[k] === 0) blk[k] = (k === start || k === goal || open(e, ox + ((k % w) + 0.5) * cs, oy + (Math.floor(k / w) + 0.5) * cs)) ? 1 : 2;
      return blk[k] === 1;
    };
    const gx = goal % w, gy = (goal - gx) / w;
    const hf = k => { const dx = Math.abs(k % w - gx), dy = Math.abs(Math.floor(k / w) - gy); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    const hk = [], hv = []; // binary min-heap of (f, cell); stale entries skipped via `done`
    const push = (f, k) => {
      let i = hk.length; hk.push(f); hv.push(k);
      while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= f) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; }
      hk[i] = f; hv[i] = k;
    };
    const pop = () => {
      const k = hv[0], lf = hk.pop(), lv = hv.pop(), n = hk.length;
      if (n > 0) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1; if (c >= n) break;
          if (c + 1 < n && hk[c + 1] < hk[c]) c++;
          if (hk[c] >= lf) break;
          hk[i] = hk[c]; hv[i] = hv[c]; i = c;
        }
        hk[i] = lf; hv[i] = lv;
      }
      return k;
    };
    g[start] = 0; push(hf(start), start);
    let found = false;
    while (hk.length) {
      const k = pop();
      if (done[k]) continue;
      done[k] = 1;
      if (k === goal) { found = true; break; }
      const ci = k % w, cj = (k - ci) / w;
      for (const [di, dj, cost] of NB) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const nk = nj * w + ni;
        if (done[nk] || !isOpen(nk)) continue;
        if (di !== 0 && dj !== 0 && (!isOpen(cj * w + ni) || !isOpen(nj * w + ci))) continue; // no corner cutting
        const ng = g[k] + cost;
        if (ng < g[nk]) { g[nk] = ng; par[nk] = k; push(ng + hf(nk), nk); }
      }
    }
    if (!found) return; // no route: fall back to plain steering
    const pts = [];
    for (let k = goal; k !== -1 && k !== start; k = par[k]) pts.push(ox + ((k % w) + 0.5) * cs, oy + (Math.floor(k / w) + 0.5) * cs);
    // pts is goal -> start as flat x,y pairs; reverse into start -> goal, dropping collinear points and ending on the exact spawn.
    const path = [];
    let dx0 = 0, dy0 = 0, px = e.x, py = e.y;
    for (let i = pts.length - 2; i >= 0; i -= 2) {
      const x = pts[i], y = pts[i + 1], dx = Math.sign(x - px), dy = Math.sign(y - py);
      if (i > 0 && dx === dx0 && dy === dy0 && path.length) path[path.length - 2] = x, path[path.length - 1] = y;
      else path.push(x, y);
      dx0 = dx; dy0 = dy; px = x; py = y;
    }
    path.push(sx, sy);
    e.path = path; e.pathLen = g[goal] * cs;
  }

  function setState(e, s) { e.state = s; e.t = 0; e.anim = 0; if (s === RETURN) { e.path = null; e.replans = 0; } }

  function pickWanderTarget(e) {
    const c = e.cfg;
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2, d = rnd(0.5, 1) * CONFIG.wanderRadius * U;
      const x = e.x + Math.cos(a) * d, y = e.y + Math.sin(a) * d;
      const lx = x - e.sx, ly = y - e.sy;
      if (lx * lx + ly * ly > LEASH2) continue;
      if (!api.walkable(x, y) || api.blockedAt(x, y, c.bodyRadius)) continue;
      if (api.biomeAt(x, y) !== e.biome) continue; // stay in the home biome (checked per pick, not per frame)
      e.tx = x; e.ty = y; e.hasTarget = true;
      return true;
    }
    return false;
  }

  function face(e, dx, dy) {
    if (e.cfg.flipsSideways) { if (Math.abs(dx) > 1) e.flip = dx > 0 ? 1 : -1; }
    else e.angle = Math.atan2(dy, dx);
  }
  // Shared by CHASE and STUN: gives up on the turtle's safe-zone / too-far / unreachable conditions.
  function chaseChecks(e, dt, d2, safe, alive) {
    if (!alive || safe) { giveUpChase(e); return true; }
    if (d2 > LOSE2) { e.lose += dt; if (e.lose > CONFIG.loseInterestSeconds) { giveUpChase(e); return true; } }
    else e.lose = 0;
    // Land enemies can't follow into water: stop at the shore and lose interest after a few seconds.
    if (!e.cfg.flies && !api.walkable(api.turtle.x, api.turtle.y)) { e.unreach += dt; if (e.unreach > CONFIG.unreachableSeconds) { giveUpChase(e); return true; } }
    else e.unreach = 0;
    return false;
  }
  function startChase(e) {
    if (window.TT_SOUND && window.TT_SOUND.enemy) window.TT_SOUND.enemy(e.type, Math.hypot(api.turtle.x - e.x, api.turtle.y - e.y)); // its cry, quieter when far
    e.flank = Math.random() * Math.PI * 2; e.lose = 0; e.stuck = 0; e.unreach = 0; e.hasTarget = false; setState(e, CHASE); }
  function giveUpChase(e) {
    e.giveUp = CONFIG.giveUpCooldown; e.lose = 0; e.stuck = 0; e.unreach = 0;
    setState(e, RETURN); // walks back to its spawn point; crabs burrow once they arrive
  }

  function setAnim(e, row, fps, frames) {
    e.row = row; e.frame = Math.floor(e.anim * fps) % frames;
  }

  function tick(e, dt, safe, alive) {
    const c = e.cfg, T = api.turtle, R = c.rows;
    e.t += dt; e.anim += dt;
    if (e.giveUp > 0) e.giveUp -= dt;
    if (e.cd > 0) e.cd -= dt;
    if (e.steerT > 0) e.steerT -= dt;
    if (e.dodgeT > 0) e.dodgeT -= dt;
    const dx = T.x - e.x, dy = T.y - e.y, d2 = dx * dx + dy * dy;
    // Enemies ignore the turtle on the home island (safe zone), while it's dying, and right after giving up.
    const canSee = alive && !safe && e.giveUp <= 0;
    // Night: every animal but the wolf is asleep (burrowed crab) and never notices the turtle; at dawn they wake normally.
    if (!c.nocturnal) {
      if (api.isNight()) {
        if (!e.nightSleep) {
          e.nightSleep = true; e.emergeToChase = false; e.hiddenFor = Infinity;
          if (c.burrowTime) { if (e.state !== HIDDEN && e.state !== BURROW) setState(e, BURROW); } else setState(e, SLEEP);
        }
      } else if (e.nightSleep) { e.nightSleep = false; e.hiddenFor = 0; }
    }
    const chaseSpeed = c.speed * playerSpeed, wanderSpeed = chaseSpeed * CONFIG.wanderSpeedMult;

    switch (e.state) {
      case WANDER: case RETURN: {
        if (canSee && d2 < c.detect2) { startChase(e); return; }
        if (e.state === RETURN) {
          // Land enemies follow an A* path around obstacles / water / the home island (see planReturn).
          let tx = e.sx, ty = e.sy;
          if (!c.flies) {
            if (!e.path) planReturn(e);
            if (e.pi < e.path.length) {
              tx = e.path[e.pi]; ty = e.path[e.pi + 1];
              if (e.pi < e.path.length - 2 && (tx - e.x) ** 2 + (ty - e.y) ** 2 < 20 * 20) { e.pi += 2; tx = e.path[e.pi]; ty = e.path[e.pi + 1]; }
            }
          }
          const progress = stepToward(e, tx, ty, wanderSpeed, dt, c.flies);
          e.stuck = progress < 0.3 ? e.stuck + dt : 0;
          if (!c.flies && e.stuck > 0.7 && e.replans < 3) { e.replans++; e.stuck = 0; e.path = null; } // re-plan from here
          const rx = e.sx - e.x, ry = e.sy - e.y;
          setAnim(e, c.flies ? R.fly : R.walk, CONFIG.animFps, FRAMES);
          const timeout = e.pathLen ? e.pathLen / wanderSpeed * 2 + 5 : 20;
          if (rx * rx + ry * ry < 16 * 16 || e.stuck > 1.5 || e.t > timeout) {
            if (c.burrowTime) setState(e, BURROW); else { setState(e, WANDER); e.pause = rnd(CONFIG.pauseMin, CONFIG.pauseMax); }
          }
          return;
        }
        if (!e.hasTarget) {
          setAnim(e, R.idle, 5, FRAMES);
          e.pause -= dt;
          if (e.pause <= 0) {
            if (c.burrowTime && Math.random() < c.burrowChance) { setState(e, BURROW); return; }
            if (c.sleepChance && Math.random() < c.sleepChance) { e.hiddenFor = rnd(c.sleepMin, c.sleepMax); setState(e, SLEEP); return; }
            if (!pickWanderTarget(e)) e.pause = rnd(CONFIG.pauseMin, CONFIG.pauseMax);
          }
        } else {
          const progress = stepToward(e, e.tx, e.ty, wanderSpeed, dt);
          e.stuck = progress < 0.3 ? e.stuck + dt : 0;
          setAnim(e, R.walk, CONFIG.animFps, FRAMES);
          const rx = e.tx - e.x, ry = e.ty - e.y;
          if (rx * rx + ry * ry < 12 * 12 || e.stuck > 0.6) {
            e.hasTarget = false; e.stuck = 0; e.pause = rnd(CONFIG.pauseMin, CONFIG.pauseMax);
          }
        }
        return;
      }
      case BURROW: { // crab: sink into the sand (burrow row forward), then stay hidden
        e.row = R.burrow; e.frame = Math.min(FRAMES - 1, Math.floor(e.t / c.burrowTime * FRAMES));
        if (e.t >= c.burrowTime) { setState(e, HIDDEN); e.hiddenFor = rnd(c.hiddenMin, c.hiddenMax); }
        return;
      }
      case HIDDEN: { // ambush: only reacts when the turtle gets very close (after the minimum hide time)
        e.row = R.burrow; e.frame = FRAMES - 1; // last burrow frame = just the eyes
        if (canSee && !e.nightSleep && e.t >= c.cooldown && d2 < c.ambush2) { e.emergeToChase = true; setState(e, EMERGE); }
        else if (!e.nightSleep && e.t >= e.hiddenFor) { e.emergeToChase = false; setState(e, EMERGE); } // stays buried all night
        return;
      }
      case EMERGE: { // burrow row in reverse
        e.row = R.burrow; e.frame = Math.max(0, FRAMES - 1 - Math.floor(e.t / c.burrowTime * FRAMES));
        if (e.t >= c.burrowTime) {
          if (e.emergeToChase) startChase(e);
          else { setState(e, WANDER); e.pause = rnd(0.5, 1.5); }
        }
        return;
      }
      case SLEEP: { // bear: lies down; notices the turtle only at a reduced radius, then takes a moment to wake
        e.row = R.sleep !== undefined ? R.sleep : R.idle; e.frame = R.sleep !== undefined ? Math.floor(e.t * 3) % FRAMES : 0; // seagull has no sleep row: stands still
        if (canSee && !e.nightSleep && d2 < c.sleepDetect2) { e.emergeToChase = true; setState(e, WAKE); }
        else if (e.t >= e.hiddenFor) { e.emergeToChase = false; setState(e, WAKE); }
        return;
      }
      case WAKE: {
        if (e.t < c.wakeTime * 0.5 && R.sleep !== undefined) { e.row = R.sleep; e.frame = Math.floor(e.t * 3) % FRAMES; }
        else { e.row = R.idle; e.frame = Math.floor(e.anim * 5) % FRAMES; }
        if (e.t >= (c.wakeTime || 1)) {
          if (e.emergeToChase && canSee) startChase(e);
          else { setState(e, WANDER); e.pause = rnd(0.5, 1.5); }
        }
        return;
      }
      case CHASE: {
        if (chaseChecks(e, dt, d2, safe, alive)) return;
        // Cut-off wolves can't bite from behind a moving turtle: they keep running around it to its front or side first.
        let behind = false;
        if (c.cutOff) {
          const sp = Math.hypot(tvx, tvy);
          if (sp >= 25 && (e.x - T.x) * tvx + (e.y - T.y) * tvy < -0.2 * Math.sqrt(d2) * sp && cutOffAim(e)) behind = true;
        }
        if (d2 <= c.attack2 && !behind) {
          face(e, dx, dy);
          if (e.cd <= 0) { e.hitDone = false; e.atkAngle = Math.atan2(dy, dx); setState(e, ATTACK);
            if (window.TT_SOUND && window.TT_SOUND.enemyAttack) window.TT_SOUND.enemyAttack(e.type, Math.hypot(dx, dy)); // crab: stick snap
            return; }
          setAnim(e, c.flies ? R.fly : R.idle, 5, FRAMES); // in range but recovering from the last swing: hold still
          return;
        }
        if (c.straightLine) {
          // No pathfinding: if the straight step is blocked (obstacle, water, island, world edge) it stuns.
          const dist = Math.sqrt(d2), step = Math.min(chaseSpeed * dt, dist);
          face(e, dx, dy);
          setAnim(e, R.walk, CONFIG.animFps * 1.5, FRAMES);
          if (dist > 1) {
            const nx = e.x + dx / dist * step, ny = e.y + dy / dist * step;
            if (open(e, nx, ny)) { e.x = nx; e.y = ny; if (e.dodgeT <= 0) e.dodge = 0; }
            else {
              // Blocked: roll once per obstacle. A lucky snake steers around it; otherwise it's stunned.
              if (e.dodge === 0) e.dodge = Math.random() < c.dodgeChance ? 1 : -1;
              if (e.dodge === 1 && steerMove(e, dx / dist, dy / dist, step) >= 0.3) e.dodgeT = 0.8;
              else { e.dodge = 0; setState(e, STUN); } // re-rolls after the stun
            }
          }
          return;
        }
        // Far away, aim at this enemy's own spot around the turtle so a pack arrives from different sides;
        // once close, aim straight at the turtle.
        const fr = CONFIG.flankRadius, close = Math.sqrt(c.attack2) + fr + 20;
        let aimX = d2 > close * close ? T.x + Math.cos(e.flank) * fr : T.x;
        let aimY = d2 > close * close ? T.y + Math.sin(e.flank) * fr : T.y;
        if (c.cutOff && (behind || d2 > (Math.sqrt(c.attack2) + 60) ** 2) && cutOffAim(e)) {
          // Head for the intercept spot unless the turtle is already between this wolf and it (then just bite).
          const tdx = cutAim.x - e.x, tdy = cutAim.y - e.y;
          if (tdx * dx + tdy * dy > 0 || tdx * tdx + tdy * tdy > d2) { aimX = cutAim.x; aimY = cutAim.y; } else { aimX = T.x; aimY = T.y; }
        }
        const progress = stepToward(e, aimX, aimY, chaseSpeed, dt, c.flies);
        e.stuck = progress < 0.3 ? e.stuck + dt : Math.max(0, e.stuck - dt);
        if (!c.flies && e.stuck > CONFIG.stuckSeconds) { giveUpChase(e); return; }
        setAnim(e, c.flies ? R.fly : R.walk, CONFIG.animFps * 1.5, FRAMES);
        return;
      }
      case STUN: { // snake: can't move or attack for exactly stunTime, then targets the turtle again
        e.row = R.sleep; e.frame = Math.floor(e.t * 3) % FRAMES;
        if (chaseChecks(e, dt, d2, safe, alive)) return;
        if (e.t >= c.stunTime) setState(e, CHASE);
        return;
      }
      case ATTACK: {
        e.row = R.attack; e.frame = Math.min(FRAMES - 1, Math.floor(e.t / c.attackTime * FRAMES));
        // Wind-up first so the player can see it coming; the hit only lands if still in range at the hit frame.
        if (!e.hitDone && e.t >= c.windup) {
          e.hitDone = true;
          if (alive && !safe && d2 <= c.hit2) api.takeHit(c.damage);
        }
        if (e.t >= c.attackTime) {
          e.cd = c.cooldown;
          if (c.burrowTime) setState(e, BURROW); // crab: burrows again after an attack
          else setState(e, CHASE);
        }
        return;
      }
    }
  }

  function update(dt) {
    if (!api) return;
    now += dt;
    updateSpawner();
    const T = api.turtle, v = api.view();
    const act = CONFIG.activeScreens * Math.max(v.w, v.h), act2 = act * act;
    const far = CONFIG.farScreens * Math.max(v.w, v.h), far2 = far * far;
    const safe = api.isHomeIsland(T.x, T.y), alive = api.turtleAlive();
    const night = api.isNight();
    trackTurtle(dt); assignRoles();
    let nn = 0;
    for (const e of pool) {
      if (!e.active) continue;
      if (e.cfg.nocturnal && !night) { e.active = false; e.respawnAt = now + 2; continue; } // dawn: wolves vanish
      const dx = T.x - e.x, dy = T.y - e.y;
      if (dx * dx + dy * dy > act2) continue; // far away: frozen, costs nothing
      nearList[nn++] = e;
      if (dx * dx + dy * dy > far2) { // far: tick at a low rate with the accumulated dt
        e.acc += dt;
        if (e.acc < CONFIG.farTickSeconds) continue;
        tick(e, e.acc, safe, alive); e.acc = 0;
      } else { tick(e, e.acc + dt, safe, alive); e.acc = 0; }
    }
    nearCount = nn;
    separate();
  }

  // Pushes overlapping enemies apart (only ones above ground together or in the air together, and not
  // burrowed/asleep) so a chasing pack reads as several animals. 12 enemies max: the pair loop is trivial.
  const SEP2 = sq(CONFIG.separation);
  function mobile(e) { return e.state !== HIDDEN && e.state !== BURROW && e.state !== EMERGE && e.state !== SLEEP && e.state !== WAKE; }
  function airborne(e) { return e.cfg.flies && (e.state === CHASE || e.state === ATTACK || e.state === RETURN); }
  let nearCount = 0;
  function separate() { // only the enemies simulated this frame (nearList), so a big far-away population costs nothing here
    const n = nearCount;
    for (let i = 0; i < n; i++) {
      const a = nearList[i];
      if (!a.active || !mobile(a)) continue;
      for (let j = i + 1; j < n; j++) {
        const b = nearList[j];
        if (!b.active || !mobile(b) || airborne(a) !== airborne(b)) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 >= SEP2) continue;
        const d = Math.sqrt(d2) || 0.001, push = (CONFIG.separation * U - d) * 0.5;
        const ux = d2 < 1e-6 ? 1 : dx / d, uy = d2 < 1e-6 ? 0 : dy / d;
        const fa = airborne(a);
        if (open(a, a.x - ux * push, a.y - uy * push, fa)) { a.x -= ux * push; a.y -= uy * push; }
        if (open(b, b.x + ux * push, b.y + uy * push, fa)) { b.x += ux * push; b.y += uy * push; }
      }
    }
  }

  // After the turtle respawns at home, every chasing enemy goes back to wandering.
  function resetAggro() {
    for (const e of pool) {
      if (!e.active) continue;
      if (e.state === CHASE || e.state === ATTACK) { e.giveUp = CONFIG.giveUpCooldown; setState(e, RETURN); }
    }
  }

  // ---- Drawing ----
  function drawEnemy(e) {
    const img = sheets[e.type], g = ctxRef;
    if (!img || !img.complete || !img.naturalWidth) return;
    const F = img.naturalWidth / FRAMES, D = CONFIG.drawSize;
    g.save();
    // (no imageSmoothingEnabled toggle here: flipping it per sprite is a slow path on mobile GPUs)
    const air = e.cfg.flies && (e.state === CHASE || e.state === ATTACK || e.state === RETURN);
    if (air) { // soft ground shadow, sprite lifted above it
      g.globalAlpha = 0.25; g.fillStyle = '#000';
      g.beginPath(); g.ellipse(e.x, e.y + 20, 17, 7, 0, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    }
    const lunge = e.cfg.lunge, atk = lunge && e.state === ATTACK;
    let lx = 0, ly = 0;
    if (atk) { // lunge toward the turtle around the hit frame
      const u = Math.max(0, Math.min(1, (e.t - (e.cfg.windup - 0.12)) / 0.24));
      lx = Math.cos(e.atkAngle) * Math.sin(u * Math.PI) * lunge; ly = Math.sin(e.atkAngle) * Math.sin(u * Math.PI) * lunge;
    }
    g.translate(e.x + lx, (air ? e.y - 10 : e.y) + ly);
    if (e.cfg.flipsSideways) { if (e.flip < 0) g.scale(-1, 1); }
    else g.rotate(Math.round((e.angle + Math.PI / 2) / (Math.PI / 4)) * (Math.PI / 4)); // art faces up; snap to 8 directions
    g.drawImage(img, e.frame * F, e.row * F, F, F, -D / 2, -D / 2, D, D);
    g.restore();
  }

  // Pushes each on-screen enemy's depth-sort proxy into game.js's visible list (reused buffer, no allocation).
  function collectVisible(buf, ctx, camX, camY, vw, vh, margin) {
    ctxRef = ctx;
    const m = margin + CONFIG.drawSize;
    for (const e of pool) {
      if (!e.active) continue;
      if (e.x < camX - m || e.x > camX + vw + m || e.y < camY - m || e.y > camY + vh + m) continue;
      e.proxy.x = e.x; e.proxy.y = e.y + CONFIG.drawSize * 0.3; // sort by roughly where it touches the ground
      if (e.cfg.flies && (e.state === CHASE || e.state === ATTACK || e.state === RETURN)) e.proxy.y += 1e6; // airborne: draws over trees
      buf.push(e.proxy);
    }
  }

  // ?debug=1: detection / attack / ambush radii, leash area, spawn point, and current state.
  function drawDebug(g, camX, camY, vw, vh) {
    if (!DEBUG) return;
    g.save();
    g.lineWidth = 1.5; g.font = '12px monospace'; g.textAlign = 'center';
    const circle = (x, y, r, color) => { g.strokeStyle = color; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); };
    for (const e of pool) {
      if (!e.active) continue;
      if (e.x < camX - 400 || e.x > camX + vw + 400 || e.y < camY - 400 || e.y > camY + vh + 400) continue;
      const c = e.cfg;
      circle(e.x, e.y, Math.sqrt(e.state === SLEEP && c.sleepDetect2 ? c.sleepDetect2 : c.detect2), 'rgba(255,220,0,0.8)');
      circle(e.x, e.y, Math.sqrt(c.attack2), 'rgba(255,60,60,0.9)');
      if (c.ambush2) circle(e.x, e.y, Math.sqrt(c.ambush2), 'rgba(0,220,255,0.8)');
      circle(e.sx, e.sy, Math.sqrt(LEASH2), 'rgba(255,255,255,0.45)');
      g.fillStyle = '#fff'; g.beginPath(); g.arc(e.sx, e.sy, 4, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#000'; g.fillRect(e.x - 40, e.y - 58, 80, 15);
      g.fillStyle = '#fff'; g.fillText(`${e.type} ${e.state}`, e.x, e.y - 47);
    }
    g.restore();
  }

  // ?debug=1: number keys spawn a specific enemy next to the turtle for testing.
  function debugSpawn(type) {
    if (!api) return;
    const c = CONFIG.types[type], T = api.turtle;
    let slot = null;
    for (const e of pool) if (!e.active && (e.debug || !e.type)) { slot = e; break; }
    if (!slot) return;
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4, x = T.x + Math.cos(a) * CONFIG.debugSpawnOffset, y = T.y + Math.sin(a) * CONFIG.debugSpawnOffset;
      if (!api.walkable(x, y) || api.blockedAt(x, y, c.bodyRadius)) continue;
      slot.debug = true; slot.respawnAt = Infinity;
      placeEnemy(slot, type, x, y, api.biomeAt(x, y)); // home biome = wherever it was dropped
      return;
    }
  }
  if (DEBUG) {
    window.addEventListener('keydown', e => {
      if (/^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '')) return;
      for (const k in CONFIG.types) if (CONFIG.types[k].debugKey === e.key) debugSpawn(k);
    });
  }

  // True if (x, y) is within `pad` px of any live enemy's den (its wander/leash area around its spawn point).
  function nearDen(x, y, pad) {
    const r = CONFIG.leash * U + pad, r2 = r * r;
    for (const e of pool) {
      if (!e.active) continue;
      const dx = x - e.sx, dy = y - e.sy;
      if (dx * dx + dy * dy < r2) return true;
    }
    return false;
  }
  const statsBuf = { home: 0, adv: 0, near: 0 };
  function stats() { statsBuf.home = statsBuf.adv = 0; for (const e of pool) if (e.active) { if (e.pool === 'adv') statsBuf.adv++; else statsBuf.home++; } statsBuf.near = nearCount; return statsBuf; } // ?debug=1 overlay
  window.Enemies = { init, update, setAdventure, stats, nearDen, resetAggro, collectVisible, drawDebug, CONFIG, get pool() { return DEBUG ? pool : null; }, get api() { return DEBUG ? api : null; } }; // pool/api only exposed with ?debug=1, for console poking
})();
