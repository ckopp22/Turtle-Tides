"use strict";

/* =========================================================
   Turtle Tides - core game script
   ========================================================= */

/* ---------- Service worker registration ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

/* ---------- Save Manager ---------- */
const SAVE_KEY_PREFIX = "turtletides_slot_";
const SOUND_KEY = "turtletides_sound";
const NUM_SLOTS = 4;

const SaveManager = {
  loadSlot(slotId) {
    try {
      const raw = localStorage.getItem(SAVE_KEY_PREFIX + slotId);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },
  saveSlot(slotId, data) {
    try {
      localStorage.setItem(SAVE_KEY_PREFIX + slotId, JSON.stringify(data));
    } catch (e) {}
  },
  newSlotData(slotId) {
    return {
      slotId,
      createdAt: new Date().toISOString(),
      banked: { coconuts: 0, shells: 0 },
      upgrades: { homeLevel: 0, carryCapacityLevel: 0, shellColorId: "natural" },
      lastPlayedAt: new Date().toISOString(),
    };
  },
  getSound() {
    const v = localStorage.getItem(SOUND_KEY);
    return v === null ? true : v === "1";
  },
  setSound(on) {
    localStorage.setItem(SOUND_KEY, on ? "1" : "0");
  },
};

/* ---------- Audio Manager (synthesized, no external files) ---------- */
const AudioManager = (() => {
  let ctx = null;
  let soundOn = SaveManager.getSound();
  let ambientNodes = null;
  let ambientZone = null;

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function tone(freq, duration, type = "sine", gainPeak = 0.18, delay = 0) {
    if (!soundOn) return;
    const c = ensureCtx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, c.currentTime + delay);
    gain.gain.setValueAtTime(0, c.currentTime + delay);
    gain.gain.linearRampToValueAtTime(gainPeak, c.currentTime + delay + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + delay + duration);
    osc.connect(gain).connect(c.destination);
    osc.start(c.currentTime + delay);
    osc.stop(c.currentTime + delay + duration + 0.05);
  }

  function pickup() { tone(880, 0.12, "sine", 0.15); tone(1180, 0.1, "sine", 0.1, 0.05); }
  function bank() { tone(523, 0.15, "triangle", 0.18); tone(659, 0.15, "triangle", 0.16, 0.08); tone(784, 0.22, "triangle", 0.16, 0.16); }
  function caught() { tone(300, 0.25, "sawtooth", 0.14); tone(200, 0.3, "sawtooth", 0.12, 0.12); }
  function upgrade() { tone(660, 0.1, "square", 0.12); tone(880, 0.1, "square", 0.12, 0.09); tone(1100, 0.18, "square", 0.12, 0.18); }
  function uiClick() { tone(500, 0.06, "sine", 0.08); }

  function startAmbient(zone) {
    if (!soundOn) { ambientZone = zone; return; }
    if (ambientZone === zone && ambientNodes) return;
    stopAmbient();
    ambientZone = zone;
    const c = ensureCtx();
    const baseFreq = zone === "woods" ? 90 : 70;
    const osc = c.createOscillator();
    const gain = c.createGain();
    const lfo = c.createOscillator();
    const lfoGain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = baseFreq;
    lfo.frequency.value = zone === "woods" ? 0.6 : 0.15;
    lfoGain.gain.value = zone === "woods" ? 6 : 3;
    lfo.connect(lfoGain).connect(osc.frequency);
    gain.gain.value = 0.025;
    osc.connect(gain).connect(c.destination);
    osc.start();
    lfo.start();
    ambientNodes = { osc, gain, lfo };
  }

  function stopAmbient() {
    if (ambientNodes) {
      try {
        ambientNodes.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
        ambientNodes.osc.stop(ctx.currentTime + 0.3);
        ambientNodes.lfo.stop(ctx.currentTime + 0.3);
      } catch (e) {}
      ambientNodes = null;
    }
  }

  function setSound(on) {
    soundOn = on;
    SaveManager.setSound(on);
    if (!on) stopAmbient();
    else if (ambientZone) startAmbient(ambientZone);
  }

  function isOn() { return soundOn; }
  function unlock() { ensureCtx(); }

  return { pickup, bank, caught, upgrade, uiClick, startAmbient, stopAmbient, setSound, isOn, unlock };
})();

