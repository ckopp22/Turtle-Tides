# Turtle Tides

A calm, beach-themed exploration and collection game. Gather coconuts and shells, watch out for birds in the woods, and bank your haul at home before you push your luck too far.

## Run locally

No build step — plain HTML/CSS/JS. Because the service worker needs a real origin (not `file://`), run a local static server from this folder:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

Or `npx serve .` if you have Node installed.

## Project structure

- `index.html` — all screens (menu, how-to-play, save slots, game, home/upgrades) + canvas
- `style.css` — beach theme, HUD, responsive layout
- `script.js` — game loop, input, save/bank/respawn logic, rendering
- `data/config.js` — balance tuning (carry capacity tiers, upgrade costs, hunger/bird tuning)
- `data/world.js` — island size, home position, zone boundary, item/bird spawn generation
- `manifest.json` / `service-worker.js` / `icons/` — PWA installability + offline caching
- `sprites/turtle.png` — turtle sprite sheet (4x4 grid of 64x64 frames; row 0 used for walk animation, hue-rotated per shell color upgrade)

## Tuning the game

Edit `data/config.js` to adjust:
- `carryCapacityTiers` — carry capacity per upgrade level
- `homeLevelCosts` — shell cost per home-level upgrade
- `shellColorCosts` — shell cost per cosmetic color unlock
- `hungerDrainPerSecond`, `hungerMax` — hunger pacing
- `birdCount`, `birdSpeed` — woods difficulty

Edit `data/world.js` to adjust the island size, home position, beach/woods boundary radius, or the spawn-point generator.

## Sound

All audio is synthesized at runtime via the Web Audio API (no external audio files) — ambient drones for beach/woods and short tones for pickup, banking, bird catches, and upgrades. Everything respects the sound toggle in the main menu and in-game HUD.

## Deploying to GitHub Pages

1. `git init && git add . && git commit -m "Initial commit"`
2. Create a new GitHub repo (e.g. `turtle-tides`) and `git remote add origin <url>`
3. `git push -u origin main`
4. In the repo's Settings → Pages, set source to the `main` branch, root folder
5. Visit `https://<username>.github.io/turtle-tides/`

No environment variables, backend, or build step required.
