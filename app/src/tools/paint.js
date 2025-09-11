// src/tools/paint.js
import { scheduleRender, markDirty } from '../state.js';
import { query, grid } from '../spatial_index.js';

import { distSqPointSeg } from '../utils/common.js';
import { worldTol } from '../utils/pick.js';

const STRIDE = 3;
const ENC_WIN_PX = 280;  
const GAP_PX     = 3;   
const SEED_PAD   = 1;    

function hitPolylinePathStroke(s, p, tol) {
  let minD2 = Infinity;
  if (s.n != null && s.pts && typeof s.pts.BYTES_PER_ELEMENT === 'number') {
    const n = s.n;
    for (let i = 0; i + STRIDE < n; i += STRIDE) {
      const ax = s.pts[i], ay = s.pts[i + 1];
      const bx = s.pts[i + 3], by = s.pts[i + 4];
      const d2 = distSqPointSeg(p, [ax, ay], [bx, by]);
      if (d2 < minD2) minD2 = d2;
    }
  } else if (Array.isArray(s.pts) && s.pts.length > 1) {
    for (let i = 0; i + 1 < s.pts.length; i++) {
      const a = s.pts[i], b = s.pts[i + 1];
      const d2 = distSqPointSeg(p, a, b);
      if (d2 < minD2) minD2 = d2;
    }
  } else { return false; }
  return minD2 <= tol * tol;
}

function pointInRectShape(s, p) {
  const x = Math.min(s.start.x, s.end.x);
  const y = Math.min(s.start.y, s.end.y);
  const w = Math.abs(s.end.x - s.start.x);
  const h = Math.abs(s.end.y - s.start.y);
  return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
}
function nearRectEdge(s, p, tol) {
  const x = Math.min(s.start.x, s.end.x);
  const y = Math.min(s.start.y, s.end.y);
  const w = Math.abs(s.end.x - s.start.x);
  const h = Math.abs(s.end.y - s.start.y);
  const insidePad = p.x >= x - tol && p.x <= x + w + tol && p.y >= y - tol && p.y <= y + h + tol;
  if (!insidePad) return false;
  const dx = Math.min(Math.abs(p.x - x), Math.abs(p.x - (x + w)));
  const dy = Math.min(Math.abs(p.y - y), Math.abs(p.y - (y + h)));
  return Math.min(dx, dy) <= tol;
}
function pointInEllipseShape(s, p, camera) {
  const cx = (s.start.x + s.end.x) / 2, cy = (s.start.y + s.end.y) / 2;
  const rx0 = Math.abs(s.end.x - s.start.x) / 2;
  const ry0 = Math.abs(s.end.y - s.start.y) / 2;
  const minWorld = 0.5 / Math.max(1e-8, camera.scale);
  const rx = Math.max(minWorld, rx0);
  const ry = Math.max(minWorld, ry0);
  if (rx < 1e-6 || ry < 1e-6) return false;
  const dx = (p.x - cx) / rx, dy = (p.y - cy) / ry;
  return (dx * dx + dy * dy) <= 1;
}

function nearEllipseEdge(s, p, tol, camera) {
  const cx = (s.start.x + s.end.x) / 2, cy = (s.start.y + s.end.y) / 2;
  const rx0 = Math.abs(s.end.x - s.start.x) / 2;
  const ry0 = Math.abs(s.end.y - s.start.y) / 2;
  const minWorld = 0.5 / Math.max(1e-8, camera.scale);
  const rx = Math.max(minWorld, rx0);
  const ry = Math.max(minWorld, ry0);
  if (rx < 1e-6 || ry < 1e-6) return false;
  const dx = (p.x - cx) / rx, dy = (p.y - cy) / ry;
  const v = dx*dx + dy*dy;
  const band = Math.max(tol / Math.max(rx, ry), 0.02);
  return Math.abs(v - 1) <= band * 2;
}