/* ---------- Turtle sprite ---------- */
const turtleSprite = new Image();
turtleSprite.src = "sprites/turtle.png";
const TURTLE_FRAME_SIZE = 64;
const TURTLE_ANIM_FRAMES = 4;

/* ---------- Screen management ---------- */
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

/* ---------- Global runtime state ---------- */
const state = {
  activeSlotId: null,
  save: null,
  turtle: { x: WORLD.home.x, y: WORLD.home.y, hunger: GAME_CONFIG.hungerMax, animT: 0, facing: 1 },
  carried: { coconuts: 0, shells: 0 },
  items: [],
  birdPatrols: [],
  birds: [],
  zone: "beach",
  lastZone: "beach",
  slowed: false,
  camera: { x: 0, y: 0 },
  running: false,
};

function carryCap() {
  const lvl = state.save.upgrades.carryCapacityLevel;
  return GAME_CONFIG.carryCapacityTiers[lvl];
}
function carryTotal() {
  return state.carried.coconuts + state.carried.shells;
}

/* ---------- Slot select screen ---------- */
function renderSlotList() {
  const list = document.getElementById("slot-list");
  list.innerHTML = "";
  for (let i = 1; i <= NUM_SLOTS; i++) {
    const data = SaveManager.loadSlot(i);
    const card = document.createElement("div");
    card.className = "slot-card";
    if (data) {
      card.innerHTML = `<div class="slot-title">Slot ${i}</div>
        <div class="slot-meta">Home Lv ${data.upgrades.homeLevel + 1} &middot; 🐚 ${data.banked.shells} &middot; 🥥 ${data.banked.coconuts}</div>`;
    } else {
      card.innerHTML = `<div class="slot-title">Slot ${i}</div><div class="slot-meta">New Game</div>`;
    }
    card.addEventListener("click", () => {
      AudioManager.unlock();
      AudioManager.uiClick();
      startSlot(i, data);
    });
    list.appendChild(card);
  }
}

function startSlot(slotId, existingData) {
  state.activeSlotId = slotId;
  state.save = existingData || SaveManager.newSlotData(slotId);
  if (!existingData) SaveManager.saveSlot(slotId, state.save);

  state.turtle.x = WORLD.home.x;
  state.turtle.y = WORLD.home.y;
  state.turtle.hunger = GAME_CONFIG.hungerMax;
  state.carried = { coconuts: 0, shells: 0 };
  state.items = generateSpawnPoints();
  state.birdPatrols = generateBirdPatrols(GAME_CONFIG.birdCount);
  state.birds = state.birdPatrols.map((p) => ({
    id: p.id,
    x: p.a.x,
    y: p.a.y,
    target: "b",
    patrol: p,
  }));

  enterGameScreen();
}

/* ---------- Game screen lifecycle ---------- */
function enterGameScreen() {
  showScreen("screen-game");
  resizeCanvas();
  updateHomePromptVisibility();
  updateHUD();
  state.lastZone = null;
  state.running = true;
  if (!rafHandle) rafHandle = requestAnimationFrame(loop);
}

function exitToMenu() {
  state.running = false;
  AudioManager.stopAmbient();
  showScreen("screen-menu");
}

/* ---------- Canvas setup ---------- */
const canvas = document.getElementById("gameCanvas");
const ctx2d = canvas.getContext("2d");

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", () => {
  if (document.getElementById("screen-game").classList.contains("active")) resizeCanvas();
});

/* ---------- Input: keyboard ---------- */
const keys = {};
window.addEventListener("keydown", (e) => { keys[e.key.toLowerCase()] = true; });
window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });

function keyboardVector() {
  let dx = 0, dy = 0;
  if (keys["arrowup"] || keys["w"]) dy -= 1;
  if (keys["arrowdown"] || keys["s"]) dy += 1;
  if (keys["arrowleft"] || keys["a"]) dx -= 1;
  if (keys["arrowright"] || keys["d"]) dx += 1;
  const len = Math.hypot(dx, dy);
  if (len > 0) { dx /= len; dy /= len; }
  return { x: dx, y: dy };
}

