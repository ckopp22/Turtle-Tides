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
      upgradeCosts: [40, 90, 160, 260],
    },
    hunger: {
      baseMax: 100,
      baseDrainPerSecond: 1.2,     // only drains away from the home island (MDD s4)
      slowMultiplier: 0.55,        // movement speed multiplier while hunger is at 0
      graceSeconds: 8,             // time at 0 hunger before heart loss starts
      heartLossIntervalSeconds: 6, // one heart lost per this many seconds once past the grace period
      maxBonusPerLevel: 40,        // + max hunger per upgrade level
      drainMultPerLevel: 0.85,     // drain rate *= this per upgrade level (slower drain)
      upgradeCosts: [30, 70, 130, 220],
    },
    hull: {
      capTiers: [3, 5, 8, 12, 18], // index 0 = starting capacity
      upgradeCosts: [25, 60, 120, 220],
    },
    home: {
      // Stubbed per current scope: only the first few milestones are filled in.
      // TODO: fill levels 4-19 (books, torches, ... full camp at 20) with real art.
      // TODO: level 10 reserves the "Hide in Shell" skill (unlockedSkill below) — data slot only,
      // not wired to gameplay yet. The turtle sprite sheet already has a shell pose (game.js's
      // state === 'shell') that skill can reuse later.
      levels: [
        { cost: 0,   desc: 'a pile of rocks',                  shape: 'rocks' },
        { cost: 20,  desc: 'a woven nest tucked in the rocks',  shape: 'nest' },
        { cost: 50,  desc: 'a small driftwood hut',             shape: 'hut' },
        { cost: 100, desc: 'a hut with a crackling campfire',   shape: 'campfire', unlockedSkill: null },
      ],
    },
    invulnSeconds: 1.2,           // blink window after a heart is lost
    hullFullFlashSeconds: 1.4,
    // Carried (unbanked) items are never written to the save (see getSaveData()), so closing the
    // app mid-trip already behaves like this flag = true (loses that trip's haul, same as dying).
    // Flip the persistence in getSaveData()/loadFromSave() if you'd rather keep an in-progress trip.
    loseUnbankedOnClose: true,
  };

  const state = {
    hearts: CONFIG.hearts.startMax,
    heartsLevel: 0,
    hungerLevel: 0,
    hunger: CONFIG.hunger.baseMax,
    hullLevel: 0,
    homeLevel: 0,
    carried: { coins: 0, coconuts: 0, shells: 0 },
    banked: { coins: 0, coconuts: 0, shells: 0 },
    shellCollection: [], // banked shell trophies; TODO: shell variety/color once that system exists
    hungerZeroTimer: 0,  // seconds spent at 0 hunger (grace + repeat heart-loss ticking)
    hungerHeartTicks: 0,
    invulnTimer: 0,
    hullFullFlash: 0,
    lastLostMessage: null, // { text, timer } shown briefly after a death
  };

  function clampLevel(v, max) { v = Number.isFinite(v) ? v : 0; return Math.max(0, Math.min(max, v)); }
  function maxHearts() { return CONFIG.hearts.startMax + state.heartsLevel; }
  function hungerMax() { return CONFIG.hunger.baseMax + state.hungerLevel * CONFIG.hunger.maxBonusPerLevel; }
  function hungerDrainRate() { return CONFIG.hunger.baseDrainPerSecond * Math.pow(CONFIG.hunger.drainMultPerLevel, state.hungerLevel); }
  function hullCap() { return CONFIG.hull.capTiers[state.hullLevel]; }
  function carriedTotal() { return state.carried.coins + state.carried.coconuts + state.carried.shells; }
  function homeLevelDef() { return CONFIG.home.levels[Math.min(state.homeLevel, CONFIG.home.levels.length - 1)]; }

  // ---- Pickup / bank / loss ----
  // Returns false (and flashes the hull-full cue) if the hull has no room; caller should leave the
  // item on the ground in that case rather than consuming it.
  function tryPickup(type) {
    if (carriedTotal() >= hullCap()) { state.hullFullFlash = CONFIG.hullFullFlashSeconds; return false; }
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

  let respawnHandler = null;
  function setRespawnHandler(fn) { respawnHandler = fn; } // game.js hooks this to reset turtle.x/y
  function respawnAtHome() {
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
    if (state.invulnTimer > 0) return false;
    state.hearts = Math.max(0, state.hearts - 1);
    state.invulnTimer = CONFIG.invulnSeconds;
    if (state.hearts <= 0) { respawnAtHome(); return true; }
    return false;
  }
  function isInvulnerable() { return state.invulnTimer > 0; }

  // Called by game.js every frame. `awayFromHome` gates both hunger drain and the hunger penalty
  // (safe on the home island, same as birds never spawning there). Returns a speed multiplier
  // game.js multiplies into its own water/land speed calc.
  function update(dt, awayFromHome) {
    if (state.invulnTimer > 0) state.invulnTimer = Math.max(0, state.invulnTimer - dt);
    if (state.hullFullFlash > 0) state.hullFullFlash = Math.max(0, state.hullFullFlash - dt);
    if (state.lastLostMessage) {
      state.lastLostMessage.timer -= dt;
      if (state.lastLostMessage.timer <= 0) state.lastLostMessage = null;
    }

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

  // ---- Upgrades ----
  const TRACKS = {
    hearts: {
      label: 'Hearts', level: () => state.heartsLevel, maxLevel: () => CONFIG.hearts.upgradeCosts.length,
      cost: () => CONFIG.hearts.upgradeCosts[state.heartsLevel],
      apply: () => { state.heartsLevel++; state.hearts = maxHearts(); },
      currentText: () => `${maxHearts()} heart${maxHearts() === 1 ? '' : 's'}`,
      nextText: () => `${maxHearts() + 1} hearts`,
    },
    hunger: {
      label: 'Hunger', level: () => state.hungerLevel, maxLevel: () => CONFIG.hunger.upgradeCosts.length,
      cost: () => CONFIG.hunger.upgradeCosts[state.hungerLevel],
      apply: () => { state.hungerLevel++; },
      currentText: () => `${hungerMax()} max, slower drain`,
      nextText: () => `${hungerMax() + CONFIG.hunger.maxBonusPerLevel} max, slower drain`,
    },
    hull: {
      label: 'Hull', level: () => state.hullLevel, maxLevel: () => CONFIG.hull.capTiers.length - 1,
      cost: () => CONFIG.hull.upgradeCosts[state.hullLevel],
      apply: () => { state.hullLevel++; },
      currentText: () => `${hullCap()} items`,
      nextText: () => `${CONFIG.hull.capTiers[state.hullLevel + 1]} items`,
    },
    home: {
      label: 'Home', level: () => state.homeLevel, maxLevel: () => CONFIG.home.levels.length - 1,
      cost: () => CONFIG.home.levels[state.homeLevel + 1].cost,
      apply: () => { state.homeLevel++; },
      currentText: () => homeLevelDef().desc,
      nextText: () => CONFIG.home.levels[state.homeLevel + 1].desc,
    },
  };
  function canUpgrade(track) {
    const t = TRACKS[track];
    return t.level() < t.maxLevel() && state.banked.coins >= t.cost();
  }
  function buyUpgrade(track) {
    if (!canUpgrade(track)) return false;
    state.banked.coins -= TRACKS[track].cost();
    TRACKS[track].apply();
    persist();
    return true;
  }

  // ---- Save integration (bridges to intro.js's localStorage slots via window.TT_SAVE) ----
  let activeSlotId = null;
  function loadFromSave(data) {
    data = data || {};
    state.heartsLevel = clampLevel(data.heartsLevel, CONFIG.hearts.upgradeCosts.length);
    state.hungerLevel = clampLevel(data.hungerLevel, CONFIG.hunger.upgradeCosts.length);
    state.hullLevel = clampLevel(data.hullLevel, CONFIG.hull.capTiers.length - 1);
    state.homeLevel = clampLevel(data.homeLevel, CONFIG.home.levels.length - 1);
    state.banked = {
      coins: data.banked?.coins || 0,
      coconuts: data.banked?.coconuts || 0,
      shells: data.banked?.shells || 0,
    };
    state.shellCollection = Array.isArray(data.shellCollection) ? data.shellCollection : [];
    // Never restore carried items from a save — see loseUnbankedOnClose above.
    state.carried = { coins: 0, coconuts: 0, shells: 0 };
    state.hearts = maxHearts();
    state.hunger = hungerMax();
    state.hungerZeroTimer = 0;
    state.hungerHeartTicks = 0;
    state.invulnTimer = 0;
    state.hullFullFlash = 0;
    state.lastLostMessage = null;
  }
  function getSaveData() {
    return {
      heartsLevel: state.heartsLevel,
      hungerLevel: state.hungerLevel,
      hullLevel: state.hullLevel,
      homeLevel: state.homeLevel,
      banked: { ...state.banked },
      shellCollection: state.shellCollection.slice(),
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
  function drawHeart(ctx, cx, cy, r, filled) {
    ctx.fillStyle = filled ? '#ff5a6e' : 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    ctx.moveTo(cx, cy + r * 0.6);
    ctx.bezierCurveTo(cx - r * 1.3, cy - r * 0.6, cx - r * 0.5, cy - r * 1.3, cx, cy - r * 0.4);
    ctx.bezierCurveTo(cx + r * 0.5, cy - r * 1.3, cx + r * 1.3, cy - r * 0.6, cx, cy + r * 0.6);
    ctx.closePath();
    ctx.fill();
  }
  function drawHomeIcon(ctx, cx, cy, r) {
    ctx.fillStyle = '#ffd27a';
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx, cy - r); ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx + r * 0.7, cy); ctx.lineTo(cx + r * 0.7, cy + r * 0.8); ctx.lineTo(cx - r * 0.7, cy + r * 0.8);
    ctx.lineTo(cx - r * 0.7, cy); ctx.closePath();
    ctx.fill();
  }
  // TODO: swap heart/home placeholder shapes and the coin/coconut/shell HUD text for real icon art.
  function drawHUD(ctx) {
    const pad = 14;
    let y = pad;
    ctx.save();
    ctx.textBaseline = 'middle';

    const heartSize = 20, heartGap = 4;
    for (let i = 0; i < maxHearts(); i++) {
      drawHeart(ctx, pad + i * (heartSize + heartGap) + heartSize / 2, y + heartSize / 2, heartSize / 2, i < state.hearts);
    }
    y += heartSize + 8;

    const barW = 130, barH = 10;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.roundRect(pad, y, barW, barH, barH / 2); ctx.fill();
    const pct = Math.max(0, Math.min(1, state.hunger / hungerMax()));
    ctx.fillStyle = pct > 0.25 ? '#8fd66b' : '#e0663f';
    ctx.beginPath(); ctx.roundRect(pad, y, barW * pct, barH, barH / 2); ctx.fill();
    y += barH + 10;

    const flashOn = state.hullFullFlash > 0 && Math.floor(state.hullFullFlash * 8) % 2 === 0;
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.fillStyle = flashOn ? '#ffdd55' : '#fff';
    ctx.fillText(`Hull: ${carriedTotal()}/${hullCap()}`, pad, y + 8);
    y += 20;
    if (state.hullFullFlash > 0) {
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillStyle = '#ffdd55';
      ctx.fillText('Hull full!', pad, y + 6);
      y += 18;
    }

    drawHomeIcon(ctx, pad + 8, y + 8, 8);
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(`Lv ${state.homeLevel}`, pad + 22, y + 8);
    y += 24;

    ctx.font = '500 13px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(`Coins ${state.banked.coins}  Coconuts ${state.banked.coconuts}  Shells ${state.banked.shells}`, pad, y + 6);
    y += 20;

    if (state.lastLostMessage) {
      ctx.font = '600 14px system-ui, sans-serif';
      ctx.fillStyle = '#ffb3a0';
      ctx.fillText(state.lastLostMessage.text, pad, y + 6);
    }
    ctx.restore();
  }

  // ---- Upgrade menu (DOM overlay, same pattern as intro.js's save-name prompt — touch-friendly
  // and avoids fighting the canvas's own touch-drag joystick handling). ----
  let upgradeBtn = null, upgradePanel = null;
  function ensureUpgradeButton() {
    if (upgradeBtn) return;
    upgradeBtn = document.createElement('button');
    upgradeBtn.id = 'tt-upgrade-btn';
    upgradeBtn.type = 'button';
    upgradeBtn.textContent = 'Upgrades';
    upgradeBtn.addEventListener('click', openUpgradePanel);
    document.body.appendChild(upgradeBtn);
  }
  function setHomeButtonVisible(visible) {
    ensureUpgradeButton();
    upgradeBtn.style.display = visible ? 'block' : 'none';
    if (!visible) closeUpgradePanel();
  }
  function openUpgradePanel() {
    closeUpgradePanel();
    const rows = Object.keys(TRACKS).map(key => {
      const t = TRACKS[key];
      const maxed = t.level() >= t.maxLevel();
      const afford = !maxed && canUpgrade(key);
      return `<div class="tt-upgrade-row">
        <div class="tt-upgrade-info">
          <strong>${t.label}</strong>
          <div class="tt-upgrade-detail">Now: ${t.currentText()}</div>
          <div class="tt-upgrade-detail">${maxed ? 'Maxed out' : `Next: ${t.nextText()} — ${t.cost()} coins`}</div>
        </div>
        <button type="button" class="tt-upgrade-buy" data-track="${key}" ${maxed || !afford ? 'disabled' : ''}>${maxed ? 'Max' : 'Buy'}</button>
      </div>`;
    }).join('');
    const wrap = document.createElement('div');
    wrap.className = 'tt-name-prompt';
    wrap.innerHTML = `<div class="tt-name-box tt-upgrade-box">
      <h3>Upgrades — ${state.banked.coins} coins banked</h3>
      ${rows}
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
    tryPickup, bankCarried, takeHit, isInvulnerable, setRespawnHandler,
    update, drawHUD, setHomeButtonVisible,
    buyUpgrade, canUpgrade,
    attachSlot, getSaveData, persist,
    state, // read-only-by-convention access (e.g. debug/future HUD tweaks)
  };
})();
