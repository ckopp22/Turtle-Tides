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
      gardenDrainMult: 0.7,        // hunger drain multiplier with the Garden Bed upgrade
      slowMultiplier: 0.55,        // movement speed multiplier while hunger is at 0
      graceSeconds: 8,             // time at 0 hunger before heart loss starts
      heartLossIntervalSeconds: 6, // one heart lost per this many seconds once past the grace period
      starveDimSeconds: 4,         // screen dims over this long before the hunger tick that kills the last heart
      starveDimMax: 0.8,           // dim alpha reached right as that tick lands (the death fade takes over from there)
    },
    hull: {
      capTiers: [3, 5, 10, 15, 20, 25], // index 0 = starting capacity
      upgradeCosts: [10, 50, 95, 175, 280],
    },
    // Home levels = hut upgrades: costs, names and perks live in home.js UPGRADES (TRACKS.home below
    // reads them), and homeLevel = how many are unlocked.
    // Clothes: bought and worn in the hut's closet (home.js) with banked coins, equip freely once owned. One equipped item
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
      moveSpeedTiers: [1.2, 1.4, 1.6], // [Move Speed I, II, III]
    },
    // Finds: the 25 collectibles scattered over the map (replacing the old shell pickup). Listed in
    // the sprite sheet's order (assets/collectibles/items25_spritesheet.png, 5x5 of 64px, row-major),
    // so an item's sheet cell is its index. `tier` sets how often it spawns: a pickup first rolls a tier
    // by `tierWeights`, then picks one item of that tier at random. 10 common / 10 rare / 5 very rare.
    finds: {
      sheet: 'assets/collectibles/items25_spritesheet.png', cell: 64, cols: 5,
      tierWeights: { common: 80, rare: 17, veryRare: 3 },
      items: [
        { id: 'starfish',        name: 'Starfish',          tier: 'common'   },
        { id: 'sand_dollar',     name: 'Sand Dollar',       tier: 'rare'     },
        { id: 'spiral_shell',    name: 'Spiral Shell',      tier: 'rare'     },
        { id: 'oyster_pearl',    name: 'Oyster Pearl',      tier: 'rare'     },
        { id: 'message_bottle',  name: 'Message in a Bottle', tier: 'rare'   },
        { id: 'treasure_map',    name: 'Treasure Map',      tier: 'veryRare' },
        { id: 'driftwood',       name: 'Driftwood',         tier: 'common'   },
        { id: 'kelp',            name: 'Kelp',              tier: 'common'   },
        { id: 'fish',            name: 'Fish',              tier: 'common'   },
        { id: 'coconut_half',    name: 'Coconut Half',      tier: 'common'   },
        { id: 'banana_bunch',    name: 'Banana Bunch',      tier: 'common'   },
        { id: 'pineapple',       name: 'Pineapple',         tier: 'common'   },
        { id: 'palm_leaf',       name: 'Palm Leaf',         tier: 'common'   },
        { id: 'hibiscus',        name: 'Hibiscus',          tier: 'rare'     },
        { id: 'compass',         name: 'Compass',           tier: 'veryRare' },
        { id: 'rope_coil',       name: 'Rope Coil',         tier: 'common'   },
        { id: 'barrel',          name: 'Barrel',            tier: 'rare'     },
        { id: 'treasure_chest',  name: 'Treasure Chest',    tier: 'veryRare' },
        { id: 'blue_gem',        name: 'Blue Gem',          tier: 'veryRare' },
        { id: 'old_key',         name: 'Old Key',           tier: 'veryRare' },
        { id: 'lantern',         name: 'Lantern',           tier: 'rare'     },
        { id: 'shovel',          name: 'Shovel',            tier: 'rare'     },
        { id: 'anchor',          name: 'Anchor',            tier: 'rare'     },
        { id: 'sea_urchin',      name: 'Sea Urchin',        tier: 'rare'     },
        { id: 'seagull_feather', name: 'Seagull Feather',   tier: 'common'   },
      ],
    },
    hideInShell: {
      idleSeconds: 0.5, // standing still this long (toggle on) pulls the turtle into its shell
    },
    invulnSeconds: 1.2,           // blink window after a heart is lost
    hullFullFlashSeconds: 1.4,
    // Carried (unbanked) items are never written to the save (see getSaveData()), so closing the
    // app mid-trip already behaves like this flag = true (loses that trip's haul, same as dying).
    // Flip the persistence in getSaveData()/loadFromSave() if you'd rather keep an in-progress trip.
    loseUnbankedOnClose: true,
  };

  // ---- Skills: each is a feature id unlocked by a hut upgrade (home.js UPGRADES[].unlocks). game.js and
  // this file branch on hasSkill(id): 'sleep', 'moveSpeed1/2', 'swimSpeed1/2', 'dayNight',
  // 'hideInShell', plus 'collectionBook' and 'closet'. ----
  function hasSkill(id) { return !!window.Home && window.Home.hasFeature(id); }

  // ---- Clothes / shell colors (the hut closet sells and equips them) ----
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
    if (window.TT_SOUND) window.TT_SOUND.purchase();
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
    color_coral: '#ff5a3c',
    color_indigo: '#5a3cff',
    color_gold: '#ffc21a',
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
    carried: { coins: 0, coconuts: 0 },
    banked: { coins: 0, coconuts: 0 },
    carriedFinds: [],  // ids of finds picked up this trip (they take hull space; lost on death)
    collection: {},    // find id -> how many have been banked (saved; drives the collection book)
    bookRewards: {},   // collection-book page id -> true once its completion reward has been paid (saved)
    hungerZeroTimer: 0,  // seconds spent at 0 hunger (grace + repeat heart-loss ticking)
    hungerHeartTicks: 0,
    hideOn: false,  // Hide in Shell toggle (hut upgrade perk): shell up whenever the turtle stops moving
    isNight: false, // Day/Night toggle (L7 skill) — game.js eases its sky render toward this target
    cosmetics: {
      owned: ['color_default'],
      equipped: { color: 'color_default', hat: null, clothes: null, accessory: null },
    },
    adventure: { v: 1, chest: null }, // Adventure Zone save block (game.js owns the contents: the treasure chest's spot and respawn timer)
    homeSeenLevel: 0, // home level the player last saw inside the hut (higher = new items to pop in)
    // Lifetime counters for the future collection book's stats page; saved with the slot.
    stats: { coconuts: 0, coins: 0, castles: 0, deaths: 0, playSeconds: 0 },
    invulnTimer: 0,
    hullFullFlash: 0,
    lastLostMessage: null, // { text, timer } shown briefly after a death
    turtleMaster: false, // true once hearts/hull/home are all fully upgraded; persists forever
  };

  function clampLevel(v, max) { v = Number.isFinite(v) ? v : 0; return Math.max(0, Math.min(max, v)); }
  function maxHearts() { return CONFIG.hearts.startMax + state.heartsLevel; }
  function hungerMax() { return CONFIG.hunger.baseMax; }
  function hungerDrainRate() { return CONFIG.hunger.baseDrainPerSecond * (hasSkill('slowHunger') ? CONFIG.hunger.gardenDrainMult : 1); } // garden bed upgrade slows it
  function hullCap() { return CONFIG.hull.capTiers[state.hullLevel]; }
  function carriedTotal() { return state.carried.coins + state.carried.coconuts + state.carriedFinds.length; }

  // ---- Pickup / bank / loss ----
  // Returns false (and flashes the hull-full cue) if the hull has no room; caller should leave the
  // item on the ground in that case rather than consuming it.
  // Picks which find a new pickup is: rolls a tier by CONFIG.finds.tierWeights, then an item of that tier.
  const findsByTier = {};
  for (const it of CONFIG.finds.items) (findsByTier[it.tier] || (findsByTier[it.tier] = [])).push(it);
  function randomFindIndex() {
    const w = CONFIG.finds.tierWeights;
    let total = 0;
    for (const t in w) total += w[t];
    let r = Math.random() * total, tier = 'common';
    for (const t in w) { tier = t; if ((r -= w[t]) < 0) break; }
    const list = findsByTier[tier];
    return CONFIG.finds.items.indexOf(list[Math.floor(Math.random() * list.length)]);
  }
  // `type` is 'coins' | 'coconuts' | 'finds'; for a find, `findIndex` is its index in CONFIG.finds.items.
  function tryPickup(type, findIndex) {
    if (carriedTotal() >= hullCap()) {
      // tryPickup runs every frame while overlapping an item, so only sound off when the flash isn't already running
      if (state.hullFullFlash <= 0 && window.TT_SOUND) window.TT_SOUND.full(CONFIG.hullFullFlashSeconds);
      state.hullFullFlash = CONFIG.hullFullFlashSeconds;
      return false;
    }
    if (type === 'finds') state.carriedFinds.push(CONFIG.finds.items[findIndex].id);
    else state.carried[type]++;
    if (type === 'coins' || type === 'coconuts') state.stats[type]++;
    return true;
  }
  // Treasure-chest reward: coins go straight into the carried stash even past the hull limit (they still have to be
  // carried home and banked, and are lost like any carried item if the turtle is caught).
  function grantCarriedCoins(n) { state.carried.coins += n; state.stats.coins += n; }
  // ---- Stats (lifetime counters for the future collection book) ----
  // Collection-book page reward: pays `coins` into the bank once per page; false if already paid.
  function claimPageReward(pageId, coins) {
    if (state.bookRewards[pageId]) return false;
    state.bookRewards[pageId] = true;
    state.banked.coins += coins;
    persist();
    return true;
  }
  // Straight into the bank (mini game reward).
  function grantBankedCoins(n) { state.banked.coins += n; state.stats.coins += n; persist(); }
  function addStat(key, n = 1) { if (key in state.stats) state.stats[key] += n; }
  function addPlayTime(dt) { state.stats.playSeconds += dt; }
  function bankCarried() {
    if (carriedTotal() === 0) return false;
    state.banked.coins += state.carried.coins;
    state.banked.coconuts += state.carried.coconuts;
    for (const id of state.carriedFinds) state.collection[id] = (state.collection[id] || 0) + 1;
    state.carriedFinds = [];
    state.carried = { coins: 0, coconuts: 0 };
    persist();
    if (window.TT_SOUND) window.TT_SOUND.bank();
    return true;
  }
  // Contents of the last death's loss, for game.js to drop in the world (find ids -> indices into CONFIG.finds.items).
  let lostItems = null;
  function takeLostItems() { const l = lostItems; lostItems = null; return l; }
  function loseCarried() {
    const lost = carriedTotal();
    lostItems = lost ? { coins: state.carried.coins, coconuts: state.carried.coconuts, finds: state.carriedFinds.map(id => CONFIG.finds.items.findIndex(f => f.id === id)) } : null;
    state.carried = { coins: 0, coconuts: 0 };
    state.carriedFinds = [];
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

  let respawnHandler = null, upgradeHandler = null;
  function setUpgradeHandler(fn) { upgradeHandler = fn; } // game.js hooks this to react to purchases (e.g. the Table opening the Adventure Zone)
  function setRespawnHandler(fn) { respawnHandler = fn; } // game.js hooks this to reset turtle.x/y
  // Death sequence hook: game.js plays the fade-out and then calls respawnAtHome() itself. Without a
  // handler, dying respawns instantly like before.
  let deathHandler = null, dying = false, starveDim = 0;
  function setDeathHandler(fn) { deathHandler = fn; }
  function respawnAtHome() {
    dying = false;
    const lost = loseCarried();
    state.hearts = maxHearts();
    state.hunger = hungerMax();
    state.hungerZeroTimer = 0;
    state.hungerHeartTicks = 0;
    state.invulnTimer = 0;
    starveDim = 0;
    if (lost > 0) state.lastLostMessage = { text: `Dropped ${lost} item${lost === 1 ? '' : 's'} where you were caught`, timer: 3 };
    persist();
    if (respawnHandler) respawnHandler();
    return lost;
  }

  // Removes `amount` hearts (default 1), guarded by invulnerability. Called by enemies.js on a landed hit.
  function takeHit(amount = 1) {
    if (state.invulnTimer > 0 || dying) return false;
    state.hearts = Math.max(0, state.hearts - amount);
    state.invulnTimer = CONFIG.invulnSeconds;
    if (window.TT_SOUND) window.TT_SOUND.umph();
    if (state.hearts <= 0) {
      state.stats.deaths++;
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
    ensureHideButton();
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
    // Starving on the last heart: dim ahead of the killing tick so the turtle looks like it's fading out.
    starveDim = 0;
    if (awayFromHome && state.hearts <= 1 && state.hunger <= 0 && state.hungerZeroTimer > 0) {
      const killAt = CONFIG.hunger.graceSeconds + (state.hungerHeartTicks + 1) * CONFIG.hunger.heartLossIntervalSeconds;
      const left = killAt - state.hungerZeroTimer;
      starveDim = CONFIG.hunger.starveDimMax * Math.max(0, Math.min(1, 1 - left / CONFIG.hunger.starveDimSeconds));
    }
    return speedMult;
  }

  // Sleeping in the hut bed (home.js): restores every heart and saves. Hunger is untouched.
  function restoreHearts() {
    state.hearts = maxHearts();
    persist();
  }

  // ---- Day/Night toggle (L7 skill) — game.js owns the actual fade/render, this just holds and
  // persists the player's last chosen setting per save slot. ----
  function toggleDayNight() {
    if (!hasSkill('dayNight')) return;
    state.isNight = !state.isNight;
    persist();
  }

  // ---- Hide in Shell toggle: game.js pulls the turtle into its shell after it has stood still for
  // CONFIG.hideInShell.idleSeconds while this is on; any movement input brings it back out. A hidden
  // turtle takes no enemy damage (game.js's takeHit wrapper for enemies checks it). ----
  function toggleHide() {
    if (!hasSkill('hideInShell')) return;
    state.hideOn = !state.hideOn;
    persist();
  }
  function getHideConfig() { return CONFIG.hideInShell; }

  // ---- Speed skills (game.js multiplies these into its water/land speed calc each frame) ----
  function swimSpeedMultiplier() {
    if (hasSkill('swimSpeed2')) return CONFIG.speed.swimSpeedTiers[1];
    if (hasSkill('swimSpeed1')) return CONFIG.speed.swimSpeedTiers[0];
    return 1;
  }
  function moveSpeedMultiplier() {
    if (hasSkill('moveSpeed3')) return CONFIG.speed.moveSpeedTiers[2];
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
      label: 'Home', icon: 'assets/items/home_icon.png', level: () => state.homeLevel, maxLevel: () => window.Home.UPGRADES.length,
      cost: () => window.Home.UPGRADES[state.homeLevel].cost,
      next: () => window.Home.UPGRADES[state.homeLevel].name,
      note: () => window.Home.UPGRADES[state.homeLevel].perk, // shown under the name in the shop row
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
    if (upgradeHandler) upgradeHandler(track);
    if (!state.turtleMaster && allUpgradesMaxed()) {
      state.turtleMaster = true;
      showCongratsBanner();
    }
    persist();
    if (window.TT_SOUND) window.TT_SOUND.purchase();
    return true;
  }

  // ---- Save integration (bridges to intro.js's localStorage slots via window.TT_SAVE) ----
  let activeSlotId = null, migratedHome = false;
  function loadFromSave(data) {
    data = data || {};
    state.heartsLevel = clampLevel(data.heartsLevel, CONFIG.hearts.upgradeCosts.length);
    state.hullLevel = clampLevel(data.hullLevel, CONFIG.hull.capTiers.length - 1);
    // homeLevel = number of hut upgrades unlocked (max Home.UPGRADES.length). Older saves had a 0-20
    // level track (clamped here) or, briefly, a homeItems list (its length is used if higher).
    // homeVersion 2 saves predate the "level 1 = the hut" shift, so every level moves up by one.
    // homeVersion < 4 saves predate the Window (inserted as upgrade 5), so levels >= 5 move up by one.
    const shift = data.homeVersion === 2 && (data.homeLevel || 0) > 0 ? 1 : 0;
    const winShift = lv => (data.homeVersion || 0) < 4 && lv + shift >= 5 ? 1 : 0;
    state.homeLevel = clampLevel(Math.max((data.homeLevel || 0) + shift + winShift(data.homeLevel || 0), Array.isArray(data.homeItems) ? data.homeItems.length : 0), window.Home.UPGRADES.length);
    state.homeSeenLevel = Number.isFinite(data.homeSeenLevel) ? clampLevel(data.homeSeenLevel + shift + winShift(data.homeSeenLevel), state.homeLevel) : state.homeLevel;
    state.banked = {
      coins: data.banked?.coins || 0,
      coconuts: data.banked?.coconuts || 0,
    };
    // homeVersion < 5 saves predate the Table & Stools moving up to upgrade 4 (it used to be 6th, after the Doormat and
    // Window). Levels 6+ own the same set either way; a save at level 4 or 5 owned the Doormat (and Window) but not the table,
    // so it drops back to level 3 and gets those two purchases refunded at the prices it paid (Doormat 30, Window 40).
    migratedHome = false;
    if ((data.homeVersion || 0) < 5) {
      const OLD_REFUND = { 4: 30, 5: 70 }; // levels owning Doormat / Doormat + Window
      if (OLD_REFUND[state.homeLevel]) { state.banked.coins += OLD_REFUND[state.homeLevel]; state.homeLevel = 3; migratedHome = true; }
      if (state.homeSeenLevel === 4 || state.homeSeenLevel === 5) state.homeSeenLevel = 3;
      state.homeSeenLevel = Math.min(state.homeSeenLevel, state.homeLevel);
    }
    // homeVersion < 6 saves predate Goggles (inserted as upgrade 5, after the Table & Stools), so levels >= 4 move up by one.
    if ((data.homeVersion || 0) < 6) {
      const max = window.Home.UPGRADES.length;
      if (state.homeLevel >= 4) state.homeLevel = Math.min(state.homeLevel + 1, max);
      if (state.homeSeenLevel >= 4) state.homeSeenLevel = Math.min(state.homeSeenLevel + 1, state.homeLevel);
    }
    // Finds banked so far (old saves' shell trophies are dropped: they had no types).
    state.bookRewards = {};
    for (const k in (data.bookRewards || {})) if (data.bookRewards[k] === true) state.bookRewards[k] = true;
    state.collection = {};
    const col = data.collection || {};
    for (const it of CONFIG.finds.items) if (Number.isFinite(col[it.id]) && col[it.id] > 0) state.collection[it.id] = Math.floor(col[it.id]);
    // Adventure Zone block (v1): { chest: { on, x, y, left } } — absent on older saves.
    const adv = data.adventure && typeof data.adventure === 'object' ? data.adventure : {}, ch = adv.chest;
    state.adventure = { v: 1, chest: ch && typeof ch === 'object' && Number.isFinite(ch.left) ? {
      on: ch.on === true && Number.isFinite(ch.x) && Number.isFinite(ch.y), x: Number(ch.x) || 0, y: Number(ch.y) || 0, left: Math.max(0, Math.min(3600, ch.left)),
    } : null };
    state.hideOn = data.hideOn === true;
    state.isNight = typeof data.isNight === 'boolean' ? data.isNight : false; // missing on old saves -> default day
    if (migratedHome) state.isNight = false; // the Window (Day/Night) was refunded by the home-order migration
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
    // Stats: absent on old saves -> zeroed counters.
    const st = data.stats || {};
    state.stats = {};
    for (const k of ['coconuts', 'coins', 'castles', 'deaths', 'playSeconds']) state.stats[k] = Number.isFinite(st[k]) && st[k] > 0 ? st[k] : 0;
    // Never restore carried items from a save — see loseUnbankedOnClose above.
    state.carried = { coins: 0, coconuts: 0 };
    state.carriedFinds = [];
    state.hearts = maxHearts();
    state.hunger = hungerMax();
    state.hungerZeroTimer = 0;
    state.hungerHeartTicks = 0;
    state.invulnTimer = 0;
    state.hullFullFlash = 0;
    state.lastLostMessage = null;
    // Old saves have no `turtleMaster` field — fall back to re-deriving it from upgrade levels
    // (loadFromSave above already set heartsLevel/hullLevel/homeLevel) so it isn't lost.
    state.turtleMaster = typeof data.turtleMaster === 'boolean' ? data.turtleMaster : allUpgradesMaxed();
    // Test shortcut: ?master=1 maxes every upgrade (saved with the slot on the next persist).
    // On localhost it's on by default; ?master=0 turns it off there.
    const masterParam = new URLSearchParams(location.search).get('master');
    if (masterParam === '1' || (masterParam !== '0' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname))) {
      state.heartsLevel = CONFIG.hearts.upgradeCosts.length;
      state.hullLevel = CONFIG.hull.capTiers.length - 1;
      state.homeLevel = window.Home.UPGRADES.length;
      state.homeSeenLevel = state.homeLevel;
      state.hearts = maxHearts();
      state.turtleMaster = true;
    }
  }
  function getSaveData() {
    return {
      heartsLevel: state.heartsLevel,
      hullLevel: state.hullLevel,
      homeLevel: state.homeLevel,
      banked: { ...state.banked },
      collection: { ...state.collection },
      bookRewards: { ...state.bookRewards },
      isNight: state.isNight,
      hideOn: state.hideOn,
      adventure: { v: 1, chest: state.adventure.chest ? { ...state.adventure.chest } : null },
      cosmetics: { owned: state.cosmetics.owned.slice(), equipped: { ...state.cosmetics.equipped } },
      turtleMaster: state.turtleMaster,
      homeVersion: 6, // 6 = Goggles inserted at upgrade 5; 5 = Table & Stools moved to upgrade 4 (opens the Adventure Zone); 4 = Window inserted at upgrade 5; 3 = homeLevel 0 is nothing, 1 is the hut, then its upgrades (2 = no hut step); bump if the save shape changes (loads tolerate it missing)
      homeSeenLevel: state.homeSeenLevel,
      stats: { ...state.stats },
    };
  }
  function attachSlot(slotId, existingData) {
    activeSlotId = slotId;
    loadFromSave(existingData);
    if (migratedHome) persist(); // write the refund + new level back now so a second load can't refund it again
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
  // Top safe-area inset in CSS px (0 on desktop / non-notched), measured via a hidden probe.
  let insetProbe = null;
  function topInset() {
    if (!insetProbe) {
      insetProbe = document.createElement('div');
      insetProbe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top)';
      document.body.appendChild(insetProbe);
    }
    return insetProbe.offsetHeight;
  }

  // Canvas height in CSS px. In an iOS home-screen app innerHeight / 100% stop short of the bottom
  // (home-indicator area), so use the physical screen size there; in a browser tab use the real viewport.
  function fullViewH(canvas) {
    const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    let h = window.innerHeight;
    if (standalone) {
      const portrait = window.innerHeight >= window.innerWidth;
      h = Math.max(h, portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height));
    }
    if (standalone) document.documentElement.style.setProperty('--full-h', h + 'px');
    canvas.style.height = standalone ? h + 'px' : '';
    return h;
  }

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

    const safeTop = topInset();
    ctx.save();
    ctx.translate(0, safeTop); // app runs under the status bar/notch; keep the HUD below it
    ctx.textBaseline = 'middle';

    ctx.fillStyle = 'rgba(9, 46, 61, 0.82)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(pad, pad, panelW, contentH, 16); ctx.fill(); ctx.stroke();
    hudPanelRect = { x: pad, y: pad + safeTop, w: panelW, h: contentH };

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
  }
  // Hide in Shell toggle button — same row as Day/Night, shown everywhere once the perk is unlocked.
  // Lit (green) while on. Created once from update(), like the Day/Night button above.
  let hideBtn = null;
  function updateHideButtonLabel() {
    if (!hideBtn) return;
    hideBtn.classList.toggle('tt-on', state.hideOn);
    hideBtn.title = `Hide in Shell: ${state.hideOn ? 'on' : 'off'}`;
    hideBtn.setAttribute('aria-pressed', state.hideOn ? 'true' : 'false');
  }
  function ensureHideButton() {
    if (!hasSkill('hideInShell') || hideBtn) return;
    hideBtn = document.createElement('button');
    hideBtn.id = 'tt-hide-btn';
    hideBtn.className = 'tt-icon-btn';
    hideBtn.type = 'button';
    hideBtn.innerHTML = '<span class="tt-shell-icon"></span>';
    hideBtn.style.display = 'flex';
    hideBtn.addEventListener('click', () => { toggleHide(); updateHideButtonLabel(); });
    ensureIconRow().appendChild(hideBtn);
    updateHideButtonLabel();
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
    ensureMusicButton();
  }

  // ---- Music toggle (top-right, left of the sound toggle) — mutes just the background music.
  let musicBtn = null;
  const MUSIC_ON_SVG = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M10 19V6l11-2v13" stroke="#3a2a10" stroke-width="2" fill="none" stroke-linejoin="round"/><ellipse cx="7.5" cy="19" rx="3" ry="2.3" fill="#3a2a10"/><ellipse cx="18.5" cy="17" rx="3" ry="2.3" fill="#3a2a10"/></svg>';
  const MUSIC_OFF_SVG = MUSIC_ON_SVG.replace('</svg>', '<path d="M3 23L23 3" stroke="#d33a3a" stroke-width="2.5" stroke-linecap="round"/></svg>');
  function updateMusicButtonLabel() {
    if (musicBtn) musicBtn.innerHTML = (window.TT_SOUND && window.TT_SOUND.musicGet()) ? MUSIC_ON_SVG : MUSIC_OFF_SVG;
  }
  function ensureMusicButton() {
    if (musicBtn || !window.TT_SOUND) return;
    musicBtn = document.createElement('button');
    musicBtn.id = 'tt-music-btn';
    musicBtn.className = 'tt-icon-btn';
    musicBtn.type = 'button';
    musicBtn.title = 'Music';
    musicBtn.addEventListener('click', () => { window.TT_SOUND.musicToggle(); updateMusicButtonLabel(); });
    document.body.appendChild(musicBtn);
    updateMusicButtonLabel();
  }

  function openUpgradePanel() {
    if (upgradePanel) { upgradePanel.remove(); upgradePanel = null; } // re-render (e.g. after a purchase) must not count as closing the shop
    const rows = Object.keys(TRACKS).map(key => {
      const t = TRACKS[key];
      const maxed = t.level() >= t.maxLevel();
      const afford = !maxed && canUpgrade(key);
      return `<div class="tt-upgrade-row tt-shelf-row">
        <img class="tt-upgrade-icon" src="${t.icon}" alt="">
        <div class="tt-upgrade-info">
          <strong>${t.label}${maxed ? '' : ` - ${t.next()}`}</strong>
          <div class="tt-upgrade-detail">${maxed ? 'Maxed out' : `${t.cost()} coins${t.note ? ` · ${t.note()}` : ''}`}</div>
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
    wrap.addEventListener('click', e => { if (e.target === wrap) closeUpgradePanel(); }); // click outside the box closes
  }
  function closeUpgradePanel() {
    if (upgradePanel) { upgradePanel.remove(); upgradePanel = null; if (window.Home) window.Home.refreshInterior(); } // indoors: new hut items pop in as the shop closes
  }

  window.Progression = {
    tryPickup, grantCarriedCoins, bankCarried, takeLostItems, takeHit, getStarveDim: () => starveDim, isInvulnerable, setRespawnHandler, setUpgradeHandler, setDeathHandler, respawnAtHome,
    update, restoreHearts, maxHearts, getHideConfig, swimSpeedMultiplier, moveSpeedMultiplier, toggleDayNight, drawHUD, setHomeButtonVisible, tryEatFromHud, getIconRow: ensureIconRow,
    topInset, fullViewH, buyUpgrade, canUpgrade, addStat, addPlayTime, claimPageReward, grantBankedCoins,
    attachSlot, getSaveData, persist,
    hasSkill, FINDS: CONFIG.finds, randomFindIndex,
    SHOP_CATEGORIES, getShopItems: () => CONFIG.shop.items, buyCosmetic, equipCosmetic, unequipCategory, ownsCosmetic, equippedIn, getEquippedColorTint, drawEquippedCosmetics,
    state, // read-only-by-convention access (e.g. debug/future HUD tweaks)
  };
})();
