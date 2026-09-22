# Turtle Tides - Web App MDD

2026-09-22 · @Someone

A calm, beach-themed exploration and collection game starring a turtle who gathers coconuts and shells around their island home, built as a single-page HTML/CSS/JavaScript PWA by Claude Code and deployed via a new GitHub repo with GitHub Pages.

## 1. Overview & Objective

**Working title:** Turtle Tides

**Elevator pitch:** A calm, beach-themed exploration game. You play a turtle whose home is a pile of rocks on the beach. You wander the island collecting coconuts (food) and shells (currency), always weighing how far to push into the risky woods before heading home. Reach home safely and everything you're carrying is banked for good; get caught by a bird out in the woods and you lose whatever you hadn't banked yet.

**Tone:** Relaxed, low-stakes, no combat — the loop is about gathering, gentle risk management, and slowly upgrading your home, not fast reflexes or violence.

**Primary objective (build):** Ship a single, self-contained web app (HTML/CSS/JS, no backend, no build tooling) that Claude Code can generate, commit to a new GitHub repo, and deploy via GitHub Pages. The app must be installable as a PWA with offline play and persistent local save slots.

**Target platform:** Mobile-first responsive web (touch controls), also playable on desktop/laptop browsers (keyboard/mouse).

**Out of scope for v1:** accounts, cloud saves/cross-device sync, multiplayer, backend/database, native app store builds.

## 2. Core Gameplay Loop

1. **Main Menu** — Play, How to Play, Sound On/Off toggle.
2. **Save Slot Select** — Tapping Play shows 4 save slots; empty slots start a fresh game (turtle at home, empty bank, base upgrades), filled slots show a quick preview (home level, banked shells) and resume that save.
3. **Exploring:** the turtle starts at home. The player moves freely around the island, picking up coconuts and shells they walk over into their **carried inventory** (capped by current carry capacity).
4. **Risk management:** the woods (away from home) contain birds; the beach near home does not. The player decides moment-to-moment how far to push into the woods for more items versus turning back before a bird catches them.
5. **Returning home:** walking back onto the home tile **banks** everything currently carried — it's added to the permanent save and can never be lost from that point on. Carried inventory resets to empty, ready for the next trip out.
6. **Upgrading:** while at home, the player can open the Home/Upgrade screen and spend **banked** shells on home level, carry capacity, or shell color (see Section 5).
7. **Getting caught:** if a bird touches the turtle anywhere in the woods, the turtle "dies" (a gentle, non-violent transition, not gore) and respawns instantly back at home. Everything in that trip's carried inventory (not yet banked) is lost; banked inventory is untouched.
8. **No formal end condition:** this is an ongoing collect-and-upgrade loop rather than a game with a win screen — the player can stop at any time and their save persists via the slot system.

## 3. World & Zones

**Layout:** A single, continuous top-down island map (no separate loading screens between areas) made of two zones:

- **Beach / Home zone** — the area immediately around the turtle's rock-pile home. Safe: no birds spawn or patrol here. Coconuts and shells still spawn here, but more sparsely than the woods (a lower-risk, lower-reward area for cautious play).
- **Woods zone** — the interior/far side of the island, denser with coconuts and shells (higher reward), but this is where birds patrol (see Section 6). The boundary between beach and woods should be visually clear (tree line, terrain change) so the player always knows which zone they're in.

**Movement:** Continuous, free-roam 2D movement (not tile-by-tile or turn-based) — touch/drag or an on-screen virtual joystick on mobile, arrow keys/WASD on desktop. The turtle has a single, gentle movement speed (no sprint/dash for v1, keeping with the calm tone).

**Home marker:** the rock-pile home is a fixed, always-visible landmark the player can navigate back to; its appearance visibly changes as the home is upgraded (see Section 5).

## 4. Items & Resources

**Coconuts (food):** Coconuts scattered around the island can be picked up into carried inventory like any item. The turtle has a **hunger meter** that slowly drains while out exploring (not while at home). *v1 assumption, please confirm:* when hunger runs out, the turtle automatically eats a carried coconut if one is available (consumed from inventory, refills hunger) — if none are available, the turtle simply moves a little slower until it eats one or returns home, rather than dying. Hunger never causes item loss or death on its own; only birds do that (Section 6).

**Shells (currency):** Shells are the currency used for upgrades once banked at home (Section 5). Shells picked up during a trip sit in carried inventory just like coconuts until the player reaches home.

