// src/utils/hit.js
import { distSqPointSeg } from './common.js';
import { ensurePathChunks } from './path_chunks.js';

const STRIDE = 3;

function invRotateAround(p, c, theta){
  if (!theta) return { x: p.x, y: p.y };
  const s = Math.sin(-theta), co = Math.cos(-theta);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx*co - dy*s, y: c.y + dx*s + dy*co };
}

function hitRotatedRect(start, end, rotation, p, r){
  // Axis-aligned box in local space, then rotate the point back to local.
  const minx = Math.min(start.x, end.x), maxx = Math.max(start.x, end.x);
  const miny = Math.min(start.y, end.y), maxy = Math.max(start.y, end.y);
  const cx = (minx + maxx) * 0.5, cy = (miny + maxy) * 0.5;
  const lp = invRotateAround(p, {x:cx,y:cy}, rotation || 0);
  // Expand by pick radius r so edges are easy to grab too.
  return (lp.x >= minx - r && lp.x <= maxx + r &&
          lp.y >= miny - r && lp.y <= maxy + r);
}

function minDistWorld_Path(s, p){
  // Fast, robust: full scan (we only call this for a tiny set of candidates).
  let best = Infinity;
  if (s.n != null && s.pts && typeof s.pts.BYTES_PER_ELEMENT === 'number'){
    const n = Math.max(0, s.n - STRIDE);
    let ax = s.pts[0], ay = s.pts[1];
    for (let i = STRIDE; i <= n; i += STRIDE){
      const bx = s.pts[i], by = s.pts[i+1];
      const d2 = distSqPointSeg(p, [ax,ay], [bx,by]);
      if (d2 < best) best = d2;
      ax = bx; ay = by;
    }
  } else if (Array.isArray(s.pts) && s.pts.length){
    for (let i = 1; i < s.pts.length; i++){
      const d2 = distSqPointSeg(p, s.pts[i-1], s.pts[i]);
      if (d2 < best) best = d2;
    }
  }
  return Number.isFinite(best) ? Math.sqrt(best) : Infinity;
}

function minDistWorld_RectOutline(s, p){
  const minx=Math.min(s.start.x,s.end.x), maxx=Math.max(s.start.x,s.end.x);
  const miny=Math.min(s.start.y,s.end.y), maxy=Math.max(s.start.y,s.end.y);
  const t = (s.w || 1)*0.5;
  const insideX = (p.x>=minx && p.x<=maxx);
  const insideY = (p.y>=miny && p.y<=maxy);
  if (insideX && insideY){
    // distance to nearest edge from inside, minus half thickness
    const dEdge = Math.min(p.x-minx, maxx-p.x, p.y-miny, maxy-p.y);
    return Math.max(0, dEdge - t);
  }
  // Outside: distance to rectangle (corner-aware), minus half thickness
  const dx = (p.x<minx)? (minx-p.x) : (p.x>maxx)? (p.x-maxx) : 0;
  const dy = (p.y<miny)? (miny-p.y) : (p.y>maxy)? (p.y-maxy) : 0;
  return Math.max(0, Math.hypot(dx,dy) - t);
}

function minDistWorld_Ellipse(s, p){
  // Approximate but stable for selection ranking.
  const cx=(s.start.x+s.end.x)/2, cy=(s.start.y+s.end.y)/2;
  const rx=Math.max(1e-6, Math.abs(s.end.x-s.start.x)/2);
  const ry=Math.max(1e-6, Math.abs(s.end.y-s.start.y)/2);
  const t = (s.w||1)*0.5;
  const qx=(p.x-cx)/rx, qy=(p.y-cy)/ry;
  const rho = Math.hypot(qx,qy);              // 1.0 on the ellipse
  const rEff = Math.max(rx, ry);              // project back to world units
  if (s.fill){
    return (rho<=1) ? 0 : (rho-1)*rEff;
  }
  return Math.max(0, Math.abs(rho-1)*rEff - t);
}


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
    if (stroke.shape === 'text' || stroke.shape === 'image'){
      return hitRotatedRect(stroke.start, stroke.end, stroke.rotation || 0, p, r);
    }
    if (stroke.shape==='line')    return hitLine(stroke, p, r);
    if (stroke.shape==='rect')    return hitRect(stroke, p, r);
    if (stroke.shape==='ellipse') return hitEllipse(stroke, p, r, camera);
  }
  return false;
}

export function distancePxConsideringBake(stroke, pWorld, camera, bake){
  let p = pWorld;
  // If the stroke is currently being baked, compare in its source space,
  // then scale back to screen px with camera.scale * bake.s.
  const pxPerWorld =
    (bake?.active && stroke && stroke._baked === false)
      ? camera.scale * bake.s
      : camera.scale;
  if (bake?.active && stroke && stroke._baked === false){
    const is = 1 / Math.max(1e-20, bake.s);
    p = { x: pWorld.x * is - bake.tx * is, y: pWorld.y * is - bake.ty * is };
  }

  let dWorld = Infinity;
  if (stroke.kind === 'path'){
    ensurePathChunks(stroke);
    const dCenter = minDistWorld_Path(stroke, p);
    const t = (stroke.w||1)*0.5;
    dWorld = Math.max(0, dCenter - t);
  } else if (stroke.kind === 'shape'){
    if (stroke.shape === 'text' || stroke.shape === 'image'){
      const minx = Math.min(stroke.start.x, stroke.end.x);
      const maxx = Math.max(stroke.start.x, stroke.end.x);
      const miny = Math.min(stroke.start.y, stroke.end.y);
      const maxy = Math.max(stroke.start.y, stroke.end.y);
      const cx = (minx + maxx) * 0.5, cy = (miny + maxy) * 0.5;
      const lp = invRotateAround(p, {x:cx,y:cy}, stroke.rotation || 0);
      const dx = (lp.x < minx) ? (minx - lp.x) : (lp.x > maxx) ? (lp.x - maxx) : 0;
      const dy = (lp.y < miny) ? (miny - lp.y) : (lp.y > maxy) ? (lp.y - maxy) : 0;
      dWorld = Math.hypot(dx, dy); // 0 when inside; grows outside
    }
    if (stroke.shape === 'line'){
      const dCenter = Math.sqrt(distSqPointSeg(p, stroke.start, stroke.end));
      const t = (stroke.w||1)*0.5;
      dWorld = Math.max(0, dCenter - t);
    } else if (stroke.shape === 'rect'){
      dWorld = minDistWorld_RectOutline(stroke, p);
    } else if (stroke.shape === 'ellipse'){
      dWorld = minDistWorld_Ellipse(stroke, p);
    }
  }
  return Math.max(0, dWorld * pxPerWorld);
}