/* ---------- Input: virtual joystick ---------- */
const joystickZone = document.getElementById("joystick-zone");
const joystickBase = document.getElementById("joystick-base");
const joystickThumb = document.getElementById("joystick-thumb");
let joystickVec = { x: 0, y: 0 };
let joystickActive = false;
let joystickOrigin = { x: 0, y: 0 };
const JOY_RADIUS = 55;

function joystickStart(clientX, clientY) {
  joystickActive = true;
  joystickOrigin = { x: clientX, y: clientY };
  joystickBase.style.display = "block";
  joystickBase.style.left = clientX - 55 + "px";
  joystickBase.style.top = clientY - 55 + "px";
  joystickThumb.style.left = "30px";
  joystickThumb.style.top = "30px";
}
function joystickMove(clientX, clientY) {
  if (!joystickActive) return;
  let dx = clientX - joystickOrigin.x;
  let dy = clientY - joystickOrigin.y;
  const dist = Math.hypot(dx, dy);
  const clamped = Math.min(dist, JOY_RADIUS);
  const angle = Math.atan2(dy, dx);
  const tx = Math.cos(angle) * clamped;
  const ty = Math.sin(angle) * clamped;
  joystickThumb.style.left = 30 + tx + "px";
  joystickThumb.style.top = 30 + ty + "px";
  joystickVec = dist > 4 ? { x: dx / (dist || 1), y: dy / (dist || 1) } : { x: 0, y: 0 };
}
function joystickEnd() {
  joystickActive = false;
  joystickVec = { x: 0, y: 0 };
  joystickBase.style.display = "none";
}

joystickZone.addEventListener("touchstart", (e) => {
  const t = e.changedTouches[0];
  joystickStart(t.clientX, t.clientY);
  AudioManager.unlock();
  e.preventDefault();
}, { passive: false });
joystickZone.addEventListener("touchmove", (e) => {
  const t = e.changedTouches[0];
  joystickMove(t.clientX, t.clientY);
  e.preventDefault();
}, { passive: false });
joystickZone.addEventListener("touchend", (e) => { joystickEnd(); e.preventDefault(); }, { passive: false });
joystickZone.addEventListener("touchcancel", (e) => { joystickEnd(); e.preventDefault(); }, { passive: false });

// Mouse fallback for desktop testing of the joystick zone
let mouseJoyDown = false;
joystickZone.addEventListener("mousedown", (e) => { mouseJoyDown = true; joystickStart(e.clientX, e.clientY); });
window.addEventListener("mousemove", (e) => { if (mouseJoyDown) joystickMove(e.clientX, e.clientY); });
window.addEventListener("mouseup", () => { if (mouseJoyDown) { mouseJoyDown = false; joystickEnd(); } });

function inputVector() {
  const kb = keyboardVector();
  if (kb.x !== 0 || kb.y !== 0) return kb;
  return joystickVec;
}

/* ---------- Zone banner ---------- */
const zoneBanner = document.getElementById("zone-banner");
let bannerTimeout = null;
function flashZoneBanner(zone) {
  zoneBanner.textContent = zone === "woods" ? "🌳 Entering the Woods — birds ahead" : "🏖️ Back on the safe beach";
  zoneBanner.classList.add("show");
  clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => zoneBanner.classList.remove("show"), 2200);
}

/* ---------- HUD ---------- */
function updateHUD() {
  document.getElementById("hud-carry").textContent = `🎒 ${carryTotal()} / ${carryCap()}`;
  document.getElementById("hud-banked").textContent = `🥥 ${state.save.banked.coconuts}   🐚 ${state.save.banked.shells}`;
  const pct = Math.max(0, Math.min(100, (state.turtle.hunger / GAME_CONFIG.hungerMax) * 100));
  const fill = document.getElementById("hunger-fill");
  fill.style.width = pct + "%";
  fill.style.background = pct < 25
    ? "linear-gradient(90deg, #D96B5B, #E8A67E)"
    : "linear-gradient(90deg, #4C9A5B, #8FD08F)";
  const soundBtnGame = document.getElementById("btn-sound-game");
  soundBtnGame.textContent = AudioManager.isOn() ? "🔊" : "🔇";
  document.getElementById("btn-sound-menu").textContent = AudioManager.isOn() ? "🔊" : "🔇";
}

