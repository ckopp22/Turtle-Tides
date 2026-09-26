# Project Rules for Turtle Tides

## Project context
- Plain HTML/CSS/JS web game — no frameworks, no build tools, no npm dependencies 
  unless explicitly requested.
- Player controls a turtle exploring to find shells and coconuts.
- Controls: WASD on desktop, a free-floating touch joystick on mobile.
- Full design reference lives in the MDD in this repo — read it before building 
  any new feature, don't re-derive mechanics that are already specified there.

## Scope discipline
- Only build what's explicitly asked for in the current prompt. Don't add 
  features, levels, sound, or polish that wasn't requested — leave a `// TODO:` 
  comment instead of building ahead.
- Build incrementally, one feature at a time (e.g. movement, then one collectible 
  type, then scoring) rather than trying to build multiple systems in one pass.
- If a request is ambiguous, make the smallest reasonable interpretation and keep 
  moving rather than asking — note any assumption in a one-line comment.

## Communication style
- Keep responses short. Don't explain basic HTML/CSS/JS concepts or narrate what 
  you're about to do — just do it.
- No long summaries after each change — a one- or two-line note of what changed 
  is enough.
- Don't restate full files back to me unless asked — show diffs or just confirm 
  the change was made.
- Don't ask clarifying questions over minor decisions (exact colors, spacing, 
  timing/speed values, placeholder art choices) — pick something reasonable and 
  move on.

## Code style
- Keep the file count minimal (e.g. `index.html`, `style.css`, `game.js`) unless 
  the MDD specifies a different structure.
- Favor simple, readable vanilla JS over clever abstractions or premature 
  architecture (no unnecessary classes/modules for a game this size).
- Comment complex game-logic sections briefly, but don't over-document trivial code.

## Testing/output
- After each build step, confirm it runs in a browser with no console errors 
  before considering the step done.
- For touch/joystick behavior that can't be fully verified in this environment, 
  note how I should test it manually rather than assuming it works.