function isEnclosedByLocalStrokes(state, camera, p) {
  const halfPx = ENC_WIN_PX / 2;
  const worldHalf = halfPx / Math.max(1e-8, camera.scale);
  const rect = { minx: p.x - worldHalf, miny: p.y - worldHalf, maxx: p.x + worldHalf, maxy: p.y + worldHalf };
  const nearby = query(grid, rect);
  if (!nearby || nearby.size === 0) return false;
  const off = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(ENC_WIN_PX, ENC_WIN_PX)
    : (() => { const c = document.createElement('canvas'); c.width = ENC_WIN_PX; c.height = ENC_WIN_PX; return c; })();
  const ctx = off.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,ENC_WIN_PX,ENC_WIN_PX);
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,ENC_WIN_PX,ENC_WIN_PX);
  const S = ENC_WIN_PX / Math.max(1e-8, rect.maxx - rect.minx);
  const Tx = -rect.minx * S, Ty = -rect.miny * S;
  ctx.setTransform(S,0,0,S,Tx,Ty);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = '#000';

  for (const s of nearby) {
    const extra = GAP_PX;
    const lw = Math.max(1, (s.w || 1) * S + extra);
    ctx.lineWidth = lw;

    if (s.kind === 'path') {
      if (s.n != null && s.pts && typeof s.pts.BYTES_PER_ELEMENT === 'number') {
        const n = s.n; if (n < STRIDE*2) continue;
        ctx.beginPath();
        ctx.moveTo(s.pts[0], s.pts[1]);
        for (let i=3;i<n;i+=STRIDE) ctx.lineTo(s.pts[i], s.pts[i+1]);
        ctx.stroke();
      } else if (Array.isArray(s.pts) && s.pts.length > 1) {
        ctx.beginPath();
        ctx.moveTo(s.pts[0].x, s.pts[0].y);
        for (let i=1;i<s.pts.length;i++) ctx.lineTo(s.pts[i].x, s.pts[i].y);
        ctx.stroke();
      }
    } else if (s.kind === 'shape') {
      const a = s.start, b = s.end;
      if (s.shape === 'line') {
        ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
      } else if (s.shape === 'rect') {
        const x = Math.min(a.x,b.x), y = Math.min(a.y,b.y);
        const w = Math.abs(b.x-a.x), h = Math.abs(b.y-a.y);
        ctx.strokeRect(x,y,w,h);
      } else if (s.shape === 'ellipse') {
        const cx=(a.x+b.x)/2, cy=(a.y+b.y)/2, rx=Math.max(0.5,Math.abs(b.x-a.x)/2), ry=Math.max(0.5,Math.abs(b.y-a.y)/2);
        ctx.beginPath(); ctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2); ctx.stroke();
      }
    }
  }

  const sx = (p.x * S + Tx) | 0, sy = (p.y * S + Ty) | 0;
  const seedX = Math.max(1, Math.min(ENC_WIN_PX-2, sx + SEED_PAD));
  const seedY = Math.max(1, Math.min(ENC_WIN_PX-2, sy + SEED_PAD));
  const img = ctx.getImageData(0, 0, ENC_WIN_PX, ENC_WIN_PX);
  const data = img.data; 
  const w = img.width, h = img.height;
  const idx = (x,y) => ((y * w) + x) << 2;
  const seen = new Uint8Array(w * h);
  const qx = new Int32Array(w*h);
  const qy = new Int32Array(w*h);
  let qs=0, qe=0, reachedEdge=false;

  function isWall(x,y){
    const i = idx(x,y);
    return data[i] < 128; 
  }
  function push(x,y){
    const k = y*w + x; if (seen[k]) return;
    seen[k]=1; qx[qe]=x; qy[qe]=y; qe++;
  }

  if (!isWall(seedX, seedY)) push(seedX, seedY);
  while (qs < qe){
    const x = qx[qs], y = qy[qs]; qs++;
    if (x === 0 || y === 0 || x === w-1 || y === h-1) { reachedEdge = true; break; }
    const nbs = [[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
    for (let i=0;i<4;i++){
      const nx=nbs[i][0], ny=nbs[i][1];
      if (nx<=0 || ny<=0 || nx>=w-1 || ny>=h-1) continue;
      if (isWall(nx,ny)) continue;
      push(nx,ny);
    }
  }
  return !reachedEdge;
}

function pickNearestTopmost(strokes, p) {
  let best = null, bestD2 = Infinity;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    if (!s || !s.bbox) continue;
    let d2 = Infinity;
    if (s.kind === 'path') {
      if (s.n != null && s.pts && typeof s.pts.BYTES_PER_ELEMENT === 'number') {
        const n = s.n;
        for (let j=0;j+STRIDE<n;j+=STRIDE) {
          const ax=s.pts[j], ay=s.pts[j+1], bx=s.pts[j+3]??ax, by=s.pts[j+4]??ay;
          d2 = Math.min(d2, distSqPointSeg(p, [ax,ay], [bx,by]));
        }
      } else if (Array.isArray(s.pts) && s.pts.length>1) {
        for (let j=0;j+1<s.pts.length;j++){
          const a=s.pts[j], b=s.pts[j+1];
          d2 = Math.min(d2, distSqPointSeg(p, a, b));
        }
      }
    } else if (s.kind === 'shape') {
      if (s.shape === 'line') {
        d2 = distSqPointSeg(p, s.start, s.end);
      } else {
        const cx=(s.start.x+s.end.x)/2, cy=(s.start.y+s.end.y)/2;
        const dx=p.x-cx, dy=p.y-cy; d2 = dx*dx+dy*dy;
      }
    }
    if (d2 < bestD2) { bestD2 = d2; best = s; }
  }
  return best;
}