function updateHomePromptVisibility() {
  const prompt = document.getElementById("home-prompt");
  const inHome = distToHome(state.turtle.x, state.turtle.y) < GAME_CONFIG.homeRadius;
  prompt.classList.toggle("hidden", !inHome);
}

function distToHome(x, y) {
  return Math.hypot(x - WORLD.home.x, y - WORLD.home.y);
}

/* ---------- Banking ---------- */
function bankCarried() {
  if (carryTotal() === 0) return;
  state.save.banked.coconuts += state.carried.coconuts;
  state.save.banked.shells += state.carried.shells;
  state.carried = { coconuts: 0, shells: 0 };
  state.save.lastPlayedAt = new Date().toISOString();
  SaveManager.saveSlot(state.activeSlotId, state.save);
  AudioManager.bank();
  updateHUD();
}

/* ---------- Respawn on bird catch ---------- */
function triggerCatch() {
  state.running = false;
  AudioManager.caught();
  const overlay = document.getElementById("respawn-overlay");
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => overlay.classList.add("show"));
  setTimeout(() => {
    state.carried = { coconuts: 0, shells: 0 };
    state.turtle.x = WORLD.home.x;
    state.turtle.y = WORLD.home.y + GAME_CONFIG.homeRadius * 0.4;
    state.turtle.hunger = Math.max(state.turtle.hunger, GAME_CONFIG.hungerMax * 0.5);
    overlay.classList.remove("show");
    setTimeout(() => {
      overlay.classList.add("hidden");
      state.running = true;
      updateHUD();
      updateHomePromptVisibility();
    }, 400);
  }, 900);
}

/* ---------- Game loop ---------- */
let rafHandle = null;
let lastTime = performance.now();

function loop(now) {
  rafHandle = requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  if (state.running && document.getElementById("screen-game").classList.contains("active")) {
    update(dt);
    render();
  }
}

function update(dt) {
  const t = state.turtle;
  const vec = inputVector();

  const speedMult = state.slowed ? GAME_CONFIG.slowedSpeedMultiplier : 1;
  const speed = GAME_CONFIG.turtleSpeed * speedMult;

  if (vec.x !== 0 || vec.y !== 0) {
    t.x += vec.x * speed * dt;
    t.y += vec.y * speed * dt;
    t.x = Math.max(20, Math.min(WORLD.width - 20, t.x));
    t.y = Math.max(20, Math.min(WORLD.height - 20, t.y));
    t.animT += dt * 8 * speedMult;
    if (vec.x !== 0) t.facing = vec.x > 0 ? 1 : -1;
  }

  updateHomePromptVisibility();

  // Zone detection
  state.zone = getZone(t.x, t.y);
  if (state.zone !== state.lastZone) {
    if (state.lastZone !== null) flashZoneBanner(state.zone);
    AudioManager.startAmbient(state.zone);
    state.lastZone = state.zone;
  }

  // Hunger drain (only while exploring, i.e. game screen active & not standing at home)
  const atHome = distToHome(t.x, t.y) < GAME_CONFIG.homeRadius;
  if (!atHome) {
    t.hunger -= GAME_CONFIG.hungerDrainPerSecond * dt;
    if (t.hunger <= GAME_CONFIG.hungerSlowThreshold) {
      if (state.carried.coconuts > 0) {
        state.carried.coconuts -= 1;
        t.hunger = GAME_CONFIG.hungerMax;
        state.slowed = false;
        updateHUD();
      } else {
        t.hunger = 0;
        state.slowed = true;
      }
    } else if (t.hunger > GAME_CONFIG.hungerMax * 0.15) {
      state.slowed = false;
    }
  }

  // Item pickup
  if (carryTotal() < carryCap()) {
    for (const item of state.items) {
      if (item.collected) continue;
      const d = Math.hypot(item.x - t.x, item.y - t.y);
      if (d < GAME_CONFIG.turtleRadius + GAME_CONFIG.itemRadius) {
        item.collected = true;
        item.respawnAt = performance.now() + 20000 + Math.random() * 15000;
        if (item.type === "coconut") state.carried.coconuts++;
        else state.carried.shells++;
        AudioManager.pickup();
        updateHUD();
        if (carryTotal() >= carryCap()) break;
      }
    }
  }
  // Item respawn
  const nowMs = performance.now();
  for (const item of state.items) {
    if (item.collected && nowMs >= item.respawnAt) item.collected = false;
  }

  // Bird patrol movement
  for (const bird of state.birds) {
    const target = bird.target === "b" ? bird.patrol.b : bird.patrol.a;
    const dx = target.x - bird.x;
    const dy = target.y - bird.y;
    const d = Math.hypot(dx, dy);
    if (d < 6) {
      bird.target = bird.target === "b" ? "a" : "b";
    } else {
      bird.x += (dx / d) * GAME_CONFIG.birdSpeed * dt;
      bird.y += (dy / d) * GAME_CONFIG.birdSpeed * dt;
    }
  }

  // Bird collision
  for (const bird of state.birds) {
    const d = Math.hypot(bird.x - t.x, bird.y - t.y);
    if (d < GAME_CONFIG.turtleRadius + GAME_CONFIG.birdRadius) {
      triggerCatch();
      return;
    }
  }

  // Banking
  if (atHome && carryTotal() > 0) bankCarried();
}