**Carry capacity:** The player can only carry a limited number of items at once (coconuts + shells combined, or tracked separately — v1 default: a single combined carry cap). Once full, further items on the ground can't be picked up until capacity increases (via upgrade) or the player banks their current haul at home. This capacity is what creates the core push-your-luck tension: carry more by upgrading, but a fuller inventory means more to lose if a bird catches you.

## 5. Home Base & Upgrades

When standing at home, the player can open a **Home/Upgrade screen** and spend **banked** shells (never carried/at-risk shells) on three upgrade tracks:

- **Home level** — the rock-pile home visibly grows/improves at each level (purely cosmetic/progression milestone for v1, reinforcing a sense of progress).
- **Inventory carry capacity** — increases how many items can be carried on a single trip before the player must return home to bank them.
- **Shell color** — a cosmetic customization for the turtle's shell, purely visual, no gameplay effect.

Each track has multiple levels/tiers with an increasing shell cost per level (exact tier count and costs are a build-time balance decision — Section 10 defines the data shape for these). Upgrades are permanent once purchased and are part of the save file.

## 6. Danger: Birds & Death/Respawn

**Where birds appear:** Birds only patrol the woods zone. The beach/home zone is always bird-free, so the area right around home is guaranteed safe.

**Bird behavior:** Birds move along patrol paths or wander within the woods (exact pattern is a build-time design choice — simple back-and-forth or gentle random wander fits the calm tone better than aggressive chasing). They don't leave the woods zone.

**On contact:** If a bird touches the turtle, the turtle is "caught" — this is not violent/gory, just a gentle transition (e.g. a screen flutter/fade, a soft sound cue) — and:

1. The turtle instantly respawns back at home.
2. Everything in the **carried inventory** from that trip (coconuts and shells not yet banked) is lost.
3. The **banked inventory** at home (everything from previous successful trips) is completely unaffected.
4. Home-level, capacity, and shell-color upgrades are never lost — they're permanent once purchased.

There's no lives/game-over state — getting caught is a setback (lose this trip's haul) rather than a failure state, matching the low-stakes tone.

## 7. Save System

**4 save slots:** From the Save Slot Select screen, each of the 4 slots is either empty ("New Game") or shows a saved game's quick stats (home level, banked shell count). Selecting an empty slot starts a fresh game in that slot; selecting a filled slot resumes it.

**What's saved per slot:** banked coconuts/shells, home level, carry capacity level, shell color, and the turtle's position at home (since a session always resumes there, not mid-trip).

**What's NOT saved:** the current trip's carried-but-unbanked inventory — since dying loses it anyway, and closing the app mid-trip is treated the same as a safe pause (the next session simply resumes at home with the carried inventory cleared, to keep the save model simple; this is a v1 assumption worth confirming — the alternative is persisting an in-progress trip exactly as left off).

**When it saves:** automatically, the moment the player successfully returns home and banks a trip's items, and whenever an upgrade is purchased — no manual "save" button needed.

**Storage:** all 4 slots are stored in `localStorage` on the device; there's no cloud sync, so progress is local to the browser/device the PWA is installed on (see Section 1, out of scope).

## 8. Screens & UI

**Beach theme (applies throughout):** soft sandy/ocean color palette (warm sand, turquoise water, palm-leaf green), rounded/friendly typography, gentle wave or shell-shaped UI accents, no harsh or violent imagery anywhere (fitting the calm, low-stakes tone).

**A. Main Menu**

- Title/logo, "Play" primary button, "How to Play" secondary, sound on/off toggle icon. Calm looping beach ambience plays here if sound is on.

**B. How to Play**

- Plain-language explanation of the loop: explore, collect, watch out for birds in the woods, return home to bank items, spend shells on upgrades. "Back" button.

**C. Save Slot Select**

- 4 slot cards, each showing either "New Game" or a summary of that save (home level, banked shells); tap to start/resume.

**D. Game World / Play Screen (core screen)**

- Top-down island view, turtle centered or camera-followed as it moves.
- On-screen movement control (virtual joystick/drag zone on mobile; keyboard on desktop).
- HUD: current carried-item count vs. carry capacity, hunger meter, small banked-shell/coconut counter, sound toggle.
- Visual/audio cue when entering the woods (subtle, not alarming) so the player always knows they've left the safe zone.
- Calm background music with a slightly different ambient layer in the woods vs. the beach (e.g. more wind/rustling) to reinforce the risk shift without being tense or jarring.

**E. Home / Upgrade Screen**