export function paintAtPoint({ canvas, camera, state }, e){
  const rect = canvas.getBoundingClientRect();
  const sp = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const p  = camera.screenToWorld(sp);

  const tol = worldTol(camera);
  const strokesArr = state.strokes;

  let hit = null;
  let action = null; 
  for (let i = strokesArr.length - 1; i >= 0; i--) {
    const s = strokesArr[i];
    if (!s || !s.bbox) continue;
    const pad = Math.max(tol, s.w || 1);
    if (p.x < s.bbox.minx - pad || p.x > s.bbox.maxx + pad || p.y < s.bbox.miny - pad || p.y > s.bbox.maxy + pad) continue;

    if (s.kind === 'shape') {
      if (s.shape === 'rect') {
        if (nearRectEdge(s, p, Math.max(pad, s.w || 1))) { hit = s; action = 'stroke'; break; }
        if (pointInRectShape(s, p)) { hit = s; action = 'fill'; break; }
      } else if (s.shape === 'ellipse') {
        if (nearEllipseEdge(s, p, Math.max(pad, s.w || 1), camera)) { hit = s; action = 'stroke'; break; }
        if (pointInEllipseShape(s, p, camera)) { hit = s; action = 'fill'; break; }
      } else if (s.shape === 'line') {
        if (hitPolylinePathStroke({ kind:'path', pts:[{x:s.start.x,y:s.start.y},{x:s.end.x,y:s.end.y}], n:null }, p, Math.max(pad, s.w || 1))) {
          hit = s; action = 'stroke'; break;
        }
      }
    } else if (s.kind === 'path') {
      if (hitPolylinePathStroke(s, p, Math.max(pad, s.w || 1))) { hit = s; action = 'stroke'; break; }
    }
  }
  // Do not infer enclosure; only fill when the point is inside a shape.
  // Otherwise, treat as background fill.

  const newColor = state.settings.color || '#88ccff';
  const newAlpha = state.settings.opacity ?? 1;

  if (!hit) {
    const prevBg = { ...state.background };
    state.background = { color: newColor, alpha: newAlpha };
    state.history?.pushBackground?.(prevBg, { ...state.background });
    markDirty(); scheduleRender();
    return;
  }
  const prev = { color: hit.color, alpha: hit.alpha, fill: !!hit.fill, fillColor: hit.fillColor ?? null, fillAlpha: hit.fillAlpha ?? null };
  if (action === 'fill') {
    hit.fill = true;
    hit.fillColor = newColor;
    hit.fillAlpha = newAlpha;
  } else { 
    // Stroke edge recolor
    hit.color = newColor;
    hit.alpha = newAlpha;
  }

  const next = { color: hit.color, alpha: hit.alpha, fill: !!hit.fill, fillColor: hit.fillColor ?? null, fillAlpha: hit.fillAlpha ?? null };
  state.history?.pushStyle?.(hit, prev, next);
  markDirty(); scheduleRender();
}