/* ---------- Rendering ---------- */
function render() {
  const dpr = window.devicePixelRatio || 1;
  const viewW = canvas.width / dpr;
  const viewH = canvas.height / dpr;

  state.camera.x = Math.max(0, Math.min(WORLD.width - viewW, state.turtle.x - viewW / 2));
  state.camera.y = Math.max(0, Math.min(WORLD.height - viewH, state.turtle.y - viewH / 2));

  ctx2d.clearRect(0, 0, viewW, viewH);
  ctx2d.save();
  ctx2d.translate(-state.camera.x, -state.camera.y);

  drawTerrain(viewW, viewH);
  drawHome();
  drawItems();
  drawBirds();
  drawTurtle();

  ctx2d.restore();
}

function drawTerrain(viewW, viewH) {
  // Woods background
  ctx2d.fillStyle = "#3E8557";
  ctx2d.fillRect(0, 0, WORLD.width, WORLD.height);

  // Beach circle around home
  const grad = ctx2d.createRadialGradient(
    WORLD.home.x, WORLD.home.y, GAME_CONFIG.homeRadius,
    WORLD.home.x, WORLD.home.y, WORLD.beachRadius
  );
  grad.addColorStop(0, "#F3E1B5");
  grad.addColorStop(0.85, "#F3E1B5");
  grad.addColorStop(1, "#E3C98C");
  ctx2d.fillStyle = grad;
  ctx2d.beginPath();
  ctx2d.arc(WORLD.home.x, WORLD.home.y, WORLD.beachRadius, 0, Math.PI * 2);
  ctx2d.fill();

  // Tree-line ring marking the boundary
  ctx2d.strokeStyle = "rgba(46, 90, 58, 0.6)";
  ctx2d.lineWidth = 26;
  ctx2d.setLineDash([18, 14]);
  ctx2d.beginPath();
  ctx2d.arc(WORLD.home.x, WORLD.home.y, WORLD.beachRadius, 0, Math.PI * 2);
  ctx2d.stroke();
  ctx2d.setLineDash([]);

  // Water edge around whole island
  ctx2d.strokeStyle = "#2FA6A1";
  ctx2d.lineWidth = 40;
  ctx2d.strokeRect(20, 20, WORLD.width - 40, WORLD.height - 40);
}

