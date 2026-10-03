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
    debugSpawnOffset: 150,   // world px: ?debug=1 spawn key puts the enemy this far from the turtle
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
    },
  };

  // Convert the sprite-width distances to squared world px once, so per-frame checks are just d2 < x2.
  const sq = v => (v * U) * (v * U);
  for (const k in CONFIG.types) {
    const c = CONFIG.types[k];
    c.detect2 = sq(c.detect); c.attack2 = sq(c.attackRange); c.hit2 = sq(c.attackRange * CONFIG.hitRangeSlack);
    c.ambush2 = c.ambush ? sq(c.ambush) : 0;
    c.sleepDetect2 = c.sleepChance ? c.detect2 * c.sleepDetectMult * c.sleepDetectMult : 0;
  }
  const LOSE2 = sq(CONFIG.loseInterestDist), LEASH2 = sq(CONFIG.leash);

  const WANDER = 'wander', BURROW = 'burrow', HIDDEN = 'hidden', EMERGE = 'emerge',
    CHASE = 'chase', ATTACK = 'attack', RETURN = 'return', SLEEP = 'sleep', WAKE = 'wake', STUN = 'stun';
  const FRAMES = 6;

  let api = null;
  let now = 0, nextSpawnTry = 0, playerSpeed = 160;
  const sheets = {};
  const pool = []; // fixed-size: one slot per configured enemy, plus a few extra for debug spawns
  let ctxRef = null;

  const rnd = (a, b) => a + Math.random() * (b - a);

  function makeSlot(type, respawnAt) {
    const e = {
      type, cfg: type ? CONFIG.types[type] : null, active: false, respawnAt, debug: false,
      x: 0, y: 0, sx: 0, sy: 0, biome: '', state: WANDER, t: 0, anim: 0, row: 0, frame: 0,
      tx: 0, ty: 0, hasTarget: false, pause: 0, flip: 1, angle: 0, cd: 0, giveUp: 0, steer: 0, steerT: 0, dodge: 0, dodgeT: 0, flank: 0, atkAngle: 0,
      lose: 0, stuck: 0, unreach: 0, hiddenFor: 0, emergeToChase: false, hitDone: false,
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
      for (let i = 0; i < CONFIG.types[k].count && pool.length < CONFIG.maxTotal; i++) pool.push(makeSlot(k, CONFIG.graceSeconds));
    }
    if (DEBUG) for (let i = 0; i < 4; i++) pool.push(makeSlot(null, 0));
  }

  // ---- Spawning ----
  function placeEnemy(e, type, x, y, biome) {
    e.type = type; e.cfg = CONFIG.types[type]; e.active = true;
    e.x = e.sx = x; e.y = e.sy = y; e.biome = biome;
    e.state = WANDER; e.t = 0; e.anim = 0; e.hasTarget = false; e.pause = rnd(0.5, 2);
    e.cd = 0; e.steer = 0; e.steerT = 0; e.dodge = 0; e.dodgeT = 0; e.giveUp = 0; e.lose = 0; e.stuck = 0; e.unreach = 0; e.flip = Math.random() < 0.5 ? 1 : -1;
  }

  function trySpawn(e) {
    const c = e.cfg, v = api.view();
    const minTurtle = CONFIG.spawnMinScreens * Math.max(v.w, v.h), minTurtle2 = minTurtle * minTurtle;
    const mapR = api.worldSize / 2, minC2 = (CONFIG.minCenterFrac * mapR) ** 2;
    const T = api.turtle;
    for (let i = 0; i < CONFIG.spawnAttemptsPerFrame; i++) {
      const x = Math.random() * api.worldSize, y = Math.random() * api.worldSize;
      const cx = x - api.center.x, cy = y - api.center.y;
      if (cx * cx + cy * cy < minC2) continue;
      const tx = x - T.x, ty = y - T.y;
      if (tx * tx + ty * ty < minTurtle2) continue;
      if (!api.walkable(x, y) || api.inSandText(x, y)) continue;
      if (api.biomeAt(x, y) !== c.biome) continue;
      if (api.blockedAt(x, y, c.bodyRadius + 10)) continue;
      placeEnemy(e, e.type, x, y, c.biome);
      return true;
    }
    return false;
  }

  function updateSpawner() {
    if (now < nextSpawnTry) return;
    let live = 0;
    for (const e of pool) if (e.active) live++;
    if (live >= CONFIG.maxTotal) return;
    for (const e of pool) {
      if (e.active || !e.type || e.debug || now < e.respawnAt) continue;
      if (trySpawn(e)) { live++; if (live >= CONFIG.maxTotal) return; }
      else { nextSpawnTry = now + CONFIG.spawnRetrySeconds; return; }
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
    let hx = ux, hy = uy, found = clearAhead(e, ux, uy, step, look);
    if (!found) {
      const first = e.steer || (Math.random() < 0.5 ? 1 : -1);
      for (let i = 1; i < STEER_COS.length && !found; i++) {
        for (let k = 0; k < 2 && !found; k++) {
          const sg = k === 0 ? first : -first, c = STEER_COS[i], sn = STEER_SIN[i] * sg;
          hx = ux * c - uy * sn; hy = ux * sn + uy * c;
          if (clearAhead(e, hx, hy, step, look)) { found = true; e.steer = sg; e.steerT = 0.8; }
        }
      }
    }
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

  function setState(e, s) { e.state = s; e.t = 0; e.anim = 0; }

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
  function startChase(e) { e.flank = Math.random() * Math.PI * 2; e.lose = 0; e.stuck = 0; e.unreach = 0; e.hasTarget = false; setState(e, CHASE); }
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
    const chaseSpeed = c.speed * playerSpeed, wanderSpeed = chaseSpeed * CONFIG.wanderSpeedMult;

    switch (e.state) {
      case WANDER: case RETURN: {
        if (canSee && d2 < c.detect2) { startChase(e); return; }
        if (e.state === RETURN) {
          const progress = stepToward(e, e.sx, e.sy, wanderSpeed, dt, c.flies);
          e.stuck = progress < 0.3 ? e.stuck + dt : 0;
          const rx = e.sx - e.x, ry = e.sy - e.y;
          setAnim(e, c.flies ? R.fly : R.walk, CONFIG.animFps, FRAMES);
          if (rx * rx + ry * ry < 16 * 16 || e.stuck > 1.5 || e.t > 20) {
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
        if (canSee && e.t >= c.cooldown && d2 < c.ambush2) { e.emergeToChase = true; setState(e, EMERGE); }
        else if (e.t >= e.hiddenFor) { e.emergeToChase = false; setState(e, EMERGE); }
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
        e.row = R.sleep; e.frame = Math.floor(e.t * 3) % FRAMES;
        if (canSee && d2 < c.sleepDetect2) { e.emergeToChase = true; setState(e, WAKE); }
        else if (e.t >= e.hiddenFor) { e.emergeToChase = false; setState(e, WAKE); }
        return;
      }
      case WAKE: {
        if (e.t < c.wakeTime * 0.5) { e.row = R.sleep; e.frame = Math.floor(e.t * 3) % FRAMES; }
        else { e.row = R.idle; e.frame = Math.floor(e.anim * 5) % FRAMES; }
        if (e.t >= c.wakeTime) {
          if (e.emergeToChase && canSee) startChase(e);
          else { setState(e, WANDER); e.pause = rnd(0.5, 1.5); }
        }
        return;
      }
      case CHASE: {
        if (chaseChecks(e, dt, d2, safe, alive)) return;
        if (d2 <= c.attack2) {
          face(e, dx, dy);
          if (e.cd <= 0) { e.hitDone = false; e.atkAngle = Math.atan2(dy, dx); setState(e, ATTACK); return; }
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
        const aimX = d2 > close * close ? T.x + Math.cos(e.flank) * fr : T.x;
        const aimY = d2 > close * close ? T.y + Math.sin(e.flank) * fr : T.y;
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
    const safe = api.isHomeIsland(T.x, T.y), alive = api.turtleAlive();
    for (const e of pool) {
      if (!e.active) continue;
      const dx = T.x - e.x, dy = T.y - e.y;
      if (dx * dx + dy * dy > act2) continue; // far away: frozen, costs nothing
      tick(e, dt, safe, alive);
    }
    separate();
  }

  // Pushes overlapping enemies apart (only ones above ground together or in the air together, and not
  // burrowed/asleep) so a chasing pack reads as several animals. 12 enemies max: the pair loop is trivial.
  const SEP2 = sq(CONFIG.separation);
  function mobile(e) { return e.state !== HIDDEN && e.state !== BURROW && e.state !== EMERGE && e.state !== SLEEP && e.state !== WAKE; }
  function airborne(e) { return e.cfg.flies && (e.state === CHASE || e.state === ATTACK || e.state === RETURN); }
  function separate() {
    const n = pool.length;
    for (let i = 0; i < n; i++) {
      const a = pool[i];
      if (!a.active || !mobile(a)) continue;
      for (let j = i + 1; j < n; j++) {
        const b = pool[j];
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
    g.imageSmoothingEnabled = false; // pixel art; save/restore keeps the rest of the game's smoothing as-is
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

  window.Enemies = { init, update, resetAggro, collectVisible, drawDebug, CONFIG, get pool() { return DEBUG ? pool : null; }, get api() { return DEBUG ? api : null; } }; // pool/api only exposed with ?debug=1, for console poking
})();
