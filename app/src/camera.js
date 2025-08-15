// src/camera.js
export function makeCamera(scale = 1, tx = 0, ty = 0){
  return {
    scale, tx, ty,
    worldToScreen(p){ return { x: p.x * this.scale + this.tx, y: p.y * this.scale + this.ty }; },
    screenToWorld(p){ return { x: (p.x - this.tx) / this.scale, y: (p.y - this.ty) / this.scale }; },
    zoomAround(screenPt, factor, min=1e-6, max=1e6) {
      let ns = this.scale * factor;
      ns = Math.max(min, Math.min(max, ns));
      const w = this.screenToWorld(screenPt);
      this.tx = screenPt.x - w.x * ns;
      this.ty = screenPt.y - w.y * ns;
      this.scale = ns;
      if (!Number.isFinite(this.scale)) this.scale = 1;
      if (!Number.isFinite(this.tx) || !Number.isFinite(this.ty)) { this.tx = 0; this.ty = 0; }
    }
  };
}

const SCALE_LOW  = 1e-3;  
const SCALE_HIGH = 8e2;   
const POS_HIGH   = 1e8;  

function xformBBox(b, s, tx, ty){
  return {
    minx: b.minx * s + tx,
    miny: b.miny * s + ty,
    maxx: b.maxx * s + tx,
    maxy: b.maxy * s + ty
  };
}
function bakePathPointsTyped(st, s, tx, ty, budgetStop){
  const pts = st.pts;
  const n = st.n; 
  let j = st._bakeJ || 0;
  while (j < n){
    const x = pts[j], y = pts[j+1];
    pts[j]   = x * s + tx;
    pts[j+1] = y * s + ty;
    j += 3;
    if (budgetStop()) { st._bakeJ = j; return false; }
  }
  st._bakeJ = 0;
  return true;
}
function bakePathPointsObjects(st, s, tx, ty, budgetStop){
  const pts = st.pts;
  let j = st._bakeJ || 0;
  while (j < pts.length){
    const p = pts[j];
    p.x = p.x * s + tx;
    p.y = p.y * s + ty;
    j++;
    if (budgetStop()) { st._bakeJ = j; return false; }
  }
  st._bakeJ = 0;
  return true;
}
function bakeChunks(st, s, tx, ty, budgetStop){
  const chunks = st._chunks;
  if (!chunks || !chunks.length) return true;
  let k = st._bakeK || 0;
  while (k < chunks.length){
    chunks[k].bbox = xformBBox(chunks[k].bbox, s, tx, ty);
    k++;
    if (budgetStop()) { st._bakeK = k; return false; }
  }
  st._bakeK = 0;
  return true;
}

let _renormPromise = null;

export function renormalizeIfNeeded(camera, strokes, opts={}, state){
  const needs =
    camera.scale < SCALE_LOW ||
    camera.scale > SCALE_HIGH ||
    Math.abs(camera.tx) > POS_HIGH ||
    Math.abs(camera.ty) > POS_HIGH;

  if (!needs) return false;
  if (_renormPromise) return true;

  const budgetMs = Math.max(2, opts.budgetMs ?? 4);
  const s  = camera.scale;
  const tx = camera.tx;
  const ty = camera.ty;

  camera.scale = 1; camera.tx = 0; camera.ty = 0;

  if (state){
    state._bake = { s, tx, ty, active: true };
    for (const st of strokes) {
      st._baked = false;
      st._bakeJ = 0; 
      st._bakeK = 0;
    }
  }

  let i = 0; 

  _renormPromise = new Promise(resolve => {
    function step(){
      const t0 = performance.now();
      const budgetStop = () => (performance.now() - t0 > budgetMs);

      while (i < strokes.length){
        const st = strokes[i];

        if (st){
          if (st.kind === 'path'){
            let pointsDone = true;
            if (st.pts && st.n != null) {
              pointsDone = bakePathPointsTyped(st, s, tx, ty, budgetStop);
              if (!pointsDone) { requestAnimationFrame(step); return; }
            } else if (Array.isArray(st.pts)) {
              pointsDone = bakePathPointsObjects(st, s, tx, ty, budgetStop);
              if (!pointsDone) { requestAnimationFrame(step); return; }
            }
            const chunksDone = bakeChunks(st, s, tx, ty, budgetStop);
            if (!chunksDone) { requestAnimationFrame(step); return; }
            st._chunks = null;
            st._bakeK = 0;
          } else if (st.kind === 'shape'){
            st.start.x = st.start.x * s + tx;
            st.start.y = st.start.y * s + ty;
            st.end.x   = st.end.x   * s + tx;
            st.end.y   = st.end.y   * s + ty;
          }

          st.w = (st.w || 0) * s;
          st.bbox = xformBBox(st.bbox, s, tx, ty);
          delete st._lodCache;
          st.timestamp = performance.now();
          st._baked = true;
        }

        i++;
        if (budgetStop()) { requestAnimationFrame(step); return; }
      }

      if (state) state._bake = null;
      _renormPromise = null;
      resolve();
    }

    requestAnimationFrame(step);
  });

  return true;
}