function drawHome() {
  const level = state.save.upgrades.homeLevel;
  const baseSize = 34 + level * 8;
  ctx2d.save();
  ctx2d.translate(WORLD.home.x, WORLD.home.y);

  // Rock pile — more rocks & height per level
  const rockCount = 5 + level * 2;
  for (let i = 0; i < rockCount; i++) {
    const angle = (i / rockCount) * Math.PI * 2;
    const r = baseSize * 0.55;
    const rx = Math.cos(angle) * r;
    const ry = Math.sin(angle) * r * 0.6;
    ctx2d.fillStyle = i % 2 === 0 ? "#8B8378" : "#A39B8B";
    ctx2d.beginPath();
    ctx2d.ellipse(rx, ry, baseSize * 0.32, baseSize * 0.26, 0, 0, Math.PI * 2);
    ctx2d.fill();
  }
  ctx2d.fillStyle = "#9C9384";
  ctx2d.beginPath();
  ctx2d.ellipse(0, -baseSize * 0.25, baseSize * 0.5, baseSize * 0.4, 0, 0, Math.PI * 2);
  ctx2d.fill();

  // Small flag/marker that grows fancier with level
  if (level >= 1) {
    ctx2d.fillStyle = "#E8A67E";
    ctx2d.beginPath();
    ctx2d.moveTo(0, -baseSize * 0.7);
    ctx2d.lineTo(18, -baseSize * 0.55);
    ctx2d.lineTo(0, -baseSize * 0.4);
    ctx2d.closePath();
    ctx2d.fill();
  }

  ctx2d.restore();
}

