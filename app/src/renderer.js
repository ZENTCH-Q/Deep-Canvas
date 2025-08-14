// src/renderer.js
import { visibleWorldRect } from './camera.js';
import { rectsIntersect } from './utils/geometry.js';
import { query, grid } from './spatial_index.js';

const STRIDE = 3;

const clamp01 = v => v < 0 ? 0 : (v > 1 ? 1 : v);

function tolWorld(camera, fast = false){
  const base = 0.75 / Math.max(1e-8, camera.scale);
  return fast ? base * 2.5 : base;
}
function pickEpsilon(camera, fast){
  const target = tolWorld(camera, fast);
  const levels = [0.5, 1, 2, 4, 8, 16];
  for (let i=0;i<levels.length;i++) if (levels[i] >= target) return levels[i];
  return levels[levels.length-1];
}

function hash32(s){
  let h = 2166136261 >>> 0;
  for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h += h << 13; h ^= h >>> 7; h += h << 3; h ^= h >>> 17; h += h << 5;
  return h >>> 0;
}
function rand01FromId(id){
  const h = hash32(String(id ?? '0'));
  let x = h || 1; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
  return x / 4294967295;
}
function seedFromId(id, salt){ return rand01FromId(`${id}:${salt}`) * Math.PI * 2; }
function lfo(shape, t, speed=1, phase=0){
  const x = t*speed + phase;
  if (shape==='square')   return Math.sign(Math.sin(x));
  if (shape==='triangle'){ const s = (x/Math.PI)%2; return 1 - 2*Math.abs(s-1); }
  return Math.sin(x); // sine default
}

function readCSSVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  } catch { return fallback; }
}
function getTheme(state) {
  const uiTheme = state?.ui?.theme || {};
  return {
    selStroke: uiTheme.selStroke ?? readCSSVar('--sel-stroke', '#7b8da0'),
    selFill: uiTheme.selFill ?? readCSSVar('--sel-fill', 'rgba(123,141,160,0.10)'),
    handleStroke: uiTheme.handleStroke ?? readCSSVar('--handle-stroke', '#b6c2cf'),
    handleFill: uiTheme.handleFill ?? readCSSVar('--handle-fill', 'rgba(17,20,24,0.85)'),
    handleFillActive: uiTheme.handleFillActive ?? readCSSVar('--handle-fill-active', '#3a7afe'),
    rotateArrow: uiTheme.rotateArrow ?? readCSSVar('--rotate-arrow', '#e6eaf0'),
    labelBg: uiTheme.labelBg ?? readCSSVar('--label-bg', 'rgba(17,20,24,0.85)'),
    labelStroke: uiTheme.labelStroke ?? readCSSVar('--label-stroke', 'rgba(182,194,207,0.8)'),
    labelText: uiTheme.labelText ?? readCSSVar('--label-text', '#e6eaf0'),
    marqueeStroke: uiTheme.marqueeStroke ?? readCSSVar('--marquee-stroke', '#9fb3c8'),
    marqueeFill: uiTheme.marqueeFill ?? readCSSVar('--marquee-fill', 'rgba(159,179,200,0.18)'),
  };
}

export function applyBrushStyle(ctx, camera, s, fast) {
  ctx.setLineDash([]);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (!fast && s.brush === 'dashed') {
    const dashScreen = Math.max(2, (s.w || 1) * 2.2);
    const d = dashScreen / Math.max(1e-8, camera.scale);
    ctx.setLineDash([d, d * 0.6]);
  }
}
export function strokeCommonSetup(ctx, camera, s, fast) {
  if (s.mode === 'erase') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = (s.brush === 'marker' && !fast) ? 'multiply' : 'source-over';
    ctx.globalAlpha = s.alpha ?? 1;
    if (!fast && s.brush === 'glow') {
      ctx.shadowColor = s.color;
      ctx.shadowBlur = Math.max(0, (s.w || 1) * Math.max(1, camera.scale) * 0.9);
    } else {
      ctx.shadowBlur = 0;
    }
    ctx.strokeStyle = s.color;
  }
}

