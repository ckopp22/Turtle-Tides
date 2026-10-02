// progression.js — core progression system: hearts, hunger, hull (carry) capacity, home level,
// carried/banked inventory, upgrades, and the top-left HUD. Kept separate from game.js so the
// economy/stats logic can be tuned without touching movement/collision/rendering. game.js calls
// into window.Progression's small API each frame and on pickup/home-entry events; intro.js's
// save-slot data flows in via attachSlot()/getSaveData() (see the TT_SAVE bridge at the bottom of
// intro.js).
(() => {
  'use strict';

  // ---- CONFIG: every tunable number for this system lives here ----
  const CONFIG = {
    hearts: {
      startMax: 1,
      // upgradeCosts[i] = banked coins to go from level i to i+1 (maxHearts = startMax + level)
      upgradeCosts: [10, 70, 130, 210],
    },
    hunger: {
      // Fixed for the whole game now — no upgrade track (was `hungerLevel`/TRACKS.hunger).
      baseMax: 100,
      baseDrainPerSecond: 0.6,     // only drains away from the home island (MDD s4); halved from 1.2
      slowMultiplier: 0.55,        // movement speed multiplier while hunger is at 0
      graceSeconds: 8,             // time at 0 hunger before heart loss starts
      heartLossIntervalSeconds: 6, // one heart lost per this many seconds once past the grace period
    },
    hull: {
      capTiers: [3, 5, 10, 15, 20, 25], // index 0 = starting capacity
      upgradeCosts: [10, 50, 95, 175, 280],
    },
    home: {
      // Full 20-level curve, tuned so each step to level 10 is a small, quick win (cost climbs by
      // a steady +5-15 coins/level), then levels 11-20 climb faster (+65-160/level) for a real but
      // still reachable long-term goal — not a wall. cost[i] = coins to go from level i-1 to i.
      // `decor` = the one new placeholder piece game.js adds to the home island at this level
      // (cumulative — game.js draws every decor id from level 0 up to the current homeLevel, never
      // replacing earlier ones). `skill` = an id into SKILLS below, or null.
      // level 10 keeps its existing "Hide in Shell" unlock (cabin/shape) exactly where it already
      // was — everything else slots around it.
      // TODO: the desc/shape fields are still placeholders — real per-level art still needed.
      levels: [
        { cost: 0,    desc: 'a pile of rocks',                          decor: 'rocks',        skill: null },
        { cost: 10,   desc: 'a woven nest tucked in the rocks',         decor: 'nest',          skill: null },
        { cost: 30,   desc: 'a driftwood bed to sleep in',              decor: 'bed',           skill: 'sleep' },
        { cost: 45,   desc: 'a crackling campfire',                     decor: 'campfire',      skill: null },
        { cost: 65,   desc: 'the frame of a hut going up',              decor: 'hutFrame',      skill: 'turtleShop' },
        { cost: 90,   desc: 'swim fins drying by the hut',              decor: 'swimFins',      skill: 'swimSpeed1' },
        { cost: 115,  desc: 'torches lit along the path',               decor: 'torches',       skill: 'dayNight' },
        { cost: 150,  desc: 'a small reading nook with books',          decor: 'books',         skill: 'moveSpeed1' },
        { cost: 185,  desc: 'the hut, finally finished',                decor: 'hutComplete',   skill: null },
        { cost: 225,  desc: 'a covered porch added to the hut',         decor: 'porch',         skill: null },
        { cost: 270,  desc: 'a proper cabin replaces the hut',          decor: 'cabin',         skill: 'hideInShell' },
        { cost: 320,  desc: 'lanterns hung by the door',                decor: 'lanterns',      skill: null },
        { cost: 375,  desc: 'a woven rug laid out front',               decor: 'rug',           skill: null },
        { cost: 440,  desc: 'a driftwood table',                        decor: 'table',         skill: 'swimSpeed2' },
        { cost: 510,  desc: 'a hammock strung between posts',           decor: 'hammock',       skill: null },
        { cost: 590,  desc: 'a small garden patch',                     decor: 'garden',        skill: null },
        { cost: 680,  desc: 'string flags fluttering overhead',         decor: 'flags',         skill: 'moveSpeed2' },
        { cost: 775,  desc: 'a stone-lined firepit ring',                decor: 'firepitRing',   skill: null },
        { cost: 880,  desc: 'a stone path connects the camp',           decor: 'path',          skill: null },
        { cost: 990,  desc: 'string lights strung between posts',       decor: 'lights',        skill: null },
        { cost: 1120, desc: 'the full camp, home at last',              decor: 'fullCamp',      skill: null },
      ],
    },
    // Turtle Shop (L5 skill): buy with banked coins, equip freely once owned. One equipped item
    // per category ('color' | 'hat' | 'clothes' | 'accessory'); 'color_default' is always owned
    // and is the baseline equipped color (no "none" state for that category — every turtle has
    // *some* color). Add a new item by adding a row here plus a matching entry in COSMETIC_DRAW/
    // COLOR_TINTS below — nothing else needs to change.
    // TODO: every item is a canvas-shape placeholder — real per-item art still needed for all 11.
    shop: {
      items: [
        { id: 'color_default',       category: 'color',     label: 'Natural Shell', cost: 0 },
        { id: 'color_coral',         category: 'color',     label: 'Coral Shell',   cost: 60 },
        { id: 'color_indigo',        category: 'color',     label: 'Indigo Shell',  cost: 60 },
        { id: 'color_gold',          category: 'color',     label: 'Golden Shell',  cost: 90 },
        { id: 'hat_straw',           category: 'hat',       label: 'Straw Hat',     cost: 40, icon: 'assets/items/accessory_ring_orange.png' },
        { id: 'hat_sailor',          category: 'hat',       label: 'Sailor Cap',    cost: 55, icon: 'assets/items/accessory_ring_navy.png' },
        { id: 'hat_flower',          category: 'hat',       label: 'Flower Crown',  cost: 70, icon: 'assets/items/hat_flower.png' },
        { id: 'clothes_vest',        category: 'clothes',   label: 'Life Vest',     cost: 65, icon: 'assets/items/clothes_vest.png' },
        { id: 'clothes_tshirt',      category: 'clothes',   label: 'T-Shirt',       cost: 40, icon: 'assets/items/clothes_tshirt.png' },
        { id: 'clothes_cape',        category: 'clothes',   label: 'Cape',          cost: 55, icon: 'assets/items/clothes_cape.png' },
        { id: 'accessory_bowtie',    category: 'accessory', label: 'Bow Tie',       cost: 25, icon: 'assets/items/accessory_bowtie.png' },
        { id: 'accessory_scarf',     category: 'accessory', label: 'Scarf',         cost: 45, icon: 'assets/items/accessory_scarf.png' },
        { id: 'clothes_diving',      category: 'clothes',   label: 'Backpack',      cost: 60, icon: 'assets/items/clothes_diving.png' },
        { id: 'accessory_crab',      category: 'accessory', label: 'Bandana',       cost: 50, icon: 'assets/items/accessory_crab.png' },
        { id: 'accessory_goggles',   category: 'accessory', label: 'Sunglasses',    cost: 35, icon: 'assets/items/accessory_goggles.png' },
      ],
    },
    speed: {
      // Swim Speed multiplies water movement only; Move Speed multiplies land movement only (see
      // game.js's WATER_SPEED_MULT/LAND_SPEED_MULT). They never apply at the same time — the
      // turtle is either on land or in water, never both — so there's no compounding to worry
      // about. Within one domain, tier II replaces tier I rather than multiplying on top of it
      // (index 1 is the full boost once both are unlocked, not I*II).
      swimSpeedTiers: [1.2, 1.4],  // [Swim Speed I, Swim Speed II]
      moveSpeedTiers: [1.2, 1.4],  // [Move Speed I, Move Speed II]
    },
    sleep: {
      idleSecondsToTrigger: 1.5, // stand still near the bed this long before the turtle lies down
      triggerRadius: 55,         // world px from the bed decor that counts as "near" it
      heartsPerSecond: 0.12,     // fractional heart recovery/sec while asleep (accumulates, see state.heartRecoverAccum)
      // No hunger recovery — sleeping only heals hearts, hunger still just sits flat (no drain,
      // same as anywhere else on the home island).
    },
    invulnSeconds: 1.2,           // blink window after a heart is lost
    hullFullFlashSeconds: 1.4,
    // Carried (unbanked) items are never written to the save (see getSaveData()), so closing the
    // app mid-trip already behaves like this flag = true (loses that trip's haul, same as dying).
    // Flip the persistence in getSaveData()/loadFromSave() if you'd rather keep an in-progress trip.
    loseUnbankedOnClose: true,
  };

  // ---- Skills: gated purely by home level. Each has an id (used by game.js to branch behavior),
  // a label (for the Home Perks panel/celebration toast), and the homeLevel at which it unlocks.
  // Keep this modular — a new skill is just one more row here plus its own enable/disable logic
  // wherever it lives (game.js for movement/animation skills, progression.js for anything stat-y).
  const SKILLS = [
    { id: 'sleep',       label: 'Sleep',            unlockLevel: 2 },
    { id: 'turtleShop',  label: 'Turtle Shop',      unlockLevel: 4 },
    { id: 'swimSpeed1',  label: 'Swim Speed I',     unlockLevel: 5 },
    { id: 'dayNight',    label: 'Day/Night Toggle', unlockLevel: 6 },
    { id: 'moveSpeed1',  label: 'Move Speed I',     unlockLevel: 7 },
    { id: 'hideInShell', label: 'Hide in Shell',    unlockLevel: 10 },
    { id: 'swimSpeed2',  label: 'Swim Speed II',    unlockLevel: 13 },
    { id: 'moveSpeed2',  label: 'Move Speed II',    unlockLevel: 16 },
  ];
  function hasSkill(id) {
    const s = SKILLS.find(s => s.id === id);
    return !!s && state.homeLevel >= s.unlockLevel;
  }
  function skillAtLevel(level) { return SKILLS.find(s => s.unlockLevel === level) || null; }

  // ---- Turtle Shop (L5 skill) ----
  const SHOP_CATEGORIES = ['color', 'hat', 'clothes', 'accessory'];
  function shopItem(id) { return CONFIG.shop.items.find(i => i.id === id) || null; }
  function shopItemsByCategory(category) { return CONFIG.shop.items.filter(i => i.category === category); }
  function ownsCosmetic(id) { return state.cosmetics.owned.includes(id); }
  function equippedIn(category) { return state.cosmetics.equipped[category] || null; }
  function buyCosmetic(id) {
    const item = shopItem(id);
    if (!item || ownsCosmetic(id) || state.banked.coins < item.cost) return false;
    state.banked.coins -= item.cost;
    state.cosmetics.owned.push(id);
    persist();
    return true;
  }
  function equipCosmetic(id) {
    const item = shopItem(id);
    if (!item || !ownsCosmetic(id)) return false;
    state.cosmetics.equipped[item.category] = id;
    persist();
    return true;
  }
  // Every category but 'color' can go back to "nothing equipped" — a turtle always has some color.
  function unequipCategory(category) {
    if (category === 'color') return false;
    state.cosmetics.equipped[category] = null;
    persist();
    return true;
  }

  // ---- Cosmetic rendering: color tint composites onto the sprite itself (game.js applies it via
  // getEquippedColorTint), hat/clothes/accessory are drawn as extra shapes in the turtle's own
  // local space (game.js calls drawEquippedCosmetics from inside drawTurtle(), after the sprite
  // draw and any mirror flip, so cosmetics automatically stay attached through every state/frame —
  // sleeping, shell, walking, swimming — without each one needing its own positioning logic).
  const COLOR_TINTS = {
    color_coral: 'rgba(224, 102, 74, 0.7)',
    color_indigo: 'rgba(90, 78, 203, 0.7)',
    color_gold: 'rgba(232, 194, 63, 0.7)',
  };
  function getEquippedColorTint(overrideEquipped) {
    const id = (overrideEquipped || state.cosmetics.equipped).color;
    return COLOR_TINTS[id] || null; // null/'color_default' -> no tint, natural sprite color
  }
  // dw/spriteH = the sprite's drawn width/height in the caller's local space (already translated +
  // rotated to the turtle/preview center at (0,0), origin at the sprite's own center).
  const COSMETIC_DRAW = {};
  // Items with real pixel art (vs. the COSMETIC_DRAW canvas-shape placeholders above) just need an
  // id -> image path and a rough anchor point in sprite-local space; drawCosmeticImage below handles
  // the actual drawImage call once each image has loaded. y/scale tuned against a reference mockup
  // of the turtle-sheet proportions: head-worn items sit just above/on the head (y ~ -0.4), neck/
  // collar items sit right where the head meets the shell (y ~ -0.08 to -0.12), and the two
  // shell-cover items (diving helmet, life vest) are sized to cover the whole shell, centered on it.
  const COSMETIC_IMAGES = {
    hat_flower:              { src: 'assets/items/hat_flower.png',           y: -0.36, scale: 0.46 },
    clothes_diving:          { src: 'assets/items/clothes_diving.png',        y: 0.04,  scale: 0.84 },
    clothes_vest:             { src: 'assets/items/clothes_vest.png',          y: 0.04,  scale: 0.8 },
    accessory_crab:          { src: 'assets/items/accessory_crab.png',        y: -0.1,  scale: 0.75 },
    accessory_goggles:       { src: 'assets/items/accessory_goggles.png',     y: -0.34, scale: 0.34 },
    hat_sailor:              { src: 'assets/items/accessory_ring_navy.png',   y: -0.42, scale: 0.48 },
    hat_straw:               { src: 'assets/items/accessory_ring_orange.png', y: -0.42, scale: 0.48 },
    accessory_scarf:         { src: 'assets/items/accessory_scarf.png',       y: -0.1,  scale: 0.6 },
    clothes_tshirt:          { src: 'assets/items/clothes_tshirt.png',        y: 0.04,  scale: 0.8 },
    clothes_cape:            { src: 'assets/items/clothes_cape.png',          y: 0.05,  scale: 0.8 },
    accessory_bowtie:        { src: 'assets/items/accessory_bowtie.png',      y: -0.2,  scale: 0.4 },
  };
  const cosmeticImageCache = {};
  function getCosmeticImage(id) {
    const def = COSMETIC_IMAGES[id];
    if (!def) return null;
    if (!cosmeticImageCache[id]) {
      const img = new Image();
      img.src = def.src;
      cosmeticImageCache[id] = img;
    }
    return cosmeticImageCache[id];
  }
  // Head-worn items (hats) sit on top of the turtle's head, which bobs a little from frame to frame
  // in the walk-cycle art itself; the hat image is static, so without this it reads as floating
  // above the head instead of resting on it. Offsets (as a fraction of spriteH) are eyeballed against
  // the sheet's 4 walk frames and only applied to the 'hat' category.
  const HAT_BOB_BY_FRAME = [0, 0.013, -0.02, 0.013];
  // Side-to-side head sway per walk frame (fraction of spriteH, measured from the head's x-center in
  // the sheet; frame 3 is drawn mirrored, so its local-space offset stays positive).
  const HAT_SWAY_BY_FRAME = [0, 0.087, 0, 0.07];
  function drawCosmeticImage(ctx, dw, spriteH, id, bobFrame) {
    const def = COSMETIC_IMAGES[id];
    const img = getCosmeticImage(id);
    if (!def || !img || !img.complete || !img.naturalWidth) return;
    const w = dw * def.scale;
    const h = w * (img.naturalHeight / img.naturalWidth);
    const bob = bobFrame != null ? spriteH * (HAT_BOB_BY_FRAME[bobFrame] || 0) : 0;
    const sway = bobFrame != null ? spriteH * (HAT_SWAY_BY_FRAME[bobFrame] || 0) : 0;
    ctx.drawImage(img, -w / 2 + sway, spriteH * def.y - h / 2 + bob, w, h);
  }
  function drawEquippedCosmetics(ctx, dw, spriteH, overrideEquipped, walkFrame, hatMode) {
    const equipped = overrideEquipped || state.cosmetics.equipped;
    for (const cat of SHOP_CATEGORIES) {
      if (cat === 'color') continue; // handled by getEquippedColorTint, not a drawn shape
      const id = equipped[cat];
      if (!id) continue;
      const behind = cat === 'hat' || id === 'clothes_cape' || id === 'clothes_diving'; // swimming: hat, cape, backpack go behind the turtle
      if (hatMode === 'skip' && behind) continue; // hatMode: 'only' draws just the behind-items, 'skip' draws everything but
      if (hatMode === 'only' && !behind) continue;
      if (COSMETIC_IMAGES[id]) drawCosmeticImage(ctx, dw, spriteH, id, (cat === 'hat' || id === 'accessory_goggles') ? walkFrame : null); // head-worn: follow the walk-cycle head bob/sway
      else if (COSMETIC_DRAW[id]) COSMETIC_DRAW[id](ctx, dw, spriteH);
    }
  }

  const state = {
    hearts: CONFIG.hearts.startMax,
    heartsLevel: 0,
    hunger: CONFIG.hunger.baseMax,
    hullLevel: 0,
    homeLevel: 0,
    carried: { coins: 0, coconuts: 0, shells: 0 },
    banked: { coins: 0, coconuts: 0, shells: 0 },
    shellCollection: [], // banked shell trophies; TODO: shell variety/color once that system exists
    hungerZeroTimer: 0,  // seconds spent at 0 hunger (grace + repeat heart-loss ticking)
    hungerHeartTicks: 0,
    heartRecoverAccum: 0, // fractional heart progress while sleeping (see updateSleep)
    isNight: false, // Day/Night toggle (L7 skill) — game.js eases its sky render toward this target
    cosmetics: {
      owned: ['color_default'],
      equipped: { color: 'color_default', hat: null, clothes: null, accessory: null },
    },
    invulnTimer: 0,
    hullFullFlash: 0,
    lastLostMessage: null, // { text, timer } shown briefly after a death
    turtleMaster: false, // true once hearts/hull/home are all fully upgraded; persists forever
  };

  function clampLevel(v, max) { v = Number.isFinite(v) ? v : 0; return Math.max(0, Math.min(max, v)); }
  function maxHearts() { return CONFIG.hearts.startMax + state.heartsLevel; }
  function hungerMax() { return CONFIG.hunger.baseMax; }
  function hungerDrainRate() { return CONFIG.hunger.baseDrainPerSecond; }
  function hullCap() { return CONFIG.hull.capTiers[state.hullLevel]; }
  function carriedTotal() { return state.carried.coins + state.carried.coconuts + state.carried.shells; }
  function homeLevelDef() { return CONFIG.home.levels[Math.min(state.homeLevel, CONFIG.home.levels.length - 1)]; }
  function getHomeLevels() { return CONFIG.home.levels; } // read-only by convention, same as `state`

  // ---- Pickup / bank / loss ----
  // Returns false (and flashes the hull-full cue) if the hull has no room; caller should leave the
  // item on the ground in that case rather than consuming it.
  function tryPickup(type) {
    if (carriedTotal() >= hullCap()) {
      // tryPickup runs every frame while overlapping an item, so only sound off when the flash isn't already running
      if (state.hullFullFlash <= 0 && window.TT_SOUND) window.TT_SOUND.full();
      state.hullFullFlash = CONFIG.hullFullFlashSeconds;
      return false;
    }
    state.carried[type]++;
    return true;
  }
  function bankCarried() {
    if (carriedTotal() === 0) return false;
    state.banked.coins += state.carried.coins;
    state.banked.coconuts += state.carried.coconuts;
    for (let i = 0; i < state.carried.shells; i++) state.shellCollection.push({ bankedAt: Date.now() });
    state.banked.shells += state.carried.shells;
    state.carried = { coins: 0, coconuts: 0, shells: 0 };
    persist();
    return true;
  }
  function loseCarried() {
    const lost = carriedTotal();
    state.carried = { coins: 0, coconuts: 0, shells: 0 };
    return lost;
  }
  // Auto-eats one carried coconut to refill hunger once it runs out (MDD s4 v1 assumption).
  function eatCoconutIfHungry() {
    if (state.hunger > 0 || state.carried.coconuts <= 0) return false;
    state.carried.coconuts--;
    state.hunger = hungerMax();
    state.hungerZeroTimer = 0;
    return true;
  }
  // Manual eat, triggered by clicking/tapping the HUD hunger bar (see tryEatFromHud below). Eats
  // from the banked stash first; only dips into carried coconuts (the ones "just found" on the
  // current trip) once banked is empty — that also frees up a hull slot, same as if it'd never been
  // picked up. No-ops (doesn't consume a coconut) if hunger is already full, so an accidental click
  // can't waste one.
  function eatCoconutManual() {
    if (state.hunger >= hungerMax()) return false;
    if (state.banked.coconuts > 0) state.banked.coconuts--;
    else if (state.carried.coconuts > 0) state.carried.coconuts--;
    else return false;
    state.hunger = hungerMax();
    state.hungerZeroTimer = 0;
    state.hungerHeartTicks = 0;
    persist();
    if (window.TT_SOUND) window.TT_SOUND.bite();
    return true;
  }
  // Hit-testing rect for the whole HUD panel (hearts/hunger/capacity), updated each drawHUD() call,
  // in the same CSS-px screen space the canvas click/touch coordinates arrive in. Clicking anywhere
  // on the panel eats a coconut, not just the hunger bar itself.
  let hudPanelRect = null;
  function tryEatFromHud(clientX, clientY) {
    if (!hudPanelRect) return false;
    const r = hudPanelRect;
    if (clientX < r.x || clientX > r.x + r.w || clientY < r.y || clientY > r.y + r.h) return false;
    return eatCoconutManual();
  }

  let respawnHandler = null;
  function setRespawnHandler(fn) { respawnHandler = fn; } // game.js hooks this to reset turtle.x/y
  // Death sequence hook: game.js plays the fade-out and then calls respawnAtHome() itself. Without a
  // handler, dying respawns instantly like before.
  let deathHandler = null, dying = false;
  function setDeathHandler(fn) { deathHandler = fn; }
  function respawnAtHome() {
    dying = false;
    const lost = loseCarried();
    state.hearts = maxHearts();
    state.hunger = hungerMax();
    state.hungerZeroTimer = 0;
    state.hungerHeartTicks = 0;
    state.invulnTimer = 0;
    if (lost > 0) state.lastLostMessage = { text: `Lost ${lost} item${lost === 1 ? '' : 's'} from that trip`, timer: 3 };
    persist();
    if (respawnHandler) respawnHandler();
    return lost;
  }

  // Removes one heart (guarded by invulnerability). TODO: call this from bird/enemy contact once
  // enemies exist in game.js — nothing calls it yet, this is just the hook.
  function takeHit() {
    if (state.invulnTimer > 0 || dying) return false;
    state.hearts = Math.max(0, state.hearts - 1);
    state.invulnTimer = CONFIG.invulnSeconds;
    if (window.TT_SOUND) window.TT_SOUND.umph();
    if (state.hearts <= 0) {
      if (deathHandler) { dying = true; deathHandler(); } else respawnAtHome();
      return true;
    }
    return false;
  }
  function isInvulnerable() { return state.invulnTimer > 0; }

  // Called by game.js every frame. `awayFromHome` gates both hunger drain and the hunger penalty
  // (safe on the home island, same as birds never spawning there). Returns a speed multiplier
  // game.js multiplies into its own water/land speed calc.
  function update(dt, awayFromHome) {
    ensureDayNightButton();
    if (state.invulnTimer > 0) state.invulnTimer = Math.max(0, state.invulnTimer - dt);
    if (state.hullFullFlash > 0) state.hullFullFlash = Math.max(0, state.hullFullFlash - dt);
    if (state.lastLostMessage) {
      state.lastLostMessage.timer -= dt;
      if (state.lastLostMessage.timer <= 0) state.lastLostMessage = null;
    }

    if (dying) return 1; // frozen (no hunger drain/hits) while the death fade plays
    let speedMult = 1;
    if (awayFromHome) {
      state.hunger = Math.max(0, state.hunger - hungerDrainRate() * dt);
      if (state.hunger <= 0 && !eatCoconutIfHungry()) {
        speedMult = CONFIG.hunger.slowMultiplier;
        state.hungerZeroTimer += dt;
        if (state.hungerZeroTimer > CONFIG.hunger.graceSeconds) {
          const overGrace = state.hungerZeroTimer - CONFIG.hunger.graceSeconds;
          const ticks = Math.floor(overGrace / CONFIG.hunger.heartLossIntervalSeconds);
          if (ticks > state.hungerHeartTicks) { state.hungerHeartTicks = ticks; takeHit(); }
        }
      } else {
        state.hungerZeroTimer = 0;
        state.hungerHeartTicks = 0;
      }
    } else {
      state.hungerZeroTimer = 0;
      state.hungerHeartTicks = 0;
    }
    return speedMult;
  }

  // Called by game.js every frame while state === 'sleeping'. Recovers hearts only (fractionally);
  // hunger is untouched — it already doesn't drain on the home island (see update() above), and
  // sleep doesn't add active hunger regen on top of that.
  function updateSleep(dt) {
    if (state.hearts < maxHearts()) {
      state.heartRecoverAccum += CONFIG.sleep.heartsPerSecond * dt;
      while (state.heartRecoverAccum >= 1 && state.hearts < maxHearts()) {
        state.hearts++;
        state.heartRecoverAccum -= 1;
      }
    }
  }
  function getSleepConfig() { return CONFIG.sleep; }

  // ---- Day/Night toggle (L7 skill) — game.js owns the actual fade/render, this just holds and
  // persists the player's last chosen setting per save slot. ----
  function toggleDayNight() {
    if (!hasSkill('dayNight')) return;
    state.isNight = !state.isNight;
    persist();
  }

  // ---- Speed skills (game.js multiplies these into its water/land speed calc each frame) ----
  function swimSpeedMultiplier() {
    if (hasSkill('swimSpeed2')) return CONFIG.speed.swimSpeedTiers[1];
    if (hasSkill('swimSpeed1')) return CONFIG.speed.swimSpeedTiers[0];
    return 1;
  }
  function moveSpeedMultiplier() {
    if (hasSkill('moveSpeed2')) return CONFIG.speed.moveSpeedTiers[1];
    if (hasSkill('moveSpeed1')) return CONFIG.speed.moveSpeedTiers[0];
    return 1;
  }

  // ---- Upgrades ----
  const TRACKS = {
    hearts: {
      label: 'Hearts', icon: 'assets/items/heart_full.png', level: () => state.heartsLevel, maxLevel: () => CONFIG.hearts.upgradeCosts.length,
      cost: () => CONFIG.hearts.upgradeCosts[state.heartsLevel],
      next: () => `${CONFIG.hearts.startMax + state.heartsLevel + 1} total`,
      apply: () => { state.heartsLevel++; state.hearts = maxHearts(); },
    },
    hull: {
      label: 'Hull', icon: 'assets/items/backpack.png', level: () => state.hullLevel, maxLevel: () => CONFIG.hull.capTiers.length - 1,
      cost: () => CONFIG.hull.upgradeCosts[state.hullLevel],
      next: () => `${CONFIG.hull.capTiers[state.hullLevel + 1]} items`,
      apply: () => { state.hullLevel++; },
    },
    home: {
      label: 'Home', icon: 'assets/items/home_icon.png', level: () => state.homeLevel, maxLevel: () => CONFIG.home.levels.length - 1,
      cost: () => CONFIG.home.levels[state.homeLevel + 1].cost,
      next: () => `level ${state.homeLevel + 1}`,
      apply: () => { state.homeLevel++; },
    },
  };
  function canUpgrade(track) {
    const t = TRACKS[track];
    return t.level() < t.maxLevel() && state.banked.coins >= t.cost();
  }
  function allUpgradesMaxed() {
    return Object.values(TRACKS).every(t => t.level() >= t.maxLevel());
  }
  function buyUpgrade(track) {
    if (!canUpgrade(track)) return false;
    state.banked.coins -= TRACKS[track].cost();
    TRACKS[track].apply();
    if (!state.turtleMaster && allUpgradesMaxed()) {
      state.turtleMaster = true;
      showCongratsBanner();
    }
    persist();
    return true;
  }

  // ---- Save integration (bridges to intro.js's localStorage slots via window.TT_SAVE) ----
  let activeSlotId = null;
  function loadFromSave(data) {
    data = data || {};
    state.heartsLevel = clampLevel(data.heartsLevel, CONFIG.hearts.upgradeCosts.length);
    state.hullLevel = clampLevel(data.hullLevel, CONFIG.hull.capTiers.length - 1);
    state.homeLevel = clampLevel(data.homeLevel, CONFIG.home.levels.length - 1);
    state.banked = {
      coins: data.banked?.coins || 0,
      coconuts: data.banked?.coconuts || 0,
      shells: data.banked?.shells || 0,
    };
    state.shellCollection = Array.isArray(data.shellCollection) ? data.shellCollection : [];
    state.isNight = typeof data.isNight === 'boolean' ? data.isNight : false; // missing on old saves -> default day
    // Cosmetics: old saves have no `cosmetics` field at all — default to just the free color owned/
    // equipped and nothing else. A save with a partial/corrupt object still gets safe defaults per field.
    const c = data.cosmetics || {};
    const owned = Array.isArray(c.owned) ? c.owned.filter(id => shopItem(id)) : [];
    if (!owned.includes('color_default')) owned.push('color_default');
    const eq = c.equipped || {};
    state.cosmetics = {
      owned,
      equipped: {
        color: (eq.color && owned.includes(eq.color)) ? eq.color : 'color_default',
        hat: (eq.hat && owned.includes(eq.hat)) ? eq.hat : null,
        clothes: (eq.clothes && owned.includes(eq.clothes)) ? eq.clothes : null,
        accessory: (eq.accessory && owned.includes(eq.accessory)) ? eq.accessory : null,
      },
    };
    // Never restore carried items from a save — see loseUnbankedOnClose above.
    state.carried = { coins: 0, coconuts: 0, shells: 0 };
    state.hearts = maxHearts();
    state.hunger = hungerMax();
    state.hungerZeroTimer = 0;
    state.hungerHeartTicks = 0;
    state.invulnTimer = 0;
    state.hullFullFlash = 0;
    state.lastLostMessage = null;
    state.heartRecoverAccum = 0;
    // Old saves have no `turtleMaster` field — fall back to re-deriving it from upgrade levels
    // (loadFromSave above already set heartsLevel/hullLevel/homeLevel) so it isn't lost.
    state.turtleMaster = typeof data.turtleMaster === 'boolean' ? data.turtleMaster : allUpgradesMaxed();
  }
  function getSaveData() {
    return {
      heartsLevel: state.heartsLevel,
      hullLevel: state.hullLevel,
      homeLevel: state.homeLevel,
      banked: { ...state.banked },
      shellCollection: state.shellCollection.slice(),
      isNight: state.isNight,
      cosmetics: { owned: state.cosmetics.owned.slice(), equipped: { ...state.cosmetics.equipped } },
      turtleMaster: state.turtleMaster,
    };
  }
  function attachSlot(slotId, existingData) {
    activeSlotId = slotId;
    loadFromSave(existingData);
  }
  function persist() {
    if (activeSlotId == null || !window.TT_SAVE) return;
    const existing = window.TT_SAVE.readSlot(activeSlotId) || {};
    const merged = Object.assign({}, existing, getSaveData(), { lastPlayedAt: new Date().toISOString() });
    window.TT_SAVE.writeSlot(activeSlotId, merged);
  }

  // ---- HUD (screen-space canvas draw, called from game.js's render()) ----
  // Icons below mirror the actual in-world pickup art (see the coin/coconut/shell drawItem() shape
  // code in game.js) so the panel reads as the same game rather than generic UI.
  const heartFullImg = new Image();
  heartFullImg.src = 'assets/items/heart_full.png';
  const heartEmptyImg = new Image();
  heartEmptyImg.src = 'assets/items/heart_empty.png';
  function drawHeart(ctx, cx, cy, r, filled) {
    const img = filled ? heartFullImg : heartEmptyImg;
    if (img.complete && img.naturalWidth) {
      ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    } else {
      ctx.fillStyle = filled ? '#ff5a6e' : 'rgba(255,255,255,0.28)';
      ctx.beginPath();
      ctx.moveTo(cx, cy + r * 0.6);
      ctx.bezierCurveTo(cx - r * 1.3, cy - r * 0.6, cx - r * 0.5, cy - r * 1.3, cx, cy - r * 0.4);
      ctx.bezierCurveTo(cx + r * 0.5, cy - r * 1.3, cx + r * 1.3, cy - r * 0.6, cx, cy + r * 0.6);
      ctx.closePath();
      ctx.fill();
    }
  }
  const homeIconImg = new Image();
  homeIconImg.src = 'assets/items/home_icon.png';
  function drawHomeIcon(ctx, cx, cy, r, color) {
    if (homeIconImg.complete && homeIconImg.naturalWidth) {
      ctx.drawImage(homeIconImg, cx - r, cy - r, r * 2, r * 2);
      return;
    }
    ctx.fillStyle = color || '#ffd27a';
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx, cy - r); ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx + r * 0.7, cy); ctx.lineTo(cx + r * 0.7, cy + r * 0.8); ctx.lineTo(cx - r * 0.7, cy + r * 0.8);
    ctx.lineTo(cx - r * 0.7, cy); ctx.closePath();
    ctx.fill();
  }
  const coinHudIconImg = new Image();
  coinHudIconImg.src = 'assets/items/coin_hud.png';
  function drawCoinIcon(ctx, cx, cy, r) {
    if (coinHudIconImg.complete && coinHudIconImg.naturalWidth) {
      ctx.drawImage(coinHudIconImg, cx - r, cy - r, r * 2, r * 2);
      return;
    }
    ctx.save();
    ctx.fillStyle = '#e8c23f';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#b8842a'; ctx.lineWidth = Math.max(1, r * 0.2);
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  const coconutIconImg = new Image();
  coconutIconImg.src = 'assets/items/coconut.png';
  function drawCoconutIcon(ctx, cx, cy, r) {
    if (coconutIconImg.complete && coconutIconImg.naturalWidth) {
      ctx.drawImage(coconutIconImg, cx - r, cy - r, r * 2, r * 2);
      return;
    }
    ctx.save();
    ctx.fillStyle = '#6b4423';
    ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.86, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(240, 217, 168, 0.55)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, cy - r * 0.8); ctx.lineTo(cx, cy + r * 0.8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - r * 0.5, cy - r * 0.55); ctx.lineTo(cx - r * 0.15, cy + r * 0.6); ctx.stroke();
    ctx.restore();
  }
  const backpackIconImg = new Image();
  backpackIconImg.src = 'assets/items/backpack.png';
  const hullHudIconImg = new Image();
  hullHudIconImg.src = 'assets/items/hull_hud.png';
  function drawShellIcon(ctx, cx, cy, r) {
    if (hullHudIconImg.complete && hullHudIconImg.naturalWidth) {
      ctx.drawImage(hullHudIconImg, cx - r, cy - r, r * 2, r * 2);
      return;
    }
    if (backpackIconImg.complete && backpackIconImg.naturalWidth) {
      ctx.drawImage(backpackIconImg, cx - r, cy - r, r * 2, r * 2);
      return;
    }
    ctx.save();
    ctx.fillStyle = '#f0d9a8';
    ctx.beginPath();
    ctx.moveTo(cx, cy + r);
    for (let a = -1; a <= 1.001; a += 0.25) ctx.lineTo(cx + Math.sin(a) * r, cy - Math.cos(a) * r * 0.8);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#c9a86a'; ctx.lineWidth = 1;
    for (let a = -0.8; a <= 0.81; a += 0.4) {
      ctx.beginPath(); ctx.moveTo(cx, cy + r); ctx.lineTo(cx + Math.sin(a) * r, cy - Math.cos(a) * r * 0.8); ctx.stroke();
    }
    ctx.restore();
  }
  // TODO: banked shell total + a shell-collection viewer live behind a future "collection book"
  // button (state.shellCollection already tracks each banked shell) — not built yet, scope for now
  // is the HUD layout restyle only.
  function drawHUD(ctx) {
    const pad = 14, innerPad = 12;
    // Panel widens once the "Turtle Master" badge replaces the "Lv N" home badge (that label is a
    // lot longer) — the hunger bar and bottom-row currency, which both size off panelW/scale below,
    // stretch out to match instead of leaving the wider panel looking empty.
    const panelW = state.turtleMaster ? 280 : 220;
    const scale = panelW / 220;
    const heartSize = 20, heartGap = 4, barH = 10;
    const rowHeartsH = heartSize + 10, rowHungerH = barH + 12, rowCapH = 20;

    let contentH = innerPad + rowHeartsH + rowHungerH + rowCapH;
    if (state.hullFullFlash > 0) contentH += 18;
    if (state.lastLostMessage) contentH += 20;
    contentH += innerPad;

    ctx.save();
    ctx.textBaseline = 'middle';

    ctx.fillStyle = 'rgba(9, 46, 61, 0.82)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(pad, pad, panelW, contentH, 16); ctx.fill(); ctx.stroke();
    hudPanelRect = { x: pad, y: pad, w: panelW, h: contentH };

    const x = pad + innerPad;
    let y = pad + innerPad;

    // Hearts (left) + home level badge (right)
    for (let i = 0; i < maxHearts(); i++) {
      drawHeart(ctx, x + i * (heartSize + heartGap) + heartSize / 2, y + heartSize / 2, heartSize / 2, i < state.hearts);
    }
    ctx.font = '700 13px system-ui, sans-serif';
    const lvText = state.turtleMaster ? 'Turtle Master' : `Lv ${state.homeLevel}`;
    const badgeW = 24 + ctx.measureText(lvText).width + 10;
    const badgeH = heartSize + 4;
    const badgeX = pad + panelW - innerPad - badgeW;
    ctx.fillStyle = '#ffb347';
    ctx.strokeStyle = '#7a5a1e'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(badgeX, y - 2, badgeW, badgeH, 10); ctx.fill(); ctx.stroke();
    drawHomeIcon(ctx, badgeX + 14, y + badgeH / 2 - 2, 10, '#7a5a1e');
    ctx.fillStyle = '#3a2a10';
    ctx.fillText(lvText, badgeX + 26, y + badgeH / 2 - 2);
    y += rowHeartsH;

    // Hunger bar (coconut icon marks what it's tracking) — hbW stretches with panelW/scale above.
    drawCoconutIcon(ctx, x + 7 * scale, y + barH / 2, 9);
    const hbX = x + 20 * scale, hbW = panelW - innerPad * 2 - 20 * scale;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.roundRect(hbX, y, hbW, barH, barH / 2); ctx.fill();
    const pct = Math.max(0, Math.min(1, state.hunger / hungerMax()));
    ctx.fillStyle = pct > 0.25 ? '#8fd66b' : '#e0663f';
    ctx.beginPath(); ctx.roundRect(hbX, y, hbW * pct, barH, barH / 2); ctx.fill();
    y += rowHungerH;

    // Carry capacity (shell icon + "carried/cap" number, no more per-slot boxes) + currency,
    // sharing one row now that the pip boxes are gone.
    drawShellIcon(ctx, x + 7 * scale, y + 9, 9);
    const cap = hullCap(), carried = carriedTotal();
    const flashOn = state.hullFullFlash > 0 && Math.floor(state.hullFullFlash * 8) % 2 === 0;
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.fillStyle = flashOn ? '#ffdd55' : '#fff';
    ctx.fillText(`${carried}/${cap}`, x + 18 * scale, y + 9);

    drawCoinIcon(ctx, x + 68 * scale, y + 9, 10);
    ctx.font = '700 15px system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(`${state.banked.coins}`, x + 81 * scale, y + 9);
    let carriedTextX = x + 83 * scale + ctx.measureText(`${state.banked.coins}`).width;
    if (state.carried.coins > 0) {
      ctx.font = '500 12px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,221,85,0.85)';
      ctx.fillText(`(+${state.carried.coins})`, carriedTextX, y + 9);
    }

    const cocoX = x + 143 * scale;
    drawCoconutIcon(ctx, cocoX, y + 9, 10);
    ctx.font = '700 15px system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(`${state.banked.coconuts}`, cocoX + 14, y + 9);
    carriedTextX = cocoX + 16 + ctx.measureText(`${state.banked.coconuts}`).width;
    if (state.carried.coconuts > 0) {
      ctx.font = '500 12px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,221,85,0.85)';
      ctx.fillText(`(+${state.carried.coconuts})`, carriedTextX, y + 9);
    }
    y += rowCapH;
    if (state.hullFullFlash > 0) {
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillStyle = '#ffdd55';
      ctx.fillText('Hull full!', x, y + 6);
      y += 18;
    }

    if (state.lastLostMessage) {
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillStyle = '#ffb3a0';
      ctx.fillText(state.lastLostMessage.text, x, y + 6);
    }
    ctx.restore();

    ensureSoundButton();
    ensureLeaveButton();
  }

  // ---- Leave-game button (top right) — bails out to the main menu. A reload is the simplest way
  // to hand the canvas back to intro.js's own state machine (it always boots to BEACH_MENU), rather
  // than teaching game.js how to stop its rAF loop and tearing down its DOM bits by hand.
  let leaveBtn = null;
  function ensureLeaveButton() {
    if (leaveBtn) return;
    leaveBtn = document.createElement('button');
    leaveBtn.id = 'tt-leave-btn';
    leaveBtn.type = 'button';
    leaveBtn.title = 'Leave to main menu';
    leaveBtn.textContent = '✕';
    leaveBtn.addEventListener('click', () => {
      // Mid-trip carried items are already lost on any non-banked exit (see MDD save model), so a
      // reload here is no different from closing the tab — just confirm so a stray tap doesn't eat
      // an in-progress trip.
      if (confirm('Leave to the main menu? Any items carried but not banked will be lost.')) {
        location.reload();
      }
    });
    document.body.appendChild(leaveBtn);
  }

  // Confetti — full-screen DOM overlay, a burst of falling pieces that cleans itself up. CSS
  // (#tt-confetti / .tt-confetti-piece / @keyframes tt-confetti-fall) does the actual animation;
  // this just seeds a random batch of them.
  const CONFETTI_COLORS = ['#ffb347', '#ff5a6e', '#8fd66b', '#5ab4d6', '#ffe066', '#c77dff'];
  function spawnConfetti() {
    const container = document.createElement('div');
    container.id = 'tt-confetti';
    for (let i = 0; i < 90; i++) {
      const piece = document.createElement('div');
      piece.className = 'tt-confetti-piece';
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
      piece.style.width = `${6 + Math.random() * 6}px`;
      piece.style.height = `${10 + Math.random() * 8}px`;
      piece.style.animationDuration = `${2.5 + Math.random() * 2}s`;
      piece.style.animationDelay = `${Math.random() * 0.6}s`;
      container.appendChild(piece);
    }
    document.body.appendChild(container);
    setTimeout(() => container.remove(), 5200);
  }

  // Celebration jingle — a short WebAudio arpeggio, same placeholder-beep approach as intro.js's
  // Sound.* (no music file exists yet), gated by the same mute toggle.
  let celebrationAudioCtx = null;
  function playCelebrationJingle() {
    if (!window.TT_SOUND || !window.TT_SOUND.get()) return;
    if (!celebrationAudioCtx) {
      try { celebrationAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch { return; }
    }
    const ac = celebrationAudioCtx;
    const notes = [523.25, 659.25, 783.99, 1046.50, 1318.51]; // C5 E5 G5 C6 E6
    notes.forEach((freq, i) => {
      const start = ac.currentTime + i * 0.14;
      const osc = ac.createOscillator(), gain = ac.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
      osc.connect(gain); gain.connect(ac.destination);
      osc.start(start); osc.stop(start + 0.5);
    });
  }

  // One-time congrats banner — fires the moment the last upgrade is bought, fades out on its own.
  // (The lasting "Turtle Master" badge itself lives in drawHUD above, replacing the "Lv N" badge.)
  function showCongratsBanner() {
    spawnConfetti();
    playCelebrationJingle();
    const banner = document.createElement('div');
    banner.id = 'tt-congrats-banner';
    banner.textContent = 'Congratulations! You beat the game!';
    document.body.appendChild(banner);
    setTimeout(() => banner.classList.add('tt-fade-out'), 3200);
    setTimeout(() => banner.remove(), 4000);
  }

  // ---- Icon button row (Upgrades / Shop / Day-Night) — DOM overlay in a horizontal row below the
  // canvas HUD panel, touch-friendly and avoids fighting the canvas's own touch-drag joystick
  // handling. TODO: a "collection book" button (shell trophy viewer) and a "hide in shell" button
  // (the level-10 skill) belong in this row too once those features exist — not built yet.
  let iconRow = null;
  function ensureIconRow() {
    if (iconRow) return iconRow;
    iconRow = document.createElement('div');
    iconRow.id = 'tt-icon-row';
    document.body.appendChild(iconRow);
    return iconRow;
  }
  let upgradeBtn = null, upgradePanel = null;
  function ensureUpgradeButton() {
    if (upgradeBtn) return;
    upgradeBtn = document.createElement('button');
    upgradeBtn.id = 'tt-upgrade-btn';
    upgradeBtn.className = 'tt-icon-btn';
    upgradeBtn.type = 'button';
    upgradeBtn.title = 'Upgrades';
    upgradeBtn.innerHTML = '<img src="assets/items/shop_sign.png?v=3" alt="" width="28" height="28">';
    upgradeBtn.addEventListener('click', openUpgradePanel);
    ensureIconRow().appendChild(upgradeBtn);
  }
  function setHomeButtonVisible(visible) {
    ensureUpgradeButton();
    upgradeBtn.style.display = visible ? 'flex' : 'none';
    if (!visible) closeUpgradePanel();
    ensureShopButton();
    if (shopBtn) {
      shopBtn.style.display = visible ? 'flex' : 'none';
      if (!visible) closeShopPanel();
    }
  }
  // Day/Night toggle button — same icon-button pattern as Upgrades above, but shown everywhere (not
  // just at home) once unlocked, since it's a global setting. Ensured (created once, icon kept in
  // sync) from update() below so nothing else has to remember to call it.
  let dayNightBtn = null;
  function updateDayNightButtonLabel() {
    if (dayNightBtn) {
      const src = state.isNight ? 'assets/items/sun_icon.png?v=1' : 'assets/items/moon_icon.png?v=1';
      dayNightBtn.innerHTML = `<img src="${src}" alt="" width="28" height="28">`;
    }
  }
  function ensureDayNightButton() {
    if (!hasSkill('dayNight') || dayNightBtn) return;
    dayNightBtn = document.createElement('button');
    dayNightBtn.id = 'tt-daynight-btn';
    dayNightBtn.className = 'tt-icon-btn';
    dayNightBtn.type = 'button';
    dayNightBtn.title = 'Day / Night';
    dayNightBtn.style.display = 'flex';
    dayNightBtn.addEventListener('click', () => { toggleDayNight(); updateDayNightButtonLabel(); });
    ensureIconRow().appendChild(dayNightBtn);
    updateDayNightButtonLabel();
  }

  // ---- Sound toggle (top-right) — shares the same on/off preference intro.js's mute button reads
  // and writes (window.TT_SOUND, see intro.js) so the setting stays in sync across both screens.
  let soundBtn = null;
  const SOUND_ON_SVG = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M4 10h4l6-5v16l-6-5H4z" fill="#3a2a10"/><path d="M16 9a5 5 0 0 1 0 8" stroke="#2f8fd4" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M18.5 6.5a9 9 0 0 1 0 13" stroke="#2f8fd4" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
  const SOUND_OFF_SVG = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M4 10h4l6-5v16l-6-5H4z" fill="#3a2a10"/><path d="M16 8l7 7M23 8l-7 7" stroke="#d33a3a" stroke-width="2.5" stroke-linecap="round"/></svg>';
  function updateSoundButtonLabel() {
    if (soundBtn) soundBtn.innerHTML = (window.TT_SOUND && window.TT_SOUND.get()) ? SOUND_ON_SVG : SOUND_OFF_SVG;
  }
  function ensureSoundButton() {
    if (soundBtn || !window.TT_SOUND) return;
    soundBtn = document.createElement('button');
    soundBtn.id = 'tt-sound-btn';
    soundBtn.className = 'tt-icon-btn';
    soundBtn.type = 'button';
    soundBtn.title = 'Sound';
    soundBtn.addEventListener('click', () => { window.TT_SOUND.toggle(); updateSoundButtonLabel(); });
    document.body.appendChild(soundBtn);
    updateSoundButtonLabel();
  }

  // ---- Turtle Shop menu (L5 skill) — same DOM-overlay pattern as the upgrade panel, shown only
  // while on the home island (see setHomeButtonVisible above). ----
  const CATEGORY_LABELS = { color: 'Colors', hat: 'Hats', clothes: 'Clothes', accessory: 'Accessories' };
  let shopBtn = null, shopPanel = null, shopActiveCategory = 'color';
  function ensureShopButton() {
    if (shopBtn || !hasSkill('turtleShop')) return;
    shopBtn = document.createElement('button');
    shopBtn.id = 'tt-shop-btn';
    shopBtn.className = 'tt-icon-btn';
    shopBtn.type = 'button';
    shopBtn.title = 'Turtle Shop';
    shopBtn.innerHTML = '<img src="assets/items/clothes_icon.png?v=1" alt="" width="28" height="28">';
    shopBtn.addEventListener('click', openShopPanel);
    ensureIconRow().appendChild(shopBtn);
  }
  function openShopPanel() {
    closeShopPanel();
    const wrap = document.createElement('div');
    wrap.className = 'tt-name-prompt';
    wrap.innerHTML = `<div class="tt-name-box tt-upgrade-box tt-shop-box">
      <div class="tt-shop-header">
        <h3>The Closet</h3>
        <div class="tt-shop-coins"><img src="assets/items/coin.png" alt="">${state.banked.coins}</div>
      </div>
      <canvas class="tt-shop-preview" width="140" height="140"></canvas>
      <div class="tt-shop-tabs">
        ${SHOP_CATEGORIES.map(c => `<button type="button" class="tt-shop-tab" data-cat="${c}">${CATEGORY_LABELS[c]}</button>`).join('')}
      </div>
      <div class="tt-shop-items"></div>
      <div class="tt-name-actions"><button type="button" class="tt-cancel tt-shop-close">Close</button></div>
    </div>`;
    document.body.appendChild(wrap);
    shopPanel = wrap;
    wrap.querySelectorAll('.tt-shop-tab').forEach(btn => {
      btn.addEventListener('click', () => { shopActiveCategory = btn.dataset.cat; renderShopItems(); });
    });
    wrap.querySelector('.tt-shop-close').addEventListener('click', closeShopPanel);
    renderShopItems();
    refreshShopPreview();
  }
  function renderShopItems() {
    if (!shopPanel) return;
    shopPanel.querySelectorAll('.tt-shop-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.cat === shopActiveCategory));
    const container = shopPanel.querySelector('.tt-shop-items');
    container.innerHTML = shopItemsByCategory(shopActiveCategory).map(item => {
      const owned = ownsCosmetic(item.id);
      const equipped = equippedIn(item.category) === item.id;
      const isColor = item.category === 'color';
      let label = `Buy — ${item.cost}`, disabled = state.banked.coins < item.cost;
      if (owned) { label = equipped ? (isColor ? 'Equipped' : 'Unequip') : 'Equip'; disabled = isColor && equipped; }
      return `<div class="tt-upgrade-row">
        ${item.icon ? `<img class="tt-shop-item-icon" src="${item.icon}" alt="">` : ''}
        <div class="tt-upgrade-info">
          <strong>${item.label}</strong>
          <div class="tt-upgrade-detail">${owned ? (equipped ? 'Equipped' : 'Owned') : `${item.cost} coins`}</div>
        </div>
        <button type="button" class="tt-upgrade-buy" data-id="${item.id}" ${disabled ? 'disabled' : ''}>${label}</button>
      </div>`;
    }).join('');
    container.querySelectorAll('.tt-upgrade-buy').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = shopItem(btn.dataset.id);
        if (!ownsCosmetic(item.id)) buyCosmetic(item.id);
        else if (equippedIn(item.category) !== item.id) equipCosmetic(item.id);
        else if (item.category !== 'color') unequipCategory(item.category); // click again to unequip
        const coinEl = shopPanel.querySelector('.tt-shop-coins');
        if (coinEl) coinEl.innerHTML = `<img src="assets/items/coin.png" alt="">${state.banked.coins}`;
        renderShopItems();
        refreshShopPreview();
      });
    });
  }
  // The turtle sprite/draw code lives in game.js — it exposes this one hook so the shop's preview
  // canvas can show the actual equipped combo without duplicating any sprite-rendering logic here.
  function refreshShopPreview() {
    const canvas = shopPanel && shopPanel.querySelector('.tt-shop-preview');
    if (canvas && window.TurtleGame && window.TurtleGame.renderCosmeticPreview) window.TurtleGame.renderCosmeticPreview(canvas);
  }
  function closeShopPanel() {
    if (shopPanel) { shopPanel.remove(); shopPanel = null; }
  }

  function openUpgradePanel() {
    closeUpgradePanel();
    const rows = Object.keys(TRACKS).map(key => {
      const t = TRACKS[key];
      const maxed = t.level() >= t.maxLevel();
      const afford = !maxed && canUpgrade(key);
      return `<div class="tt-upgrade-row tt-shelf-row">
        <img class="tt-upgrade-icon" src="${t.icon}" alt="">
        <div class="tt-upgrade-info">
          <strong>${t.label}${maxed ? '' : `- ${t.next()}`}</strong>
          <div class="tt-upgrade-detail">${maxed ? 'Maxed out' : `${t.cost()} coins`}</div>
        </div>
        <button type="button" class="tt-upgrade-buy" data-track="${key}" ${maxed || !afford ? 'disabled' : ''}>${maxed ? 'Max' : 'Buy'}</button>
      </div>`;
    }).join('');
    const wrap = document.createElement('div');
    wrap.className = 'tt-name-prompt';
    wrap.innerHTML = `<div class="tt-name-box tt-upgrade-box">
      <div class="tt-shop-header">
        <h3>The Shop</h3>
        <div class="tt-shop-coins"><img src="assets/items/coin.png" alt="">${state.banked.coins}</div>
      </div>
      <div class="tt-shelf-bg">${rows}</div>
      <div class="tt-name-actions"><button type="button" class="tt-cancel tt-upgrade-close">Close</button></div>
    </div>`;
    document.body.appendChild(wrap);
    upgradePanel = wrap;
    wrap.querySelectorAll('.tt-upgrade-buy').forEach(btn => {
      btn.addEventListener('click', () => { buyUpgrade(btn.dataset.track); openUpgradePanel(); });
    });
    wrap.querySelector('.tt-upgrade-close').addEventListener('click', closeUpgradePanel);
  }
  function closeUpgradePanel() {
    if (upgradePanel) { upgradePanel.remove(); upgradePanel = null; }
  }

  window.Progression = {
    tryPickup, bankCarried, takeHit, isInvulnerable, setRespawnHandler, setDeathHandler, respawnAtHome,
    update, updateSleep, getSleepConfig, swimSpeedMultiplier, moveSpeedMultiplier, toggleDayNight, drawHUD, setHomeButtonVisible, tryEatFromHud,
    buyUpgrade, canUpgrade,
    attachSlot, getSaveData, persist,
    SKILLS, hasSkill, skillAtLevel, getHomeLevels,
    SHOP_CATEGORIES, ownsCosmetic, equippedIn, getEquippedColorTint, drawEquippedCosmetics,
    state, // read-only-by-convention access (e.g. debug/future HUD tweaks)
  };
})();
