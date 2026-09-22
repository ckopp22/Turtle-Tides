// Island layout, zone boundaries, and item spawn points.
const WORLD = {
  width: 2400,
  height: 1800,
  home: { x: 300, y: 300 },
  homeRadius: 70,        // triggers banking when turtle center is within this of home
  beachRadius: 550,      // distance from home within which the zone is "beach" (safe, no birds)
};

function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function isInBounds(x, y, margin) {
  return x > margin && x < WORLD.width - margin && y > margin && y < WORLD.height - margin;
}

function getZone(x, y) {
  const dx = x - WORLD.home.x;
  const dy = y - WORLD.home.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return dist <= WORLD.beachRadius ? "beach" : "woods";
}

// Generate a fixed, deterministic set of item spawn points across the island.
// Woods gets denser spawns (more items) than the beach zone.
function generateSpawnPoints() {
  const rand = seededRandom(1337);
  const points = [];
  let id = 0;

  const totalAttempts = 260;
  for (let i = 0; i < totalAttempts; i++) {
    const x = 60 + rand() * (WORLD.width - 120);
    const y = 60 + rand() * (WORLD.height - 120);

    if (!isInBounds(x, y, 40)) continue;

    // Skip spawns too close to home itself so the home area stays clear.
    const dxHome = x - WORLD.home.x;
    const dyHome = y - WORLD.home.y;
    if (Math.sqrt(dxHome * dxHome + dyHome * dyHome) < WORLD.homeRadius + 50) continue;

    const zone = getZone(x, y);
    // Thin out beach spawns to keep it lower-reward than the woods.
    if (zone === "beach" && rand() > 0.35) continue;

    const type = rand() < 0.5 ? "coconut" : "shell";
    points.push({ id: "item" + id++, type, x, y, zone });
  }

  return points;
}

// Generate patrol paths for birds, confined to the woods zone.
function generateBirdPatrols(count) {
  const rand = seededRandom(4242);
  const patrols = [];
  for (let i = 0; i < count; i++) {
    // Find a random woods point, then a second woods point within range for back-and-forth patrol.
    let ax, ay, bx, by;
    let tries = 0;
    do {
      ax = 60 + rand() * (WORLD.width - 120);
      ay = 60 + rand() * (WORLD.height - 120);
      tries++;
    } while ((getZone(ax, ay) !== "woods" || !isInBounds(ax, ay, 60)) && tries < 200);

    const angle = rand() * Math.PI * 2;
    const dist = 200 + rand() * 300;
    bx = ax + Math.cos(angle) * dist;
    by = ay + Math.sin(angle) * dist;
    bx = Math.max(60, Math.min(WORLD.width - 60, bx));
    by = Math.max(60, Math.min(WORLD.height - 60, by));
    if (getZone(bx, by) !== "woods") {
      bx = ax;
      by = ay + 150;
    }

    patrols.push({
      id: "b" + i,
      a: { x: ax, y: ay },
      b: { x: bx, y: by },
    });
  }
  return patrols;
}