function animXfFromLayers(s, _state, t){
  const layers = s?.react2?.anim?.layers;
  if (!layers || !layers.length) return null;

  let sx=1, sy=1, theta=0, tx=0, ty=0;
  const groupId = layers?.[0]?.groupId;
  const id = groupId ?? (s.id ?? 'stroke');
  const pA = seedFromId(id, 'A'), pB = seedFromId(id, 'B'), pC = seedFromId(id, 'C');

  for (const L of layers){
    if (!L?.enabled) continue;
    const spd = +L.speed || 1;
    const ph  = +L.phase || 0;
    const MOD = 1;

    switch (L.type){
      case 'spin': {
        const spdEff = spd * MOD;
        theta += spdEff * t + ph;
        break;
      }
      case 'sway': {
        const amp = (+L.amount || 0.3) * MOD;
        theta += amp * lfo(L.shape||'sine', t, spd, ph);
        break;
      }
      case 'pulse': {
        const amt = (+L.amount || 0.15) * MOD;
        const v = 1 + amt * lfo(L.shape||'sine', t, spd, ph);
        const ax = (L.axis || 'xy');
        if (ax==='x') sx *= v; else if (ax==='y') sy *= v; else { sx *= v; sy *= v; }
        break;
      }
      case 'bounce': {
        const dist = (+L.amount || +L.distance || 10) * MOD;
        const v = lfo(L.shape||'sine', t, spd, ph) * dist;
        ((L.axis||'y')==='x') ? (tx += v) : (ty += v);
        break;
      }
      case 'orbit': {
        const rx = (+L.radiusX || 12) * MOD;
        const ry = (+L.radiusY || 12) * MOD;
        const a = t*spd + ph;
        tx += Math.cos(a)*rx; ty += Math.sin(a)*ry;
        break;
      }
      case 'shake': {
        const ap = (+L.amountPos || 2) * MOD;
        const ar = (+L.amountRot || 0.02) * MOD;
        tx += ap * Math.sin(t*spd + pA);
        ty += ap * Math.cos(t*spd + pB);
        theta += ar * Math.sin(t*spd*1.37 + pC);
        break;
      }
      default: break;
    }
  }
  return { sx, sy, theta, tx, ty };
}

