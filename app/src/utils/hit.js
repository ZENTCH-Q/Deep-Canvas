// src/utils/hit.js
import { distSqPointSeg } from './common.js';
import { ensurePathChunks } from './path_chunks.js';

const STRIDE = 3;

function hitPathTypedWithRange(s, p, r, i0, i1){
  const th2 = Math.max(r, (s.w || 1) * 0.6) ** 2;
  if (s.n < 6) {
    const dx = p.x - s.pts[0], dy = p.y - s.pts[1];
    return (dx*dx + dy*dy) <= th2;
  }
  let ax = s.pts[i0], ay = s.pts[i0+1];
  for (let i = i0 + STRIDE; i <= i1; i += STRIDE){
    const bx = s.pts[i], by = s.pts[i+1];
    if (distSqPointSeg(p, [ax,ay], [bx,by]) <= th2) return true;
    ax = bx; ay = by;
  }
  return false;
}
function hitPathObjWithRange(s, p, r, i0, i1){
  const th2 = Math.max(r, (s.w || 1) * 0.6) ** 2;
  if (i1 - i0 <= 0){
    const dx = p.x - s.pts[i0].x, dy = p.y - s.pts[i0].y;
    return (dx*dx + dy*dy) <= th2;
  }
  for (let i=i0+1;i<=i1;i++){
    if (distSqPointSeg(p, s.pts[i-1], s.pts[i]) <= th2) return true;
  }
  return false;
}
function padBBox(bb, pad){
  return { minx: bb.minx - pad, miny: bb.miny - pad, maxx: bb.maxx + pad, maxy: bb.maxy + pad };
}
function pointInRect(p, r){
  return p.x>=r.minx && p.x<=r.maxx && p.y>=r.miny && p.y<=r.maxy;
}

/**
 * Path hit-test (uses chunks when available; lazily builds them on first use).
 * s: { kind:'path', pts, n, w, _chunks? }
 * p: { x, y }, r: world radius
 */
export function hitPath(s, p, r){
  ensurePathChunks(s); // lazy build + ensure bbox if missing
  const th = Math.max(r, (s.w || 1) * 0.6);
  const th2 = th * th;

  // If we have chunks, only test the ones whose bbox covers the pick with padding
  if (Array.isArray(s._chunks) && s._chunks.length){
    const pad = th;
    for (const c of s._chunks){
      if (!c || !c.bbox) continue;
      if (!pointInRect(p, padBBox(c.bbox, pad))) continue;

      if (s.n != null && s.pts && typeof s.pts.BYTES_PER_ELEMENT === 'number'){
        if (hitPathTypedWithRange(s, p, r, c.i0, c.i1)) return true;
      } else if (Array.isArray(s.pts)){
        if (hitPathObjWithRange(s, p, r, c.i0, c.i1)) return true;
      }
    }
    return false;
  }

  // Fallback: full path scan
  if (s.n != null && s.pts && typeof s.pts.BYTES_PER_ELEMENT === 'number'){
    return hitPathTypedWithRange(s, p, r, 0, Math.max(0, s.n - STRIDE));
  }
  if (Array.isArray(s.pts)){
    return hitPathObjWithRange(s, p, r, 0, Math.max(0, s.pts.length - 1));
  }
  return false;
}

export function hitLine(s, p, r){
  return distSqPointSeg(p, s.start, s.end) <= (Math.max(r,(s.w||1)*0.6))**2;
}

export function hitRect(s, p, r){
  const minx=Math.min(s.start.x,s.end.x), maxx=Math.max(s.start.x,s.end.x);
  const miny=Math.min(s.start.y,s.end.y), maxy=Math.max(s.start.y,s.end.y);
  const inside = (p.x>=minx && p.x<=maxx && p.y>=miny && p.y<=maxy);
  if (s.fill) return inside;
  const nearX = (Math.abs(p.x-minx)<=r || Math.abs(p.x-maxx)<=r) && p.y>=miny-r && p.y<=maxy+r;
  const nearY = (Math.abs(p.y-miny)<=r || Math.abs(p.y-maxy)<=r) && p.x>=minx-r && p.x<=maxx+r;
  return nearX || nearY;
}

export function hitEllipse(s, p, r, camera){
  const cx=(s.start.x+s.end.x)/2, cy=(s.start.y+s.end.y)/2;
  const rx0=Math.abs(s.end.x-s.start.x)/2;
  const ry0=Math.abs(s.end.y-s.start.y)/2;
  const minWorld = 0.5 / Math.max(1e-8, camera.scale);
  const rx=Math.max(minWorld, rx0);
  const ry=Math.max(minWorld, ry0);

  const dx=(p.x-cx)/rx, dy=(p.y-cy)/ry;
  const v = dx*dx + dy*dy;
  if (s.fill) return v <= 1;

  const tol = Math.max(r/Math.max(rx,ry), 0.02);
  return Math.abs(v - 1) <= tol*2;
}

/**
 * Central bake-aware hit test (used by picker & tools).
 */
export function isHitConsideringBake(stroke, pWorld, rWorld, bake, camera){
  let p = pWorld, r = rWorld;
  if (bake?.active && stroke && stroke._baked === false){
    const is = 1 / Math.max(1e-20, bake.s);
    p = { x: pWorld.x * is - bake.tx * is, y: pWorld.y * is - bake.ty * is };
    r = rWorld * is;
  }
  const pad = Math.max(r, (stroke.w||0)) * 1.5;
  const bb = {
    minx: stroke.bbox.minx - pad, miny: stroke.bbox.miny - pad,
    maxx: stroke.bbox.maxx + pad, maxy: stroke.bbox.maxy + pad
  };
  if (!(p.x>=bb.minx && p.x<=bb.maxx && p.y>=bb.miny && p.y<=bb.maxy)) return false;

  if (stroke.kind === 'path') return hitPath(stroke, p, r);
  if (stroke.kind === 'shape'){
    if (stroke.shape==='line')    return hitLine(stroke, p, r);
    if (stroke.shape==='rect')    return hitRect(stroke, p, r);
    if (stroke.shape==='ellipse') return hitEllipse(stroke, p, r, camera);
  }
  return false;
}
