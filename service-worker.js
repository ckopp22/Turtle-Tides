// Offline support. Shell (index.html, css, js) is network-first so deploys show up right away online;
// assets/** are cache-first. Bump CACHE on every deploy that adds/changes an asset file (the shell
// URLs are read from index.html at install, so its ?v= bumps are picked up automatically).
const CACHE = 'tt-v3';

// Critical art: install fails if any of these can't be fetched.
const ART = [
  'assets/collectibles/items25_spritesheet.png',
  'assets/enemies/bear_spritesheet.png',
  'assets/enemies/crab_spritesheet.png',
  'assets/enemies/seagull_spritesheet.png',
  'assets/enemies/snake_spritesheet.png',
  'assets/favicon-16.png',
  'assets/favicon-32.png',
  'assets/hatch/egg1.png',
  'assets/hatch/egg2.png',
  'assets/hatch/egg3.png',
  'assets/hatch/hatch_emerge.png',
  'assets/hatch/hatch_out.png',
  'assets/hatch/stand.png',
  'assets/hatch/walk1.png',
  'assets/hatch/wave.png',
  'assets/home/00_hut_interior_empty_192.png',
  'assets/home/01_bed_192.png',
  'assets/home/02_rug_192.png',
  'assets/home/03_doormat_192.png',
  'assets/home/04_table_and_stools_192.png',
  'assets/home/05_shelf_192.png',
  'assets/home/06_plant_192.png',
  'assets/home/07_lantern_192.png',
  'assets/home/08_chest_192.png',
  'assets/home/campfire_spritesheet.png',
  'assets/home/campfire_unlit_64.png',
  'assets/home/hut_exterior_192.png',
  'assets/icon-180.png',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/items/accessory_bowtie.png',
  'assets/items/accessory_crab.png',
  'assets/items/accessory_goggles.png',
  'assets/items/accessory_ring_navy.png',
  'assets/items/accessory_ring_orange.png',
  'assets/items/accessory_scarf.png',
  'assets/items/backpack.png',
  'assets/items/chest_closed_64.png',
  'assets/items/clothes_cape.png',
  'assets/items/clothes_diving.png',
  'assets/items/clothes_icon.png',
  'assets/items/clothes_tshirt.png',
  'assets/items/clothes_vest.png',
  'assets/items/coconut.png',
  'assets/items/coin.png',
  'assets/items/coin_hud.png',
  'assets/items/compass_base_64.png',
  'assets/items/compass_needle_16dir_spritesheet.png',
  'assets/items/hat_flower.png',
  'assets/items/heart_empty.png',
  'assets/items/heart_full.png',
  'assets/items/home_icon.png',
  'assets/items/hull_hud.png',
  'assets/items/moon_icon.png',
  'assets/items/shop_sign.png',
  'assets/items/shop_stall.png',
  'assets/items/sun_icon.png',
  'assets/scenery/bush_dead.png',
  'assets/scenery/bush_flowering.png',
  'assets/scenery/bush_round.png',
  'assets/scenery/dead_tree_med.png',
  'assets/scenery/dead_tree_small.png',
  'assets/scenery/decor_books.png',
  'assets/scenery/decor_campfire.png',
  'assets/scenery/decor_firepitRing.png',
  'assets/scenery/decor_hutComplete.png',
  'assets/scenery/decor_hutFrame.png',
  'assets/scenery/decor_lanterns.png',
  'assets/scenery/decor_porch.png',
  'assets/scenery/decor_table.png',
  'assets/scenery/decor_torches.png',
  'assets/scenery/driftwood_stick.png',
  'assets/scenery/oak_tree.png',
  'assets/scenery/pine_sapling.png',
  'assets/scenery/pine_tall.png',
  'assets/scenery/rock_beach.png',
  'assets/scenery/round_tree_med.png',
  'assets/scenery/round_tree_single.png',
  'assets/scenery/round_tree_small.png',
  'assets/scenery/sand_speckled.png',
  'assets/scenery/sandcastle_big.png',
  'assets/scenery/sandpile.png',
  'assets/scenery/tree_cluster3.png',
  'assets/tiles/flowers_mixed.png',
  'assets/tiles/grass3.png',
  'assets/tiles/sand3.png',
  'assets/tiles/water1.png',
  'assets/turtle-sheet.png',
];

// SFX (~19 MB): cached best-effort so a flaky connection can't block install.
const SFX = [
  'assets/sfx/adventure1.mp3',
  'assets/sfx/adventure2.mp3',
  'assets/sfx/adventure3.mp3',
  'assets/sfx/bag.m4a',
  'assets/sfx/beach.mp3',
  'assets/sfx/bear.mp3',
  'assets/sfx/bite.mp3',
  'assets/sfx/book-close.mp3',
  'assets/sfx/book-open.mp3',
  'assets/sfx/book-page.mp3',
  'assets/sfx/bookdrop.mp3',
  'assets/sfx/click.mp3',
  'assets/sfx/coin.mp3',
  'assets/sfx/coindrop.mp3',
  'assets/sfx/creak.mp3',
  'assets/sfx/door.mp3',
  'assets/sfx/eagle.mp3',
  'assets/sfx/egg-crack2.mp3',
  'assets/sfx/egg-crack3.mp3',
  'assets/sfx/fire.mp3',
  'assets/sfx/full.mp3',
  'assets/sfx/gameover.mp3',
  'assets/sfx/music1.mp3',
  'assets/sfx/music2.mp3',
  'assets/sfx/music3.mp3',
  'assets/sfx/purchase.mp3',
  'assets/sfx/sand.mp3',
  'assets/sfx/shell.mp3',
  'assets/sfx/snake.mp3',
  'assets/sfx/snore.mp3',
  'assets/sfx/splash.mp3',
  'assets/sfx/stick-snap.mp3',
  'assets/sfx/stomp.mp3',
  'assets/sfx/umph.mp3',
  'assets/sfx/walking.mp3',
  'assets/sfx/water-walking.mp3',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Shell = index.html plus every ?v= css/js/icon/manifest URL it references.
    const html = await (await fetch('index.html', { cache: 'reload' })).text();
    const shell = ['./', 'index.html'];
    for (const m of html.matchAll(/(?:href|src)="((?!https?:|#)[^"]+)"/g)) shell.push(m[1]);
    await cache.addAll([...new Set(shell.concat(ART))]); // addAll rejects on duplicate URLs
    await Promise.allSettled(SFX.map((u) => cache.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Safari requests audio with Range headers; slice the cached full response into a 206.
async function rangeResponse(req, res) {
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range'));
  if (!m || !res.ok) return res;
  const buf = await res.arrayBuffer();
  const start = m[1] ? +m[1] : 0;
  const end = m[2] ? Math.min(+m[2], buf.byteLength - 1) : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(end - start + 1),
    },
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.includes('/assets/')) {
    // Cache-first; ignoreSearch because asset URLs mix ?v=1 and bare forms.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      let res = await cache.match(url.pathname, { ignoreSearch: true });
      if (!res) {
        res = await fetch(req);
        if (res.ok) cache.put(url.pathname, res.clone());
        return res;
      }
      return req.headers.has('range') ? rangeResponse(req, res) : res;
    })());
    return;
  }

  // Shell: network-first, fall back to cache when offline.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