function drawItems() {
  for (const item of state.items) {
    if (item.collected) continue;
    ctx2d.save();
    ctx2d.translate(item.x, item.y);
    if (item.type === "coconut") {
      ctx2d.fillStyle = "#6B4A2F";
      ctx2d.beginPath();
      ctx2d.arc(0, 0, GAME_CONFIG.itemRadius, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.fillStyle = "#8A6440";
      ctx2d.beginPath();
      ctx2d.arc(-3, -3, GAME_CONFIG.itemRadius * 0.4, 0, Math.PI * 2);
      ctx2d.fill();
    } else {
      ctx2d.fillStyle = "#F4E3D3";
      ctx2d.beginPath();
      ctx2d.moveTo(0, -GAME_CONFIG.itemRadius);
      for (let i = 1; i <= 6; i++) {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
        const r = GAME_CONFIG.itemRadius * (i % 2 === 0 ? 1 : 0.6);
        ctx2d.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx2d.closePath();
      ctx2d.fill();
      ctx2d.strokeStyle = "#D9A97E";
      ctx2d.lineWidth = 1.5;
      ctx2d.stroke();
    }
    ctx2d.restore();
  }
}

function drawBirds() {
  for (const bird of state.birds) {
    ctx2d.save();
    ctx2d.translate(bird.x, bird.y);
    ctx2d.fillStyle = "#3A3A3A";
    ctx2d.beginPath();
    ctx2d.ellipse(0, 0, GAME_CONFIG.birdRadius, GAME_CONFIG.birdRadius * 0.6, 0, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.fillStyle = "#5A5A5A";
    ctx2d.beginPath();
    ctx2d.moveTo(-GAME_CONFIG.birdRadius, 0);
    ctx2d.lineTo(-GAME_CONFIG.birdRadius - 10, -8);
    ctx2d.lineTo(-GAME_CONFIG.birdRadius - 2, 2);
    ctx2d.closePath();
    ctx2d.fill();
    ctx2d.beginPath();
    ctx2d.moveTo(GAME_CONFIG.birdRadius, 0);
    ctx2d.lineTo(GAME_CONFIG.birdRadius + 10, -8);
    ctx2d.lineTo(GAME_CONFIG.birdRadius + 2, 2);
    ctx2d.closePath();
    ctx2d.fill();
    ctx2d.fillStyle = "#E8A64D";
    ctx2d.beginPath();
    ctx2d.moveTo(GAME_CONFIG.birdRadius * 0.7, -2);
    ctx2d.lineTo(GAME_CONFIG.birdRadius * 0.7 + 8, 0);
    ctx2d.lineTo(GAME_CONFIG.birdRadius * 0.7, 3);
    ctx2d.closePath();
    ctx2d.fill();
    ctx2d.restore();
  }
}

function shellColorHue() {
  const id = state.save.upgrades.shellColorId;
  const found = GAME_CONFIG.shellColors.find((c) => c.id === id);
  return found ? found.hue : 0;
}

function drawTurtle() {
  const t = state.turtle;
  const frame = turtleSprite.complete && turtleSprite.naturalWidth
    ? Math.floor(t.animT) % TURTLE_ANIM_FRAMES
    : 0;

  ctx2d.save();
  ctx2d.translate(t.x, t.y);
  if (t.facing < 0) ctx2d.scale(-1, 1);

  if (turtleSprite.complete && turtleSprite.naturalWidth) {
    const hue = shellColorHue();
    if (hue !== 0) ctx2d.filter = `hue-rotate(${hue}deg)`;
    const drawSize = GAME_CONFIG.turtleRadius * 2.4;
    ctx2d.drawImage(
      turtleSprite,
      frame * TURTLE_FRAME_SIZE, 0, TURTLE_FRAME_SIZE, TURTLE_FRAME_SIZE,
      -drawSize / 2, -drawSize / 2, drawSize, drawSize
    );
    if (hue !== 0) ctx2d.filter = "none";
  } else {
    ctx2d.fillStyle = "#4C9A5B";
    ctx2d.beginPath();
    ctx2d.arc(0, 0, GAME_CONFIG.turtleRadius, 0, Math.PI * 2);
    ctx2d.fill();
  }
  ctx2d.restore();

  if (state.slowed) {
    ctx2d.save();
    ctx2d.translate(t.x, t.y - GAME_CONFIG.turtleRadius - 16);
    ctx2d.font = "16px sans-serif";
    ctx2d.textAlign = "center";
    ctx2d.fillText("🥱", 0, 0);
    ctx2d.restore();
  }
}

/* ---------- Home / Upgrade screen ---------- */
function openHomeScreen() {
  AudioManager.uiClick();
  renderHomeScreen();
  showScreen("screen-home");
}

function renderHomeScreen() {
  const save = state.save;
  const homeLevel = save.upgrades.homeLevel;
  const capLevel = save.upgrades.carryCapacityLevel;

  document.getElementById("home-level-label").textContent = homeLevel + 1;
  document.getElementById("home-banked-label").textContent = `🥥 ${save.banked.coconuts}   🐚 ${save.banked.shells}`;
  document.getElementById("home-visual").textContent = "🪨".repeat(Math.min(6, 2 + homeLevel));

  // Home level upgrade
  const homeMaxLevel = GAME_CONFIG.homeLevelCosts.length - 1;
  const homeBtn = document.getElementById("btn-upgrade-home");
  const homeDesc = document.getElementById("upgrade-home-desc");
  if (homeLevel >= homeMaxLevel) {
    homeDesc.textContent = `Max level reached (Level ${homeLevel + 1}).`;
    homeBtn.textContent = "Maxed";
    homeBtn.disabled = true;
  } else {
    const cost = GAME_CONFIG.homeLevelCosts[homeLevel + 1];
    homeDesc.textContent = `Level ${homeLevel + 1} → ${homeLevel + 2}`;
    homeBtn.textContent = `Upgrade — 🐚 ${cost}`;
    homeBtn.disabled = save.banked.shells < cost;
  }
  homeBtn.onclick = () => {
    const cost = GAME_CONFIG.homeLevelCosts[homeLevel + 1];
    if (save.banked.shells >= cost && homeLevel < homeMaxLevel) {
      save.banked.shells -= cost;
      save.upgrades.homeLevel += 1;
      SaveManager.saveSlot(state.activeSlotId, save);
      AudioManager.upgrade();
      renderHomeScreen();
      updateHUD();
    }
  };

  // Carry capacity upgrade
  const capMaxLevel = GAME_CONFIG.carryCapacityTiers.length - 1;
  const capBtn = document.getElementById("btn-upgrade-capacity");
  const capDesc = document.getElementById("upgrade-capacity-desc");
  if (capLevel >= capMaxLevel) {
    capDesc.textContent = `Max capacity reached (${GAME_CONFIG.carryCapacityTiers[capLevel]} items).`;
    capBtn.textContent = "Maxed";
    capBtn.disabled = true;
  } else {
    const cost = GAME_CONFIG.homeLevelCosts[Math.min(capLevel + 1, GAME_CONFIG.homeLevelCosts.length - 1)];
    capDesc.textContent = `${GAME_CONFIG.carryCapacityTiers[capLevel]} → ${GAME_CONFIG.carryCapacityTiers[capLevel + 1]} items`;
    capBtn.textContent = `Upgrade — 🐚 ${cost}`;
    capBtn.disabled = save.banked.shells < cost;
  }
  capBtn.onclick = () => {
    const cost = GAME_CONFIG.homeLevelCosts[Math.min(capLevel + 1, GAME_CONFIG.homeLevelCosts.length - 1)];
    if (save.banked.shells >= cost && capLevel < capMaxLevel) {
      save.banked.shells -= cost;
      save.upgrades.carryCapacityLevel += 1;
      SaveManager.saveSlot(state.activeSlotId, save);
      AudioManager.upgrade();
      renderHomeScreen();
      updateHUD();
    }
  };

  // Shell color swatches
  const swatchWrap = document.getElementById("shell-color-swatches");
  swatchWrap.innerHTML = "";
  GAME_CONFIG.shellColors.forEach((color, idx) => {
    const cost = GAME_CONFIG.shellColorCosts[idx];
    const isUnlocked = color.id === "natural" || (save.unlockedColors || []).includes(color.id);
    const el = document.createElement("div");
    el.className = "swatch" + (isUnlocked ? "" : " locked") + (save.upgrades.shellColorId === color.id ? " selected" : "");
    el.style.background = color.id === "natural" ? "#A9643B" : `hsl(${color.hue}, 55%, 55%)`;
    el.title = isUnlocked ? color.label : `${color.label} — 🐚 ${cost}`;
    el.textContent = isUnlocked ? "" : "🔒";
    el.addEventListener("click", () => {
      if (isUnlocked) {
        save.upgrades.shellColorId = color.id;
        SaveManager.saveSlot(state.activeSlotId, save);
        AudioManager.uiClick();
        renderHomeScreen();
      } else if (save.banked.shells >= cost) {
        save.banked.shells -= cost;
        save.unlockedColors = save.unlockedColors || [];
        save.unlockedColors.push(color.id);
        save.upgrades.shellColorId = color.id;
        SaveManager.saveSlot(state.activeSlotId, save);
        AudioManager.upgrade();
        renderHomeScreen();
        updateHUD();
      }
    });
    swatchWrap.appendChild(el);
  });
}

/* ---------- Button wiring ---------- */
document.getElementById("btn-play").addEventListener("click", () => {
  AudioManager.unlock();
  AudioManager.uiClick();
  renderSlotList();
  showScreen("screen-slots");
});
document.getElementById("btn-howto").addEventListener("click", () => {
  AudioManager.uiClick();
  showScreen("screen-howto");
});
document.getElementById("btn-howto-back").addEventListener("click", () => {
  AudioManager.uiClick();
  showScreen("screen-menu");
});
document.getElementById("btn-slots-back").addEventListener("click", () => {
  AudioManager.uiClick();
  showScreen("screen-menu");
});
document.getElementById("btn-sound-menu").addEventListener("click", () => {
  AudioManager.unlock();
  AudioManager.setSound(!AudioManager.isOn());
  updateHUD();
});
document.getElementById("btn-sound-game").addEventListener("click", () => {
  AudioManager.setSound(!AudioManager.isOn());
  updateHUD();
});
document.getElementById("btn-menu-exit").addEventListener("click", () => {
  AudioManager.uiClick();
  exitToMenu();
});
document.getElementById("btn-open-home").addEventListener("click", openHomeScreen);
document.getElementById("btn-home-close").addEventListener("click", () => {
  AudioManager.uiClick();
  showScreen("screen-game");
  resizeCanvas();
});

/* ---------- Init ---------- */
updateHUD_safeInit();
function updateHUD_safeInit() {
  document.getElementById("btn-sound-menu").textContent = AudioManager.isOn() ? "🔊" : "🔇";
}
