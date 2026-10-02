// shore.js — animated water/sand coastline with little waves rolling in.
// Sand is drawn ONLY on tiles you say are sand (and under water). Everything else
// (grass, paths, ...) is left alone, so draw your ground first and call this after it.
//
//   const shore = Shore.create(map, sandImg, waterImg, {
//     isWater: v => v === 1,      // your map's value(s) for water
//     isSand:  v => v === 2,      // your map's value(s) for sand
//   });
//   // every frame, AFTER drawing grass/ground and BEFORE the turtle and objects:
//   shore.draw(ctx, camX, camY, canvas.width, canvas.height, performance.now() / 1000);

const Shore = (() => {
  const TILE = 64;

  function hash(x, y) {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  const sm = t => t * t * (3 - 2 * t);
  function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), u = sm(x - xi), w = sm(y - yi);
    return (hash(xi, yi) * (1 - u) + hash(xi + 1, yi) * u) * (1 - w) +
           (hash(xi, yi + 1) * (1 - u) + hash(xi + 1, yi + 1) * u) * w;
  }
  const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

  // smooth 0..1 field from a 0/1 tile grid: softened, then bilinear between tile centres
  function makeField(grid) {
    const H = grid.length, W = grid[0].length;
    const raw = (x, y) => grid[Math.min(H - 1, Math.max(0, y))][Math.min(W - 1, Math.max(0, x))];
    const K = [1, 2, 1];
    const soft = grid.map((row, y) => row.map((_, x) => {
      let s = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += raw(x + i, y + j) * K[i + 1] * K[j + 1];
      return 0.45 * raw(x, y) + 0.55 * (s / 16);
    }));
    const cell = (x, y) => soft[Math.min(H - 1, Math.max(0, y))][Math.min(W - 1, Math.max(0, x))];
    return (tx, ty) => {
      const gx = tx - 0.5, gy = ty - 0.5, x0 = Math.floor(gx), y0 = Math.floor(gy);
      const u = sm(gx - x0), v = sm(gy - y0);
      return (cell(x0, y0) * (1 - u) + cell(x0 + 1, y0) * u) * (1 - v) +
             (cell(x0, y0 + 1) * (1 - u) + cell(x0 + 1, y0 + 1) * u) * v;
    };
  }

  function create(map, sandImg, waterImg, opts = {}) {
    const o = Object.assign({
      isWater: v => v === 1,        // which map values are water
      isSand:  v => v !== 1,        // which map values are sand (default: everything that isn't water)
      sandEdge: 'soft',             // 'soft' = organic sand→grass edge, 'hard' = sand fills whole sand tiles
      res: 2,                       // 1 mask pixel = res screen px (1 sharpest, 3 fastest)
      wobble: 0.13,                 // how ragged the coastline is
      speed: 0.3,                   // waves per second at any one spot
      waveDepth: 0.16,              // how far out each wave starts
      foam: true, wetBand: true, sway: true,
    }, opts);
    const RES = o.res;
    const H = map.length, Wt = map[0].length;
    const PW = Wt * TILE, PH_ = H * TILE;
    const mw0 = Math.ceil(PW / RES), mh0 = Math.ceil(PH_ / RES);

    const waterGrid = map.map(row => row.map(v => (o.isWater(v) ? 1 : 0)));
    const underGrid = map.map(row => row.map(v => (o.isWater(v) || o.isSand(v) ? 1 : 0)));  // where sand may show
    const waterField = makeField(waterGrid);
    const underField = o.sandEdge === 'soft' ? makeField(underGrid) : null;

    const F = new Float32Array(mw0 * mh0);   // shoreline field: 0.5 = waterline
    const P = new Float32Array(mw0 * mh0);   // per-spot wave timing offset
    const G = new Uint8Array(mw0 * mh0);     // fine grain that breaks foam up
    const SA = new Uint8Array(mw0 * mh0);    // 0..255: how much sand may show here
    for (let y = 0; y < mh0; y++) {
      for (let x = 0; x < mw0; x++) {
        const tx = (x * RES) / TILE, ty = (y * RES) / TILE, k = y * mw0 + x;
        const n = (noise(tx * 2.3, ty * 2.3) - 0.5) * o.wobble * 2 + (noise(tx * 7.1 + 40, ty * 7.1 + 40) - 0.5) * o.wobble * 0.7;
        F[k] = waterField(tx, ty) + n;
        P[k] = noise(tx * 1.7 + 77, ty * 1.7 + 77) * 1.3;
        G[k] = noise(tx * 9 + 3, ty * 9 + 3) * 255;
        if (underField) {
          const n2 = (noise(tx * 2.9 + 200, ty * 2.9 + 200) - 0.5) * 0.22 + (noise(tx * 8 + 300, ty * 8 + 300) - 0.5) * 0.08;
          SA[k] = smoothstep(0.46, 0.54, underField(tx, ty) + n2) * 255;
        } else {
          SA[k] = underGrid[Math.min(H - 1, Math.floor(ty))][Math.min(Wt - 1, Math.floor(tx))] * 255;
        }
      }
    }

    const tmp = canvasOf(1, 1).getContext('2d');
    const sandPat = tmp.createPattern(sandImg, 'repeat');
    const waterPat = tmp.createPattern(waterImg, 'repeat');
    let L = null;
    // Mask cells are cached in a window padded by PAD cells and only recomputed ~20x/sec (or when the
    // camera leaves the window) — the per-cell wave math was the main cost on phones.
    const PAD = 6, TICK = 20;
    let cache = null;
    function layers(vw, vh) {
      const mw = Math.ceil(vw / RES) + 2 + 2 * PAD, mh = Math.ceil(vh / RES) + 2 + 2 * PAD;
      if (L && L.mw === mw && L.mh === mh && L.vw === vw && L.vh === vh) return L;
      const mk = (r, g, b) => {
        const c = canvasOf(mw, mh), x = c.getContext('2d'), id = x.createImageData(mw, mh);
        for (let i = 0; i < id.data.length; i += 4) { id.data[i] = r; id.data[i + 1] = g; id.data[i + 2] = b; }
        return { c, x, id };
      };
      L = { vw, vh, mw, mh, wet: mk(120, 92, 52), foam: mk(255, 255, 255), mask: mk(0, 0, 0), smask: mk(0, 0, 0),
            water: canvasOf(vw, vh), sand: canvasOf(vw, vh) };
      return L;
    }

    function draw(ctx, camX, camY, vw, vh, time = 0) {
      camX = Math.round(camX); camY = Math.round(camY);
      const l = layers(vw, vh);
      const nx = Math.floor(camX / RES), ny = Math.floor(camY / RES), need = Math.ceil(vw / RES) + 2, needH = Math.ceil(vh / RES) + 2;
      const tick = Math.floor(time * TICK);
      const stale = !cache || cache.l !== l || cache.tick !== tick || nx < cache.mx0 || ny < cache.my0 ||
        nx + need > cache.mx0 + l.mw || ny + needH > cache.my0 + l.mh;
      if (stale) cache = { l, tick, mx0: nx - PAD, my0: ny - PAD };
      const mx0 = cache.mx0, my0 = cache.my0;
      const wd = l.wet.id.data, fd = l.foam.id.data, md = l.mask.id.data, sd = l.smask.id.data;
      const soft = !!underField;
      const t = time * o.speed;

      if (stale) for (let y = 0; y < l.mh; y++) {
        const gy = my0 + y;
        for (let x = 0; x < l.mw; x++) {
          const gx = mx0 + x, i = (y * l.mw + x) * 4 + 3;
          if (gx < 0 || gy < 0 || gx >= mw0 || gy >= mh0) { wd[i] = fd[i] = md[i] = sd[i] = 0; continue; }
          const k = gy * mw0 + gx, f = F[k], sa = SA[k];
          if (soft) sd[i] = sa;
          const u = (t + P[k]) % 1;                   // this spot's position in its wave cycle
          const e = Math.sin(Math.PI * u);            // 0 → 1 → 0 : arrives, laps, drains
          const th = 0.5 - 0.035 * e;                 // waterline creeps up at the peak
          const wa = smoothstep(th - 0.018, th + 0.018, f);
          md[i] = wa * 255;
          wd[i] = o.wetBand ? smoothstep(0.26, th, f) * (1 - wa) * 175 * (0.62 + 0.38 * e) * (sa / 255) : 0;  // wet stain only on sand
          if (o.foam) {
            const a = (f - (th + 0.006)) / 0.02;
            const edge = Math.exp(-a * a) * (0.3 + 0.7 * e);
            const b = (f - (0.5 + o.waveDepth * (1 - u))) / 0.024;
            const crest = Math.exp(-b * b) * Math.pow(e, 0.7);
            fd[i] = Math.min(1, (edge * 0.85 + crest) * (0.55 + 0.45 * (G[k] / 255))) * 215;
          } else fd[i] = 0;
        }
      }
      if (stale) {
        l.wet.x.putImageData(l.wet.id, 0, 0); l.foam.x.putImageData(l.foam.id, 0, 0); l.mask.x.putImageData(l.mask.id, 0, 0);
        if (soft) l.smask.x.putImageData(l.smask.id, 0, 0);
      }
      const ox = mx0 * RES - camX, oy = my0 * RES - camY, ow = l.mw * RES, oh = l.mh * RES;

      const prevS = ctx.imageSmoothingEnabled;
      // 1) sand — only where the map says sand (and under water, so the wobbling waterline never shows a gap)
      if (!soft) {
        ctx.save(); ctx.translate(-camX, -camY); ctx.fillStyle = sandPat;
        const ty0 = Math.max(0, Math.floor(camY / TILE)), ty1 = Math.min(H - 1, Math.floor((camY + vh - 1) / TILE));
        const tx0 = Math.max(0, Math.floor(camX / TILE)), tx1 = Math.min(Wt - 1, Math.floor((camX + vw - 1) / TILE));
        for (let ty = ty0; ty <= ty1; ty++) {
          for (let tx = tx0; tx <= tx1; tx++) {
            if (!underGrid[ty][tx]) continue;
            let run = 1; while (tx + run <= tx1 && underGrid[ty][tx + run]) run++;   // merge neighbours into one rect (no seams)
            ctx.fillRect(tx * TILE, ty * TILE, run * TILE, TILE);
            tx += run - 1;
          }
        }
        ctx.restore();
      } else {
        const sg = l.sand.getContext('2d');
        sg.setTransform(1, 0, 0, 1, 0, 0); sg.globalCompositeOperation = 'source-over'; sg.clearRect(0, 0, vw, vh);
        sg.save(); sg.translate(-camX, -camY); sg.fillStyle = sandPat; sg.fillRect(camX, camY, vw, vh); sg.restore();
        sg.globalCompositeOperation = 'destination-in'; sg.imageSmoothingEnabled = false;
        sg.drawImage(l.smask.c, ox, oy, ow, oh);
        sg.globalCompositeOperation = 'source-over';
        ctx.drawImage(l.sand, 0, 0);
      }
      // 2) wet sand
      ctx.imageSmoothingEnabled = false;
      if (o.wetBand) ctx.drawImage(l.wet.c, ox, oy, ow, oh);
      // 3) water, cut out by the mask (its texture sways a little with the waves)
      const wg = l.water.getContext('2d');
      const ph = 2 * Math.PI * o.speed * time;
      const sx = o.sway ? 3 * Math.sin(ph) : 0, sy = o.sway ? 2 * Math.cos(ph) : 0;
      wg.setTransform(1, 0, 0, 1, 0, 0); wg.globalCompositeOperation = 'source-over'; wg.clearRect(0, 0, vw, vh);
      wg.save(); wg.translate(-camX + sx, -camY + sy); wg.fillStyle = waterPat;
      wg.fillRect(camX - sx - 4, camY - sy - 4, vw + 8, vh + 8); wg.restore();
      wg.globalCompositeOperation = 'destination-in'; wg.imageSmoothingEnabled = false;
      wg.drawImage(l.mask.c, ox, oy, ow, oh);
      wg.globalCompositeOperation = 'source-over';
      ctx.drawImage(l.water, 0, 0);
      // 4) foam
      if (o.foam) ctx.drawImage(l.foam.c, ox, oy, ow, oh);
      ctx.imageSmoothingEnabled = prevS;
    }
    return { draw };
  }
  return { create, TILE };
})();
if (typeof module !== 'undefined') module.exports = Shore;