function hexToRgb(hex){
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex||'').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 };
}
function rgbToHex(r,g,b){
  const to = (x)=> Math.max(0,Math.min(255,Math.round(x))).toString(16).padStart(2,'0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
function rgbToHsl(r, g, b){
  r/=255; g/=255; b/=255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h, s, l=(max+min)/2;
  if (max===min){ h=s=0; }
  else{
    const d=max-min;
    s= l>0.5 ? d/(2-max-min) : d/(max+min);
    switch(max){
      case r: h=(g-b)/d+(g<b?6:0); break;
      case g: h=(b-r)/d+2; break;
      default: h=(r-g)/d+4; break;
    }
    h/=6;
  }
  return { h: h*360, s, l };
}
function hslToRgb(h, s, l){
  h/=360;
  const hue2rgb = (p,q,t)=>{
    if(t<0) t+=1; if(t>1) t-=1;
    if(t<1/6) return p+(q-p)*6*t;
    if(t<1/2) return q;
    if(t<2/3) return p+(q-p)*(2/3 - t)*6;
    return p;
  };
  let r,g,b;
  if (s===0){ r=g=b=l; }
  else{
    const q = l<0.5 ? l*(1+s) : l+s-l*s;
    const p = 2*l - q;
    r = hue2rgb(p,q,h+1/3);
    g = hue2rgb(p,q,h);
    b = hue2rgb(p,q,h-1/3);
  }
  return { r:Math.round(r*255), g:Math.round(g*255), b:Math.round(b*255) };
}
function hueShiftHex(hex, deg){
  const rgb = hexToRgb(hex); if (!rgb) return hex;
  const {h,s,l} = rgbToHsl(rgb.r, rgb.g, rgb.b);
  let hh = (h + deg) % 360; if (hh < 0) hh += 360;
  const out = hslToRgb(hh, s, l);
  return rgbToHex(out.r, out.g, out.b);
}

function applyStyleLayers(ctx, camera, s, _state, t, baseW){
  const layers = s?.react2?.style?.layers;
  if (!layers || !layers.length) return;

  let widthMul = 1;
  let alphaMul = 1;
  let hueShiftDeg = 0;
  let glowMul = 1;
  let dash = null; 

  for (const L of layers){
    if (!L?.enabled) continue;
    const spd = +L.speed || 1;
    const sig = lfo('sine', t, spd, 0); 
    const MOD = 1;

    switch (L.type) {
      case 'width': {
        const amt = (+L.amount || 0.15) * MOD;
        widthMul *= Math.max(0.05, 1 + amt*sig);
        break;
      }
      case 'opacity': {
        const amt = (+L.amount || 0.15) * MOD;
        alphaMul *= Math.max(0.05, Math.min(1, 1 + amt*sig));
        break;
      }
      case 'glow': {
        const amt = (+L.amount || 0.4) * MOD;
        glowMul = Math.max(glowMul, 1 + Math.abs(amt*sig)*2);
        break;
      }
      case 'hue': {
        hueShiftDeg += (+L.deg || 30) * sig * MOD;
        break;
      }
      case 'dash': {
        const rate = ((+L.rate || 120) * spd) * MOD; 
        const dashScreen = Math.max(2, (s.w || 1) * 2.2);
        const dashLenWorld = dashScreen / Math.max(1e-8, camera.scale);
        dash = {
          pattern: [dashLenWorld, dashLenWorld * 0.6],
          offset:  -(t * rate) / Math.max(1e-8, camera.scale)
        };
        break;
      }
      default: break;
    }
  }

  ctx.lineWidth = baseW * widthMul;
  ctx.globalAlpha *= alphaMul;

  if (s.mode !== 'erase') {
    if (!Number.isNaN(glowMul) && glowMul !== 1) {
      ctx.shadowColor = s.color;
      const baseBlur = Math.max(0, (s.w || 1) * Math.max(1, camera.scale) * 0.9);
      ctx.shadowBlur = Math.max(ctx.shadowBlur||0, baseBlur * glowMul);
    }
    if (hueShiftDeg) {
      const shifted = hueShiftHex(s.color, hueShiftDeg);
      ctx.strokeStyle = shifted;
      if (s.fill) ctx.fillStyle = shifted;
    }
  }
  if (dash) {
    try {
      ctx.setLineDash(dash.pattern);
      ctx.lineDashOffset = dash.offset;
    } catch {}
  }
}

function drawPolylineFastWorldTA(ctx, pts, n, camera, i0, i1, fast) {
  const tol = tolWorld(camera, fast);
  let off = i0 * STRIDE;
  let lx = pts[off], ly = pts[off + 1];
  for (let ip = i0 + 1; ip <= i1; ip++) {
    off = ip * STRIDE;
    const x = pts[off], y = pts[off + 1];
    const dx = x - lx, dy = y - ly;
    if ((dx * dx + dy * dy) >= tol * tol) {
      ctx.lineTo(x, y);
      lx = x; ly = y;
    }
  }
}
function drawShapeWorld(ctx, s, camera) {
  const a = s.start, b = s.end;
  if (s.shape === 'line') {
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); return;
  }
  if (s.shape === 'rect') {
    let x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    let w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    const minWorld = 0.5 / Math.max(1e-8, camera.scale);
    const cx = x + w / 2, cy = y + h / 2;
    if (w < minWorld) { w = minWorld; x = cx - w / 2; }
    if (h < minWorld) { h = minWorld; y = cy - h / 2; }
    if (s.fill) { ctx.fillStyle = ctx.strokeStyle; ctx.fillRect(x, y, w, h); }
    ctx.strokeRect(x, y, w, h); return;
  }
  if (s.shape === 'ellipse') {
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const minWorld = 0.5 / Math.max(1e-8, camera.scale);
    const rx = Math.max(minWorld, Math.abs(b.x - a.x) / 2);
    const ry = Math.max(minWorld, Math.abs(b.y - a.y) / 2);
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (s.fill) { ctx.fillStyle = ctx.strokeStyle; ctx.fill(); }
    ctx.stroke(); return;
  }
}

function invXformBBox(b, s, tx, ty) {
  const is = 1 / Math.max(1e-20, s);
  const r = {
    minx: b.minx * is - tx * is,
    miny: b.miny * is - ty * is,
    maxx: b.maxx * is - tx * is,
    maxy: b.maxy * is - ty * is
  };
  if (r.maxx < r.minx) [r.minx, r.maxx] = [r.maxx, r.minx];
  if (r.maxy < r.miny) [r.miny, r.maxy] = [r.maxy, r.miny];
  return r;
}
function perpDist(ax, ay, bx, by, px, py) {
  const ux = bx - ax, uy = by - ay;
  const vx = px - ax, vy = py - ay;
  const len = Math.hypot(ux, uy) || 1e-20;
  return Math.abs(ux * vy - uy * vx) / len;
}
function rdpSimplifyTA(pts, n, epsilon) {
  const m = Math.max(0, Math.floor(n / STRIDE));
  if (m <= 2 || !Number.isFinite(epsilon) || epsilon <= 0) {
    const out = new Float32Array(n);
    out.set(pts.subarray(0, n));
    return out;
  }
  const keep = new Uint8Array(m);
  keep[0] = 1; keep[m - 1] = 1;

  const stack = [[0, m - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const ax = pts[i0 * STRIDE], ay = pts[i0 * STRIDE + 1];
    const bx = pts[i1 * STRIDE], by = pts[i1 * STRIDE + 1];

    let maxD = -1, maxI = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const px = pts[i * STRIDE], py = pts[i * STRIDE + 1];
      const d = perpDist(ax, ay, bx, by, px, py);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilon && maxI > i0 && maxI < i1) {
      keep[maxI] = 1;
      stack.push([i0, maxI], [maxI, i1]);
    }
  }
  let cnt = 0;
  for (let i = 0; i < m; i++) if (keep[i]) cnt++;
  if (cnt < 2) {
    const out = new Float32Array(n);
    out.set(pts.subarray(0, n));
    return out;
  }
  const out = new Float32Array(cnt * STRIDE);
  let w = 0;
  for (let i = 0; i < m; i++) {
    if (!keep[i]) continue;
    const off = i * STRIDE;
    out[w] = pts[off];
    out[w + 1] = pts[off + 1];
    out[w + 2] = pts[off + 2];
    w += STRIDE;
  }
  return out;
}
function getLODView(stroke, camera, fast) {
  if (!stroke || stroke.kind !== 'path' || stroke.n == null || !stroke.pts || typeof stroke.pts.BYTES_PER_ELEMENT !== 'number') {
    return { pts: stroke?.pts, n: stroke?.n, usedLOD: false };
  }
  const orig = { pts: stroke.pts, n: stroke.n, usedLOD: false };
  if ((stroke.n / STRIDE) <= 128) return orig;

  try {
    const eps = pickEpsilon(camera, fast);
    try {
      const bb = stroke.bbox;
      const diag = Math.hypot(bb.maxx - bb.minx, bb.maxy - bb.miny);
      if (diag < eps * 3) return orig;
    } catch {}

    stroke._lodCache = stroke._lodCache || new Map();
    if (stroke._lodCache.has(eps)) {
      const cached = stroke._lodCache.get(eps);
      if (cached && cached.pts && cached.n > 0) return { ...cached, usedLOD: true };
    }
    const simplified = rdpSimplifyTA(stroke.pts, stroke.n, eps);
    const result = { pts: simplified, n: simplified.length };
    if (result.n >= stroke.n * 0.95) return orig;

    stroke._lodCache.set(eps, result);
    return { ...result, usedLOD: true };
  } catch {
    return orig;
  }
}

function drawSelectionHandles(ctx, bb, camera, theme, dpr) {
  const x0 = bb.minx, y0 = bb.miny, x1 = bb.maxx, y1 = bb.maxy;
  const cx = (x0 + x1) * 0.5;
  const px = 1 / Math.max(1e-8, dpr * camera.scale);
  const HANDLE_RADIUS_PX = 5;     
  const ROT_OFFSET_PX    = 28;   
  const LEADER_GAP_PX    = 10;       

  const r   = HANDLE_RADIUS_PX * px;
  const lw  = Math.max(px, 0.75 * px);

  // 8 resize handles
  const points = [
    [x0, y0],  [cx, y0],  [x1, y0],
    [x1, (y0+y1)/2],      [x1, y1],
    [cx, y1],  [x0, y1],  [x0, (y0+y1)/2]
  ];

  ctx.save();
  ctx.lineWidth   = lw;
  ctx.strokeStyle = theme.handleStroke || '#b6c2cf';
  ctx.fillStyle   = theme.handleFill   || 'rgba(17,20,24,0.85)';

  for (const [x,y] of points) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
  }

  // Rotation: center at y0 - 28px (screen), leader starts 10px above the edge
  const rotY = y0 - ROT_OFFSET_PX * px;
  const leadStartY = y0 - LEADER_GAP_PX * px;

  // Leader
  ctx.beginPath();
  ctx.moveTo(cx, leadStartY);
  ctx.lineTo(cx, rotY);
  ctx.stroke();

  // Nub
  ctx.beginPath();
  ctx.arc(cx, rotY, r, 0, Math.PI*2);
  ctx.fill();
  ctx.stroke();

  // Arrow hint
  try {
    ctx.save();
    ctx.lineWidth = Math.max(lw * 0.9, 0.8 * px);
    ctx.strokeStyle = theme.rotateArrow || '#e6eaf0';
    const ar = r * 0.7;
    ctx.beginPath();
    ctx.arc(cx, rotY, ar, Math.PI*0.15, Math.PI*1.3);
    ctx.stroke();
    ctx.restore();
  } catch {}

  ctx.restore();
}


