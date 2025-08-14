// src/strokes.js
import { bboxFromPoints, growBBox } from './utils/geometry.js';
import { insert, remove, update, grid } from './spatial_index.js';
import { markDirty, scheduleRender, shouldDeferIndex } from './state.js';

function makeId(){ return (crypto?.randomUUID?.() || ('s-'+Math.random().toString(36).slice(2,10))); }

const STRIDE = 3;
const INITIAL_CAP_POINTS = 512;

function makeTA(pointsCap = INITIAL_CAP_POINTS){
  const cap = Math.max(pointsCap, 1);
  return new Float32Array(cap * STRIDE);
}
function ensureCapacityTA(stroke, wantPoints){
  const needFloats = wantPoints * STRIDE;
  if (stroke.pts.length >= needFloats) return;
  let nf = stroke.pts.length;
  while (nf < needFloats) nf *= 2;
  const next = new Float32Array(nf);
  next.set(stroke.pts.subarray(0, stroke.n));
  stroke.pts = next;
}
function pushPointTA(stroke, x, y, p){
  const nextPoints = (stroke.n/STRIDE) + 1;
  ensureCapacityTA(stroke, nextPoints);
  const i = stroke.n;
  stroke.pts[i]   = x;
  stroke.pts[i+1] = y;
  stroke.pts[i+2] = p;
  stroke.n += STRIDE;
}

const CHUNK = 128;
function initChunks(s, px, py){
  if (s.kind !== 'path') return;
  s._chunks = [{ i0: 0, i1: 0, bbox: bboxFromPoints({ x:px, y:py }) }];
}
function extendChunksOnAppend(s, px, py){
  if (s.kind !== 'path') return;
  if (!s._chunks || s._chunks.length === 0){ initChunks(s, px, py); return; }
  const last = s._chunks[s._chunks.length - 1];
  const nextIndex = last.i1 + 1;
  if ((nextIndex - last.i0 + 1) > CHUNK){
    s._chunks.push({ i0: nextIndex, i1: nextIndex, bbox: bboxFromPoints({ x:px, y:py }) });
  } else {
    last.i1 = nextIndex;
    growBBox(last.bbox, { x:px, y:py });
  }
}

/**
 * NEW unified API name: addStroke (mode can be 'draw' or 'erase').
 * Creates a PATH stroke (freehand). For shapes, use addShape().
 */
export function addStroke(state, init){
  const s = {
    id: makeId(),
    kind:'path',
    mode: init.mode || 'draw',        // 'draw' | 'erase'
    brush: init.brush,
    color: init.color,
    alpha: init.alpha,
    w: init.w,
    pts: makeTA(INITIAL_CAP_POINTS),
    n: 0,
    bbox: bboxFromPoints(init.pt),
    timestamp: performance.now(),
    _chunks: null,
    _baked: !state._bake?.active
  };
  delete s._lodCache;

  pushPointTA(s, init.pt.x, init.pt.y, init.pt.p ?? 0.5);
  initChunks(s, init.pt.x, init.pt.y);

  state.strokes.push(s);
  insert(grid, s); markDirty(); scheduleRender();
  return s;
}

export function appendPoint(stroke, pt){
  pushPointTA(stroke, pt.x, pt.y, pt.p ?? 0.5);
  growBBox(stroke.bbox, pt);
  extendChunksOnAppend(stroke, pt.x, pt.y);
  delete stroke._lodCache;

  if (!shouldDeferIndex()) update(grid, stroke);
  markDirty();
}

export function addShape(state, init){
  const s = {
    id: makeId(),
    kind:'shape',
    shape: init.shape, mode:'draw',
    brush: init.brush, color: init.color, alpha:init.alpha, w:init.w,
    start: { ...init.start }, end: { ...init.end },
    bbox: {
      minx: Math.min(init.start.x, init.end.x),
      miny: Math.min(init.start.y, init.end.y),
      maxx: Math.max(init.start.x, init.end.x),
      maxy: Math.max(init.start.y, init.end.y)
    },
    fill: !!init.fill,
    timestamp: performance.now(),
    _baked: !state._bake?.active
  };
  state.strokes.push(s);
  insert(grid, s); markDirty(); scheduleRender();
  return s;
}

export function updateShapeEnd(shape, end){
  shape.end = { ...end };
  shape.bbox.minx = Math.min(shape.start.x, shape.end.x);
  shape.bbox.maxx = Math.max(shape.start.x, shape.end.x);
  shape.bbox.miny = Math.min(shape.start.y, shape.end.y);
  shape.bbox.maxy = Math.max(shape.start.y, shape.end.y);
  if (!shouldDeferIndex()) update(grid, shape);
  markDirty();
}

export function removeStroke(state, stroke){
  const i = state.strokes.indexOf(stroke);
  if (i!==-1) state.strokes.splice(i,1);
  try { state.selection?.delete?.(stroke); } catch {}

  remove(grid, stroke);
  markDirty(); scheduleRender();
}

export function clearAll(state){
  while (state.strokes.length){
    const s = state.strokes.pop();
    try { state.selection?.delete?.(s); } catch {}
    remove(grid, s);
  }
  try { state.selection?.clear?.(); } catch {}
  markDirty(); scheduleRender();
}