- Opens when at home; shows the home visually with its current level, banked shell/coconut totals, and the three upgrade tracks (home level, carry capacity, shell color) with costs and a purchase action for each.

**F. Respawn Transition**

- A brief, gentle transition (fade/flutter + soft sound) when caught by a bird, then returns the player to the home screen/world with the trip's carried items cleared.

Layout must work in portrait and landscape; movement controls must stay comfortably reachable with thumbs on a phone.

## 9. Technical Architecture

- **Stack:** Plain HTML5 + CSS3 + vanilla JavaScript. No framework, no bundler, no npm build step — deployable files are the built files.
- **Rendering:** A `<canvas>`-based 2D top-down view is the natural fit for free-roam movement, sprite animation, and collision — draws the island, turtle, birds, and items each frame via a `requestAnimationFrame` game loop. (A DOM/CSS-position approach is possible but canvas is recommended for smoother movement and collision handling at this scope.)
- **Movement & controls:** A virtual joystick/drag-zone component for touch, arrow keys/WASD for desktop, both feeding into a normalized direction vector the game loop uses to move the turtle each frame.
- **Collision detection:** Simple circle/rectangle-based overlap checks each frame between the turtle and (a) item pickups, (b) the home zone boundary, (c) birds — kept lightweight since the entity count is small.
- **Zone logic:** Woods vs. beach/home is defined by a boundary region in the world data; bird spawn/patrol logic is scoped to stay within the woods region only.
- **State management:** In-memory JS object holds current screen, active save slot, turtle position, hunger, carried inventory, banked inventory + upgrade levels (loaded from the active save), and bird positions/patrol state. No backend, no database.
- **Persistence:** `localStorage` holds all 4 save slots (see Section 7) plus the sound on/off preference.
- **Audio:** Looping calm background music (differing slightly beach vs. woods) plus short sound effects (item pickup, banking at home, bird catch, upgrade purchase), all via `<audio>` or Web Audio API, gated by the sound toggle, cached by the service worker for offline play.
- **PWA support (v1 requirement):**
- `manifest.json` (name "Turtle Tides", short\_name, icons at 192px/512px, `start_url`, `display: standalone`, beach color theme) so it's installable to a home screen.
- A service worker (`service-worker.js`) registered from `index.html` that caches the app shell (HTML/CSS/JS/sprites/audio/icons) on install and serves from cache first, so the game works offline once installed/visited.
- Must pass basic installability checks (served over HTTPS, valid manifest, registered service worker) so browsers show an install/"Add to Home Screen" prompt.
- **Responsiveness:** Canvas scales to fit the viewport while maintaining aspect ratio; touch controls sized for comfortable thumb reach on phones.
- **Browser support target:** Latest 2 versions of Chrome, Safari (iOS), Firefox, Edge.

## 10. Data Model

**Game config (upgrade tiers, world tuning)** lives in a data file so balance can be tuned without touching game logic:

```json
{
 "carryCapacityTiers": [5, 8, 12, 18, 25],
 "homeLevelCosts": [0, 20, 50, 100, 200],
 "shellColorCosts": [0, 15, 15, 25, 25, 40],
 "hungerDrainPerSecond": 1,
 "hungerMax": 100,
 "birdCount": 3,
 "birdSpeed": 60
}
```

**Save slot structure** (one of these per slot, persisted in `localStorage`):

```json
{
 "slotId": 1,
 "createdAt": "2026-09-22T00:00:00Z",
 "banked": {"coconuts": 4, "shells": 37},
 "upgrades": {"homeLevel": 2, "carryCapacityLevel": 1, "shellColorId": "teal"},
 "lastPlayedAt": "2026-09-22T00:00:00Z"
}
```

**Runtime session state** (in-memory, rebuilt from the active save slot on load, not itself persisted mid-trip):

```json
{
 "activeSlotId": 1,
 "turtle": {"x": 400, "y": 300, "hunger": 80},
 "carried": {"coconuts": 0, "shells": 0},
 "carriedCap": 8,
 "birds": [{"id": "b1", "x": 900, "y": 250, "patrol": "a"}],
 "zone": "beach",
 "soundOn": true
}
```

**Rules encoded in data, not code:** carry-capacity tiers, home-level and shell-color costs, hunger drain rate, and bird count/speed, so v1 balance can be adjusted without a code change. Movement, collision, banking, and the death/respawn rule itself are game logic.

## 11. File Structure & Repo Layout