export function whenRenormalized(){
  return _renormPromise ?? Promise.resolve();
}

export function visibleWorldRect(camera, canvas){
  const tl = camera.screenToWorld({ x: 0, y: 0 });
  const br = camera.screenToWorld({ x: canvas.clientWidth, y: canvas.clientHeight });
  return {
    minx: Math.min(tl.x, br.x),
    miny: Math.min(tl.y, br.y),
    maxx: Math.max(tl.x, br.x),
    maxy: Math.max(tl.y, br.y)
  };
}

const GC_CENTER_LIMIT   = 1e8;    
const GC_CENTER_QUANTA  = 2048;   
const GC_RADIUS_LIMIT   = 1e12;  
const GC_RADIUS_TARGET  = 1e7;   

function docBBox(strokes){
  if (!strokes.length) return { minx:0, miny:0, maxx:0, maxy:0 };
  let minx=Infinity, miny=Infinity, maxx=-Infinity, maxy=-Infinity;
  for (let i=0;i<strokes.length;i++){
    const b = strokes[i].bbox; if (!b) continue;
    if (b.minx < minx) minx = b.minx;
    if (b.miny < miny) miny = b.miny;
    if (b.maxx > maxx) maxx = b.maxx;
    if (b.maxy > maxy) maxy = b.maxy;
  }
  if (!Number.isFinite(minx)) return { minx:0, miny:0, maxx:0, maxy:0 };
  return { minx, miny, maxx, maxy };
}
function xformBBoxInPlace(b, s, dx, dy){
  b.minx = b.minx * s + dx;
  b.miny = b.miny * s + dy;
  b.maxx = b.maxx * s + dx;
  b.maxy = b.maxy * s + dy;
}
function transformStroke(st, s, dx, dy){
  if (st.kind === 'path'){
    if (st.pts && st.n != null){
      const pts = st.pts; const n = st.n;
      for (let j=0;j<n;j+=3){ pts[j] = pts[j]*s + dx; pts[j+1] = pts[j+1]*s + dy; }
    } else if (Array.isArray(st.pts)){
      for (let j=0;j<st.pts.length;j++){ const p=st.pts[j]; p.x = p.x*s + dx; p.y = p.y*s + dy; }
    }
  } else if (st.kind === 'shape'){
    st.start.x = st.start.x*s + dx; st.start.y = st.start.y*s + dy;
    st.end.x   = st.end.x  *s + dx; st.end.y   = st.end.y  *s + dy;
  }
  st.w = (st.w || 0) * s;
  xformBBoxInPlace(st.bbox, s, dx, dy);
 st._chunks = null;
 delete st._lodCache;
 try {
   const layers = st?.react2?.anim?.layers;
   if (Array.isArray(layers)) {
     for (const L of layers) {
       if (L && L.pivot && Number.isFinite(L.pivot.x) && Number.isFinite(L.pivot.y)) {
         L.pivot.x = L.pivot.x * s + dx;
         L.pivot.y = L.pivot.y * s + dy;
       }
     }
   }
 } catch {}
}

export function worldGCIfNeeded(state, camera, canvas){
  let changed = false;
  if (canvas){
    const sc = { x: canvas.clientWidth/2, y: canvas.clientHeight/2 };
    const wc = camera.screenToWorld(sc);
    const ax = Math.abs(wc.x), ay = Math.abs(wc.y);
    if (ax > GC_CENTER_LIMIT || ay > GC_CENTER_LIMIT){
      const txw = Math.round(wc.x / GC_CENTER_QUANTA) * GC_CENTER_QUANTA;
      const tyw = Math.round(wc.y / GC_CENTER_QUANTA) * GC_CENTER_QUANTA;
      if (txw || tyw){
        for (let i=0;i<state.strokes.length;i++){
          transformStroke(state.strokes[i], 1, -txw, -tyw);
        }
        camera.tx += txw * camera.scale;
        camera.ty += tyw * camera.scale;
        changed = true;
      }
    }
  }

  const bb = docBBox(state.strokes);
  const radius = Math.max(Math.abs(bb.minx), Math.abs(bb.maxx), Math.abs(bb.miny), Math.abs(bb.maxy));
  if (radius > GC_RADIUS_LIMIT){
    const g = Math.max(2, Math.floor(radius / GC_RADIUS_TARGET));
    const s = 1 / g;
    for (let i=0;i<state.strokes.length;i++){
      transformStroke(state.strokes[i], s, 0, 0);
    }
    camera.scale *= g; 
    changed = true;
  }

  return changed;
}
