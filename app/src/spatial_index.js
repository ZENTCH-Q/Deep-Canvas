// src/spatial_index.js

const KEY = (ix, iy) => `${ix},${iy}`;

export function makeGrid(cell = 1024){
  return { cell, map: new Map(), all: new Set(), overflow: false };
}
export const grid = makeGrid(1024);

const MAX_TILES_PER_STROKE = 20000;
const MAX_TILES_PER_QUERY  = 20000;
const MAX_DIM_TILES        = 10000;
const MAX_WORLD_ABS        = 1e12;

const isFiniteNum = (n) => Number.isFinite(n);

function tilesSpanForBBox(g, b){
  if (!b) return { valid:false };
  const { cell } = g;

  const vals = [b.minx, b.maxx, b.miny, b.maxy];
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

  return { valid:true, minx, maxx, miny, maxy, spanX, spanY, area };
}

function keysForBBox(g, b){
  const t = tilesSpanForBBox(g, b);
  if (!t.valid) return null;
  if (t.spanX > MAX_DIM_TILES || t.spanY > MAX_DIM_TILES) return null;
  if (!Number.isFinite(t.area) || t.area <= 0 || t.area > MAX_TILES_PER_STROKE) return null;

  const keys = new Array(t.area);
  let k = 0;

  try {
    for (let iy = t.miny; iy <= t.maxy; iy++){
      for (let ix = t.minx; ix <= t.maxx; ix++){
        if (k >= MAX_TILES_PER_STROKE) return null;
        keys[k++] = KEY(ix, iy);
      }
    }
  } catch {
    return null;
  }

  if (k !== keys.length) keys.length = k;
  return keys;
}

export function insert(g, stroke){
  g.all.add(stroke);

  const keys = keysForBBox(g, stroke.bbox);
  if (!keys) { g.overflow = true; stroke._gridKeys = null; return; }
  stroke._gridKeys = keys;
  for (let i = 0; i < keys.length; i++){
    const k = keys[i];
    let arr = g.map.get(k); if (!arr) g.map.set(k, arr = []);
    arr.push(stroke);
  }
}

export function remove(g, stroke){
  g.all.delete(stroke);
  if (!stroke._gridKeys) return;
  const keys = stroke._gridKeys;
  for (let i = 0; i < keys.length; i++){
    const k = keys[i];
    const arr = g.map.get(k); if (!arr) continue;
    const idx = arr.indexOf(stroke); if (idx !== -1) arr.splice(idx, 1);
    if (!arr.length) g.map.delete(k);
  }
  stroke._gridKeys = null;
}

export function update(g, stroke){
  remove(g, stroke);
  insert(g, stroke);
}

export function query(g, rect){
  const t = tilesSpanForBBox(g, rect);
  if (!t.valid) return new Set();

  const nonEmpty = g.map.size;

  if (g.overflow || t.area > nonEmpty || t.area > MAX_TILES_PER_QUERY) {
    return new Set(g.all);
  }

  const set = new Set();
  for (let iy = t.miny; iy <= t.maxy; iy++){
    for (let ix = t.minx; ix <= t.maxx; ix++){
      const arr = g.map.get(KEY(ix, iy));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) set.add(arr[i]);
    }
  }
  return set;
}

export function rebuildIndex(g, strokes){
  g.map.clear();
  g.all.clear();
  g.overflow = false;
  for (let i = 0; i < strokes.length; i++) insert(g, strokes[i]);
}

export function clearIndex(g){
  g.map.clear();
  g.all.clear();
  g.overflow = false;
}

export function applyWorkerIndex(g, payload, strokes){
  g.cell = payload.cell;
  g.map.clear(); g.all.clear();
  g.overflow = !!payload.overflow;
  for (const [key, idxs] of payload.tiles){
    const arr = new Array(idxs.length);
    for (let i = 0; i < idxs.length; i++) arr[i] = strokes[idxs[i]];
    g.map.set(key, arr);
  }
  for (let i = 0; i < payload.all.length; i++){
    const s = strokes[payload.all[i]];
    if (s) g.all.add(s);
  }
}

