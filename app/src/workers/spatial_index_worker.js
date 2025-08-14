// src/workers/spatial_index_worker.js

const MAX_TILES_PER_STROKE = 20000;
const MAX_DIM_TILES        = 10000;
const MAX_WORLD_ABS        = 1e12;

const isFiniteNum = (n) => Number.isFinite(n);
const KEY = (ix, iy) => `${ix},${iy}`;

function tilesSpan(cell, b){
  if (!b) return { valid:false };
  const vals = [b.minx,b.maxx,b.miny,b.maxy];
  if (!vals.every(isFiniteNum)) return { valid:false };
  if (vals.some(v => Math.abs(v) > MAX_WORLD_ABS)) return { valid:false };

  const minx = Math.floor(b.minx / cell);
  const maxx = Math.floor(b.maxx / cell);
  const miny = Math.floor(b.miny / cell);
  const maxy = Math.floor(b.maxy / cell);
  if (![minx,maxx,miny,maxy].every(Number.isSafeInteger)) return { valid:false };
  if (maxx < minx || maxy < miny) return { valid:false };

  const spanX = maxx - minx + 1;
  const spanY = maxy - miny + 1;
  const area  = spanX * spanY;
  return { valid:true, minx,maxx,miny,maxy, spanX, spanY, area };
}

self.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.type !== 'rebuild') return;

  const gen = msg.gen | 0;
  const count = msg.count | 0;
  const cell = msg.cell || 1024;
  const strokes = msg.strokes || [];

  const map = new Map(); 
  const all = [];
  let overflow = false;

  for (let i = 0; i < strokes.length; i++){
    const bbox = strokes[i]?.bbox;
    if (!bbox) continue;
    all.push(i);

    const t = tilesSpan(cell, bbox);
    if (!t.valid) { overflow = true; continue; }
    if (t.spanX > MAX_DIM_TILES || t.spanY > MAX_DIM_TILES) { overflow = true; continue; }
    if (!Number.isFinite(t.area) || t.area <= 0 || t.area > MAX_TILES_PER_STROKE) { overflow = true; continue; }

    for (let iy = t.miny; iy <= t.maxy; iy++){
      for (let ix = t.minx; ix <= t.maxx; ix++){
        const k = KEY(ix, iy);
        let arr = map.get(k); if (!arr) map.set(k, arr = []);
        arr.push(i);
      }
    }
  }

  const tiles = Array.from(map.entries()); 
  self.postMessage({ type:'rebuilt', gen, count, cell, overflow, tiles, all });
};