export function snapshotGeometry(s){
  if (s.kind === 'path'){
    if (s.n != null && s.pts && typeof s.pts.BYTES_PER_ELEMENT === 'number'){
      return {
        kind: 'path',
        w: s.w,
        bbox: { ...s.bbox },
        pts: s.pts.slice(0, s.n),
        ptsObj: null,
        chunks: s._chunks ? s._chunks.map(c => ({ i0:c.i0, i1:c.i1, bbox:{...c.bbox} })) : null
      };
    } else {
      return {
        kind: 'path',
        w: s.w,
        bbox: { ...s.bbox },
        pts: null,
        ptsObj: (s.pts||[]).map(p => ({ x:p.x, y:p.y, p:p.p })),
        chunks: s._chunks ? s._chunks.map(c => ({ i0:c.i0, i1:c.i1, bbox:{...c.bbox} })) : null
      };
    }
  } else {
    return {
      kind: 'shape',
      w: s.w,
      bbox: { ...s.bbox },
      start: { ...s.start },
      end: { ...s.end },
      shape: s.shape,
      fill: !!s.fill
    };
  }
}

export function restoreGeometry(s, snap){
  if (snap.kind === 'path'){
    s.w = snap.w;
    s.bbox = { ...snap.bbox };
    if (snap.pts){
      s.pts = new Float32Array(snap.pts.length);
      s.pts.set(snap.pts);
      s.n = snap.pts.length;
      s._chunks = snap.chunks ? snap.chunks.map(c => ({ i0:c.i0, i1:c.i1, bbox:{...c.bbox} })) : null;
    } else {
      s.pts = snap.ptsObj.map(p => ({ x:p.x, y:p.y, p:p.p }));
      s.n = null;
      s._chunks = snap.chunks ? snap.chunks.map(c => ({ i0:c.i0, i1:c.i1, bbox:{...c.bbox} })) : null;
    }
  } else {
    s.w = snap.w;
    s.bbox = { ...snap.bbox };
    s.start = { ...snap.start };
    s.end   = { ...snap.end };
    s.shape = snap.shape;
    s.fill  = !!snap.fill;
  }
  delete s._lodCache;
}

/**
 * Transform stroke geometry by scale (sx,sy), rotation (theta), and translation (tx,ty)
 * around an origin (ox,oy). Rotation is in radians. Order: scale -> rotate -> translate.
 */
export function transformStrokeGeom(s, xf){
  const sx = Number.isFinite(xf?.sx) ? xf.sx : 1;
  const sy = Number.isFinite(xf?.sy) ? xf.sy : 1;
  const ox = Number.isFinite(xf?.ox) ? xf.ox : 0;
  const oy = Number.isFinite(xf?.oy) ? xf.oy : 0;
  const tx = Number.isFinite(xf?.tx) ? xf.tx : 0;
  const ty = Number.isFinite(xf?.ty) ? xf.ty : 0;
  const theta = Number.isFinite(xf?.theta) ? xf.theta : 0;

  const c = Math.cos(theta), sN = Math.sin(theta);

  const apply = (x, y) => {
    const rx = (x - ox) * sx;
    const ry = (y - oy) * sy;
    const rx2 = (c * rx) - (sN * ry);
    const ry2 = (sN * rx) + (c * ry);
    const nx = ox + rx2 + tx;
    const ny = oy + ry2 + ty;
    return { x: nx, y: ny };
  };

  if (s.kind === 'path'){
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;

    if (s.n != null && s.pts && typeof s.pts.BYTES_PER_ELEMENT === 'number'){
      const pts = s.pts; const n = s.n;
      for (let i = 0; i < n; i += 3){
        const a = apply(pts[i], pts[i+1]);
        pts[i]   = a.x;
        pts[i+1] = a.y;
        if (a.x < minx) minx = a.x; if (a.x > maxx) maxx = a.x;
        if (a.y < miny) miny = a.y; if (a.y > maxy) maxy = a.y;
      }
    } else if (Array.isArray(s.pts)){
      for (let i = 0; i < s.pts.length; i++){
        const p = s.pts[i];
        const a = apply(p.x, p.y);
        p.x = a.x; p.y = a.y;
        if (a.x < minx) minx = a.x; if (a.x > maxx) maxx = a.x;
        if (a.y < miny) miny = a.y; if (a.y > maxy) maxy = a.y;
      }
    }

    if (!Number.isFinite(minx)) { minx = 0; miny = 0; maxx = 0; maxy = 0; }
    s.bbox = { minx, miny, maxx, maxy };
    s._chunks = null;

  } else if (s.kind === 'shape'){
    const a = apply(s.start.x, s.start.y);
    const b = apply(s.end.x,   s.end.y);
    s.start = a; s.end = b;
    s.bbox = {
      minx: Math.min(a.x, b.x),
      miny: Math.min(a.y, b.y),
      maxx: Math.max(a.x, b.x),
      maxy: Math.max(a.y, b.y),
    };
  }
  delete s._lodCache;
}

/* ---------- Back-compat aliases (keep old imports working) ---------- */
export { addStroke as addPathStroke };
