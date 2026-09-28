# Turtle Tides

A plain HTML/CSS/JS web game — no frameworks, no build tools. Player controls a turtle exploring an island to find shells and coconuts.

## Run locally

Just open `index.html` in a browser, or serve the folder with any static server (e.g. `python3 -m http.server`).

## Controls

- Desktop: WASD
- Mobile: free-floating touch joystick

## Structure

- `index.html` — entry point
- `css/style.css` — styles
- `js/game.js` — game logic
- `assets/` — sprites
- `service-worker.js` — kills stale caches on old devices
- `Turtle Tides - Web App MDD.md` — design doc; read before building new features

## Deploy

Hosted on GitHub Pages. Bump the `?v=` query strings on `style.css`/`game.js` in `index.html` before pushing changes to those files, so clients don't serve stale cached versions.