```
turtle-tides/
├── index.html # markup + canvas + screen overlays, registers the service worker
├── style.css # beach theme styling, HUD/menu layout, responsive rules
├── script.js # game loop, movement, collision, save/bank/respawn logic
├── manifest.json # PWA manifest (name: Turtle Tides, icons, start_url, display: standalone)
├── service-worker.js # caches the app shell for offline/installed use
├── data/
│ ├── config.js # carryCapacityTiers, homeLevelCosts, shellColorCosts, hunger/bird tuning
│ └── world.js # island layout, zone boundaries, item spawn points
├── sprites/
│ ├── turtle.png
│ ├── bird.png
│ ├── home-level-1.png ... home-level-N.png
│ └── (coconut, shell, terrain tiles, etc.)
├── sounds/
│ ├── beach-ambience.mp3
│ ├── woods-ambience.mp3
│ ├── pickup.mp3
│ ├── bank.mp3
│ ├── caught.mp3
│ └── upgrade.mp3
├── icons/
│ ├── icon-192.png
│ └── icon-512.png
└── README.md # how to run locally + how to tune config/world data
```

Plain relative paths only so the same files work identically opened locally as `file://index.html` or served from the repo's Pages URL. Balance/config data, world layout, art, and audio all stay separate from game logic so future tuning or reskinning never touches core code.

## 12. Deployment

1. **Create the repo:** A new GitHub repository (e.g. `turtle-tides`) is created for this project, public so GitHub Pages can serve it for free.
2. **Build:** Claude Code writes `index.html`, `style.css`, `script.js`, `manifest.json`, `service-worker.js`, the `data/` files, sprites, sounds, and icons directly per the File Structure section — no compilation step.
3. **Commit:** Files are committed and pushed to the repo (e.g. `git init`, `git add .`, `git commit -m "..."`, `git remote add origin ...`, `git push`).
4. **Enable Pages:** GitHub Pages is turned on for the repo (serving from `main` branch root, or a `/docs` folder), giving a public URL like `https://<username>.github.io/turtle-tides/`.
5. **Update flow going forward:** Any future change (balance tweak, new art, bug fix) is a normal commit + push to the same repo; the live Pages site picks it up automatically.
6. **PWA requirement:** GitHub Pages serves over HTTPS automatically, which is required for the service worker and install prompt to work — no extra config needed.
7. **No environment variables or secrets** are needed since there's no backend or API calls.

## 13. Acceptance Criteria

- [ ] App loads on mobile and desktop browsers via a single static URL, no login.
- [ ] App is installable as a PWA (manifest + service worker pass installability checks) and its shell loads offline once installed.
- [ ] Main Menu offers Play, How to Play, and a sound toggle that persists between sessions.
- [ ] Play routes to a Save Slot Select screen showing all 4 slots (empty or with a saved-game summary).
- [ ] Starting a new save places the turtle at home with empty banked inventory and base upgrade levels; resuming a save restores that slot's banked inventory and upgrades.
- [ ] The turtle can move freely around the island via touch/joystick (mobile) or keyboard (desktop).
- [ ] Coconuts and shells can be picked up into carried inventory up to the current carry capacity.
- [ ] Birds only appear and patrol within the woods zone; the beach/home zone is always bird-free.
- [ ] Walking onto the home tile banks all currently carried items into the save (persisted) and clears carried inventory.
- [ ] Banked inventory is never lost under any circumstance, including a bird catching the turtle.
- [ ] Bird contact respawns the turtle at home and clears (loses) only that trip's carried inventory.
- [ ] The Home/Upgrade screen lets the player spend banked shells on home level, carry capacity, and shell color, and purchases persist to the save.
- [ ] Hunger drains while exploring and coconuts address it per the design in Section 4, without ever causing item loss or respawn on their own.
- [ ] Calm background music plays (beach and woods variants) and all sound effects respect the sound toggle, both from the main menu and during gameplay.
- [ ] Works over touch and mouse/keyboard input; layout holds up in portrait and landscape.

## 14. Future Enhancements (Out of Scope for v1)

- Additional zones (e.g. tide pools with timing-based hazards, fitting the "Tides" name further).
- More collectible/cosmetic types beyond shell color (patterns, accessories).
- A gentle bird "tell" (shadow/warning sound before it swoops) for more skill expression.
- Daily/weekly goals or achievements.
- Cloud save sync across devices.
- Seasonal or weather visual variety (e.g. sunset, rain) purely for atmosphere.
- A photo-mode or screenshot-share feature for the home once upgraded.