function computeVisibleRange(stroke, view, pad) {
  const nPoints = (stroke.n != null) ? (stroke.n / STRIDE) : (stroke.pts?.length ?? 0);
  if (nPoints < 2) return null;

  const chunks = stroke._chunks;
  if (!chunks || chunks.length === 0) {
    return { i0: 0, i1: nPoints - 1 };
  }

  const bb = {
    minx: view.minx - pad,
    miny: view.miny - pad,
    maxx: view.maxx + pad,
    maxy: view.maxy + pad
  };

  let c0 = -1, c1 = -1;
  for (let i = 0; i < chunks.length; i++) {
    const cb = chunks[i].bbox;
    if (cb.maxx < bb.minx || cb.minx > bb.maxx || cb.maxy < bb.miny || cb.miny > bb.maxy) continue;
    if (c0 === -1) c0 = i;
    c1 = i;
  }
  if (c0 === -1) return null;

  const i0 = Math.max(0, chunks[c0].i0 - 1);
  const i1 = Math.min(nPoints - 1, chunks[c1].i1 + 1);
  return { i0, i1 };
}

export function render(state, camera, ctx, canvasLike, opts = {}) {
  const theme = getTheme(state);

  let dpr = Math.max(1, opts.dpr || 1);
  const skipSnapshotPath = !!opts.skipSnapshotPath;
  const fast = !!state._navActive && !opts.forceTrueComposite;

  if (state._navActive && !skipSnapshotPath) dpr = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const cw = Math.floor(canvasLike.clientWidth * dpr);
  const ch = Math.floor(canvasLike.clientHeight * dpr);
  ctx.clearRect(0, 0, cw, ch);

  if (state.background && state.background.alpha > 0) {
    const prevA = ctx.globalAlpha;
    ctx.globalAlpha = state.background.alpha;
    ctx.fillStyle = state.background.color || '#000';
    ctx.fillRect(0, 0, cw, ch);
    ctx.globalAlpha = prevA;
  }

  if (!skipSnapshotPath && state._navActive && state._navBmp && state._navCam0) {
    const s0 = state._navCam0.s, tx0 = state._navCam0.tx, ty0 = state._navCam0.ty;
    const s1 = camera.scale, tx1 = camera.tx, ty1 = camera.ty;
    const a = s1 / Math.max(1e-20, s0);
    const bx = tx1 - a * tx0;
    const by = ty1 - a * ty0;
    const sbx = Math.round(dpr * bx) / dpr;
    const sby = Math.round(dpr * by) / dpr;

    ctx.setTransform(dpr * a, 0, 0, dpr * a, dpr * sbx, dpr * sby);
    ctx.drawImage(state._navBmp, 0, 0);
    return { visible: 0, tiles: grid.map.size, complete: true };
  }
  if (!skipSnapshotPath && state._navActive && state._navCam0 && (state._navBuf || state._navBmp)) {
    const s0 = state._navCam0.s, tx0 = state._navCam0.tx, ty0 = state._navCam0.ty;
    const s1 = camera.scale, tx1 = camera.tx, ty1 = camera.ty;
    const a = s1 / Math.max(1e-20, s0);
    const bx = tx1 - a * tx0;
    const by = ty1 - a * ty0;
    const src = state._navBuf || state._navBmp;

    const sbx = Math.round(dpr * bx) / dpr;
    const sby = Math.round(dpr * by) / dpr;

    const prevSmooth = ctx.imageSmoothingEnabled;
    const prevQual = ctx.imageSmoothingQuality;
    ctx.imageSmoothingEnabled = true;
    try { ctx.imageSmoothingQuality = 'low'; } catch {}

    ctx.setTransform(dpr * a, 0, 0, dpr * a, dpr * sbx, dpr * sby);
    ctx.drawImage(src, 0, 0);

    ctx.imageSmoothingEnabled = prevSmooth;
    try { ctx.imageSmoothingQuality = prevQual; } catch {}
    return { visible: 0, tiles: grid.map.size, complete: true };
  }

  ctx.setTransform(
    dpr * camera.scale, 0, 0,
    dpr * camera.scale,
    dpr * camera.tx, dpr * camera.ty
  );

  const view = visibleWorldRect(camera, { clientWidth: canvasLike.clientWidth, clientHeight: canvasLike.clientHeight });

  const baking = !!state._bake?.active;
  const transforming = !!state._transformActive;
  const bake = state._bake;

  const qPad = 4 / Math.max(1e-8, camera.scale);
  const qView = {
    minx: view.minx - qPad,
    miny: view.miny - qPad,
    maxx: view.maxx + qPad,
    maxy: view.maxy + qPad
  };
  let candidateSet = (baking || transforming) ? null : query(grid, qView);
  if (baking || transforming || !candidateSet || candidateSet.size === 0) {
    candidateSet = new Set(state.strokes);
  }

  if (!baking) {
    ctx.save();
    const padClip = 2 / Math.max(1e-8, camera.scale);
    ctx.beginPath();
    ctx.rect(view.minx - padClip, view.miny - padClip, (view.maxx - view.minx) + padClip * 2, (view.maxy - view.miny) + padClip * 2);
    ctx.clip();
  }

  let visibleCount = 0;
  const tiles = grid.map.size;

  const strokes = state.strokes;
  const tNow = performance.now() / 1000;

  for (let i = 0; i < strokes.length; i++) {
    const s0 = strokes[i];
    if (!candidateSet.has(s0)) continue;
    const brush = (s0.brush === 'taper' || s0.brush === 'square') ? 'pen' : s0.brush;
    const s = (brush === s0.brush) ? s0 : { ...s0, brush };

    const unbaked = baking && !s._baked;

    const padW = (s.w || 0) * (unbaked ? bake.s : 1);
    const bb = unbaked
      ? {
          minx: s.bbox.minx * bake.s + bake.tx,
          miny: s.bbox.miny * bake.s + bake.ty,
          maxx: s.bbox.maxx * bake.s + bake.tx,
          maxy: s.bbox.maxy * bake.s + bake.ty, 
        }
      : s.bbox;

    const bbPad = { minx: bb.minx - padW, miny: bb.miny - padW, maxx: bb.maxx + padW, maxy: bb.maxy + padW };
    if (!rectsIntersect(bbPad, view)) continue;
    visibleCount++;
    applyBrushStyle(ctx, camera, s, fast);
    strokeCommonSetup(ctx, camera, s, fast);
    const baseW = Math.max(0.75 / Math.max(1, camera.scale), (s.w || 1));
    ctx.lineWidth = baseW;
    if (unbaked) { ctx.save(); ctx.transform(bake.s, 0, 0, bake.s, bake.tx, bake.ty); }
    const axf = animXfFromLayers(s, state, tNow);
    let animApplied = false;
    if (axf) {
      let cx, cy;
      let lp = null;
      try {
        lp = s?.react2?.anim?.layers?.find(l => l?.enabled && l?.pivot)?.pivot || null;
      } catch {}
      if (lp) {
        if (unbaked) {
          cx = lp.x * bake.s + bake.tx;
          cy = lp.y * bake.s + bake.ty;
        } else {
          cx = lp.x; cy = lp.y;
        }
      } else {
        cx = (bb.minx + bb.maxx) * 0.5;
        cy = (bb.miny + bb.maxy) * 0.5;
      }
      ctx.save();
      ctx.translate(cx, cy);
      if (axf.theta) ctx.rotate(axf.theta);
      if (axf.sx !== 1 || axf.sy !== 1) ctx.scale(axf.sx, axf.sy);
      ctx.translate(-cx, -cy);
      if (axf.tx || axf.ty) ctx.translate(axf.tx, axf.ty);
      animApplied = true;
    }
    applyStyleLayers(ctx, camera, s, state, tNow, baseW);
    if (s.kind === 'path') {
      if (s.pts && s.n != null) {
        const viewTA = getLODView(s, camera, fast);
        const pts = viewTA.pts, n = viewTA.n;
        if (!pts || n < STRIDE * 2) { if (animApplied) ctx.restore(); if (unbaked) ctx.restore(); continue; }
        if (viewTA.usedLOD) {
          ctx.beginPath();
          ctx.moveTo(pts[0], pts[1]);
          drawPolylineFastWorldTA(ctx, pts, n, camera, 0, (n / STRIDE) - 1, fast);
        } else {
          const viewInStrokeSpace = unbaked ? invXformBBox(view, bake.s, bake.tx, bake.ty) : view;
          const vr = computeVisibleRange(s, viewInStrokeSpace, Math.max(1, ctx.lineWidth) * 2);
          if (!vr) { if (animApplied) ctx.restore(); if (unbaked) ctx.restore(); continue; }
          let off = vr.i0 * STRIDE;
          ctx.beginPath();
          ctx.moveTo(pts[off], pts[off + 1]);
          drawPolylineFastWorldTA(ctx, pts, n, camera, vr.i0, vr.i1, fast);
        }

        if (s.fill && s.mode !== 'erase') {
          try { ctx.closePath(); } catch {}
          const prevAlpha = ctx.globalAlpha;
          const prevOp = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fill();
          ctx.globalCompositeOperation = prevOp;
          ctx.globalAlpha = prevAlpha;
        }

        if (!fast && s.brush === 'glow' && s.mode !== 'erase') {
          const sa = ctx.globalAlpha, lw = ctx.lineWidth;
          ctx.globalAlpha = Math.min(1, sa * 0.6);
          ctx.lineWidth = lw * 1.8;
          ctx.stroke();
          ctx.globalAlpha = sa; ctx.lineWidth = lw;
        }
        ctx.stroke();
      } else {
        const pts = s.pts || [];
        if (pts.length < 2) { if (animApplied) ctx.restore(); if (unbaked) ctx.restore(); continue; }
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        const tw = tolWorld(camera, fast);
        let lx = pts[0].x, ly = pts[0].y;
        for (let k = 1; k < pts.length; k++) {
          const p = pts[k], dx = p.x - lx, dy = p.y - ly;
          if ((dx * dx + dy * dy) >= tw * tw) { ctx.lineTo(p.x, p.y); lx = p.x; ly = p.y; }
        }
        if (s.fill && s.mode !== 'erase') {
          try { ctx.closePath(); } catch {}
          const prevAlpha = ctx.globalAlpha;
          const prevOp = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fill();
          ctx.globalCompositeOperation = prevOp;
          ctx.globalAlpha = prevAlpha;
        }
        if (!fast && s.brush === 'glow' && s.mode !== 'erase') {
          const sa = ctx.globalAlpha, lw = ctx.lineWidth;
          ctx.globalAlpha = Math.min(1, sa * 0.6);
          ctx.lineWidth = lw * 1.8;
          drawShapeWorld(ctx, s, camera);
          ctx.globalAlpha = sa; ctx.lineWidth = lw;
        }
        ctx.stroke();
      }
    } else if (s.kind === 'shape') {
      if (!fast && s.brush === 'glow' && s.mode !== 'erase') {
        const sa = ctx.globalAlpha, lw = ctx.lineWidth;
        ctx.globalAlpha = Math.min(1, sa * 0.6);
        ctx.lineWidth = lw * 1.8;
        drawShapeWorld(ctx, s, camera);
        ctx.globalAlpha = sa; ctx.lineWidth = lw;
      }
      drawShapeWorld(ctx, s, camera);
    }

    if (animApplied) ctx.restore();
    if (unbaked) ctx.restore();
    try { ctx.lineDashOffset = 0; } catch {}
    ctx.setLineDash([]); ctx.shadowBlur = 0; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  if (state.selection && state.selection.size) {
    const bakeActive = !!state._bake?.active;
    const b = state._bake;
    let minx=Infinity, miny=Infinity, maxx=-Infinity, maxy=-Infinity;
    for (const s of state.selection) {
      if (!state.strokes.includes(s)) continue;
      let bb = s.bbox;
      if (bakeActive && !s._baked) {
        bb = { minx: bb.minx * b.s + b.tx, miny: bb.miny * b.s + b.ty, maxx: bb.maxx * b.s + b.tx, maxy: bb.maxy * b.s + b.ty };
      }
      if (bb.minx < minx) minx = bb.minx;
      if (bb.miny < miny) miny = bb.miny;
      if (bb.maxx > maxx) maxx = bb.maxx;
      if (bb.maxy > maxy) maxy = bb.maxy;
    }
    if (Number.isFinite(minx)) {
      const bb = { minx, miny, maxx, maxy };
      const px = 1 / Math.max(1e-8, dpr * camera.scale);

      ctx.save();
      ctx.lineWidth = Math.max(px, 0.75 * px);
      ctx.setLineDash([]);
      ctx.strokeStyle = theme.selStroke;
      ctx.fillStyle = theme.selFill;

      const x = bb.minx, y = bb.miny;
      const w = bb.maxx - bb.minx, h = bb.maxy - bb.miny;
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fill(); ctx.stroke();
      ctx.restore();
      drawSelectionHandles(ctx, bb, camera, theme, dpr);

      const wPx = Math.max(0, Math.round(w * camera.scale));
      const hPx = Math.max(0, Math.round(h * camera.scale));
      const label = `${wPx} × ${hPx}px`;

      const sp = camera.worldToScreen({ x: bb.maxx, y: bb.maxy });
      ctx.setTransform(1,0,0,1,0,0);
      const pad = 6 * dpr;
      ctx.font = `${12 * dpr}px system-ui,-apple-system,Segoe UI,Roboto,sans-serif`;
      const metrics = ctx.measureText(label);
      const lw2 = Math.ceil(metrics.width + pad * 2);
      const lh = Math.ceil(18 * dpr);
      const lx = Math.min(cw - lw2 - 4 * dpr, Math.max(4 * dpr, sp.x*dpr - lw2));
      const ly = Math.min(ch - lh - 4 * dpr, Math.max(4 * dpr, sp.y*dpr + 8 * dpr));
      ctx.fillStyle = theme.labelBg;
      ctx.fillRect(lx, ly, lw2, lh);
      ctx.strokeStyle = theme.labelStroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(lx + 0.5, ly + 0.5, lw2 - 1, lh - 1);
      ctx.fillStyle = theme.labelText;
      ctx.fillText(label, lx + pad, ly + lh - 5 * dpr);

      ctx.setTransform(
        dpr * camera.scale, 0, 0,
        dpr * camera.scale,
        dpr * camera.tx, dpr * camera.ty
      );
    }
  }

  if (state._marquee) {
    ctx.save();
    const px = 1 / Math.max(1e-8, dpr * camera.scale);
    ctx.lineWidth = Math.max(px, 0.75 * px);
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.strokeStyle = theme.marqueeStroke;
    ctx.fillStyle = theme.marqueeFill;
    const m = state._marquee;
    const x = Math.min(m.minx, m.maxx), y = Math.min(m.miny, m.maxy);
    const w = Math.abs(m.maxx - m.minx), h = Math.abs(m.maxy - m.miny);
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  if (!baking) ctx.restore?.();

  return { visible: visibleCount, tiles, complete: true };
}
