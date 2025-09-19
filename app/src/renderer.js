// src/renderer.js
import { visibleWorldRect } from './camera.js';
import { rectsIntersect } from './utils/geometry.js';
import { query, grid } from './spatial_index.js';
import { relayoutTextShape } from './tools/text.js';
import { scheduleRender, markDirty } from './state.js';

const STRIDE = 3;

const clamp01 = v => v < 0 ? 0 : (v > 1 ? 1 : v);

function tolWorld(camera, fast = false){
  const base = 0.75 / Math.max(1e-8, camera.scale);
  return fast ? base * 1.6 : base;
}
function pickEpsilon(camera, fast){
  // Base pixel tolerance (px). Quantize to avoid flicker across tiny scale changes.
  const pxTol = fast ? 0.6 : 0.3;
  const pxQ = Math.max(0.25, Math.round(pxTol * 4) / 4);
  return pxQ / Math.max(1e-8, camera.scale);
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
  if (shape==='saw')     { const s=(x/(2*Math.PI))%1; return (s*2)-1; }
  return Math.sin(x); 
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

export function applyBrushStyle(ctx, camera, s, fast, dpr = 1) {
  ctx.setLineDash([]);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (!fast && s.brush === 'dashed') {
    const dashScreen = Math.max(2, (s.w || 1) * 2.2);
    // use CTM if available
    let k = Math.max(1e-8, camera.scale * Math.max(1, dpr));
    try { const m = ctx.getTransform(); k = Math.max(1e-8, Math.hypot(m.a, m.b)); } catch {}
    const d = dashScreen / k;
    ctx.setLineDash([d, d * 0.6]);
  }
}
export function strokeCommonSetup(ctx, camera, s, fast) {
  if (s.mode === 'erase') {
    // Paint with the background color instead of cutting holes, so eraser matches canvas color
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    try {
      const bg = (s.bgColor || s.backgroundColor || s.canvasBg || (typeof window !== 'undefined' ? window._endless?.state?.background?.color : null)) || '#ffffff';
      ctx.strokeStyle = bg;
    } catch {
      ctx.strokeStyle = '#ffffff';
    }
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

function setTextFontWorld(ctx, s, camera) {
  const scale = Math.max(1e-8, camera.scale);
  const fsWorld = (s.fontSize || (24 / scale));
  const pxScreen = Math.max(1, Math.round(fsWorld * scale));
  const pxWorld  = pxScreen / scale;
  const fam = s.fontFamily || 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
  ctx.font = `${pxWorld}px ${fam}`;
}

function drawTextBoxWorld(ctx, camera, s, dpr = 1) {
  // Unrotated box + center
  const a = s.start, b = s.end;
  const minx = Math.min(a.x, b.x), miny = Math.min(a.y, b.y);
  const maxx = Math.max(a.x, b.x), maxy = Math.max(a.y, b.y);
  const w = maxx - minx, h = maxy - miny;
  const cx = (minx + maxx) * 0.5, cy = (miny + maxy) * 0.5;
  s.bbox = { minx, miny, maxx, maxy };

  // Precomputed wrapping from text.js
  const fs = s.fontSize || (24 / Math.max(1e-8, camera.scale));
  const pad = 0.25 * fs;
  const lineH = (s.lineHeight || 1.25) * fs;
  const lines = (s.lines || []);

  // Local (centered) coordinates of the box
  const lx = -w / 2, ly = -h / 2;

  ctx.save();

  // Color/alpha
  ctx.globalAlpha = Math.max(0.05, Math.min(1, s.alpha ?? 1));
  const styled = s?.react2?.style?.layers?.some(l => l?.enabled && l?.type && l.type !== 'none') ? ctx.strokeStyle : null;
  ctx.fillStyle = styled || s.color || ctx.strokeStyle || '#e6eaf0';
  setTextFontWorld(ctx, s, camera);
  const align = s.align || 'center';
  ctx.textAlign = (align === 'left') ? 'left' : (align === 'right' ? 'right' : 'center');
  ctx.textBaseline = 'top';
  const wantsStroke = !!s.textOutline;
  if (wantsStroke) {
    const scale = Math.max(1e-8, camera.scale);
    const fs = s.fontSize || (24 / scale);
    const outlinePx = Math.max(1, Math.round((s.outlinePx ?? fs * 0.08) * scale)); // ~8% of fs
    ctx.lineWidth = outlinePx / scale;                 // world units
    if (!styled) ctx.strokeStyle = ctx.fillStyle;      // match color if style layer didn't set one
  }

  // Apply rotation first, THEN clip in local space (fixes cut-off)
  ctx.translate(cx, cy);
  if (s.rotation) ctx.rotate(s.rotation);

  // Clip the rotated rectangle in local coords
  ctx.beginPath();
  ctx.rect(lx, ly, w, h);
  ctx.clip();

  // Local text start (pad applied in local space)
  const localCenterX = 0;
  const localTop  = ly + pad;
  const lx0 = lx + pad; // left padded edge
  const rx0 = (-lx) - pad; // right padded edge (since -lx = w/2)

  // Selection highlight (rendered behind text when a selection exists)
  if (Number.isFinite(s.selStart) && Number.isFinite(s.selEnd) && s.selStart !== s.selEnd) {
    const a = Math.min(s.selStart, s.selEnd);
    const b = Math.max(s.selStart, s.selEnd);
    try {
      ctx.save();
      const prevFill = ctx.fillStyle;
      ctx.fillStyle = 'rgba(58,122,254,0.28)';
      for (let i = 0; i < lines.length; i++) {
        const info = (s._lineInfo || [])[i];
        const text = lines[i] || '';
        const startIdx = info ? info.startIdx : 0;
        const endIdx   = info ? info.endIdx   : startIdx + text.length;
        const sa = Math.max(0, Math.min(text.length, a - startIdx));
        const sb = Math.max(0, Math.min(text.length, b - startIdx));
        if (sb <= 0 || sa >= text.length || sa >= sb) continue;
        const fullW = ctx.measureText(text).width;
        const preW  = ctx.measureText(text.slice(0, sa)).width;
        const selW  = ctx.measureText(text.slice(sa, sb)).width;
        const xBase = (align === 'left') ? lx0 : (align === 'right' ? (rx0 - fullW) : (localCenterX - fullW/2));
        const x = xBase + preW;
        const y = localTop + i * lineH;
        ctx.fillRect(x, y, selW, lineH);
      }
      ctx.fillStyle = prevFill;
      ctx.restore();
    } catch {}
  }

  // Draw lines
  let y = localTop;
  const xAnchor = (align === 'left') ? lx0 : (align === 'right' ? rx0 : localCenterX);
  for (let i = 0; i < lines.length; i++) {
    // centered around the box’s center (we already clipped to the padded box)
    ctx.fillText(lines[i], xAnchor, y);
    if (wantsStroke) ctx.strokeText(lines[i], xAnchor, y);
    y += lineH;
  }

  // Draw caret (your caret is computed in unrotated local terms, so this mapping is correct)
  if (s.editing && s._showCaret && s._caret) {
    const px = 1 / Math.max(1e-8, dpr * camera.scale);
    ctx.beginPath();
    const cxLocal = (s._caret.x - cx);   // same mapping you had before
    const cyLocal = (s._caret.y - cy);
    ctx.lineWidth = Math.max(px, 0.75 * px);
    const prev = ctx.strokeStyle;
    ctx.strokeStyle = s.color || '#e6eaf0';
    ctx.moveTo(cxLocal,            cyLocal);
    ctx.lineTo(cxLocal,            cyLocal + s._caret.h);
    ctx.stroke();
    ctx.strokeStyle = prev;
  }

  ctx.restore();
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
      case 'pendulum': {
        const ar = (+L.amountRot || 0.35) * MOD;    
        const shape = L.shape || 'sine';
        theta += ar * lfo(shape, t, spd, ph);
        break;
      }
      case 'float': {
        const ap = (+L.amountPos || 6) * MOD;
        const ar = (+L.amountRot || 0.06) * MOD;
        const shape = L.shape || 'sine';
        tx += ap * 0.7 * lfo(shape, t, spd*0.8, ph + pA);
        ty += ap * 1.0 * lfo('triangle', t, spd*0.6, ph + pB);
        theta += ar * lfo('saw', t, spd*0.5, ph + pC);
        break;
      }
      case 'drift': {
        const ap = (+L.amountPos || 10) * MOD;
        const shape = L.shape || 'sine';
        tx += ap * 0.9 * Math.sin(t*spd*0.8 + pA) + ap*0.25*lfo('triangle', t, spd*0.33, ph+pB);
        ty += ap * 0.9 * Math.cos(t*spd*0.7 + pB) + ap*0.25*lfo(shape,       t, spd*0.47, ph+pC);
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

function hslShiftHex(hex, {ds=0, dl=0}){
  const rgb = hexToRgb(hex); if (!rgb) return hex;
  let {h,s,l} = rgbToHsl(rgb.r, rgb.g, rgb.b);
  s = Math.max(0, Math.min(1, s + ds));
  l = Math.max(0, Math.min(1, l + dl));
  const out = hslToRgb(h, s, l);
  return rgbToHex(out.r, out.g, out.b);
}

function applyStyleLayers(ctx, camera, s, _state, t, baseW, dpr = 1){

  const layers = s?.react2?.style?.layers;
  if (!layers || !layers.length) return;

  let widthMul = 1;
  let alphaMul = 1;
  let hueShiftDeg = 0;
  let glowMul = 1;
  let dash = null; 
  let satShift = 0;
  let lightShift = 0;
  let blurPx = 0;

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
        let k = Math.max(1e-8, camera.scale * Math.max(1, dpr));
        try {
          const m = ctx.getTransform();
          k = Math.max(1e-8, Math.hypot(m.a, m.b));
        } catch {}

        const gapFactor = (Number.isFinite(L.gapFactor) ? L.gapFactor : 0.6);

        if (Number.isFinite(L.dashLen)) {
          const dashLenPx = Math.max(1, L.dashLen);
          const dashLenWorld = dashLenPx / k;
          const patternLenWorld = dashLenWorld * (1 + gapFactor);
          const cyclesPerSec = (+L.speed || 1) * MOD;

          const off = -(t * cyclesPerSec * patternLenWorld);
          dash = {
            pattern: [dashLenWorld, dashLenWorld * gapFactor],
            offset: patternLenWorld ? (off % patternLenWorld) : off
          };
        } else {
          const ratePxPerSec = ((+L.rate || 120) * (+L.speed || 1)) * MOD;
          const dashScreenPx = Math.max(2, (s.w || 1) * 2.2);
          const dashLenWorld = dashScreenPx / k;
          const patternLenWorld = dashLenWorld * (1 + gapFactor);

          const off = -(t * (ratePxPerSec / k));
          dash = {
            pattern: [dashLenWorld, dashLenWorld * gapFactor],
            offset: patternLenWorld ? (off % patternLenWorld) : off
          };
        }
        break;
      }


      case 'saturation': {
        const amt = (+L.amount || 0.25) * MOD;
        satShift += amt * sig;
        break;
      }
      case 'lightness': {
        const amt = (+L.amount || 0.25) * MOD;
        lightShift += amt * sig;
        break;
      }
      case 'blur': {
        const amt = Math.abs((+L.amount || 1) * MOD);
        const px = Math.max(0, amt * Math.abs(sig) * Math.max(0.5, (s.w||1) * camera.scale * 0.6));
        blurPx = Math.max(blurPx, px);
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
    let col = s.color;
    if (hueShiftDeg) col = hueShiftHex(col, hueShiftDeg);
    if (satShift || lightShift) {
      col = hslShiftHex(col, {
        ds: satShift,
        dl: lightShift
      });
    }
    ctx.strokeStyle = col;
    if (s.fill) ctx.fillStyle = col;
  }
  if (dash) {
    try {
      ctx.setLineDash(dash.pattern);
      ctx.lineDashOffset = dash.offset;
    } catch {}
  }
  if (blurPx > 0) {
    try { ctx.filter = `blur(${blurPx}px)`; } catch {}
  }
}

function drawPolylineFastWorldTA(ctx, pts, n, camera, i0, i1, fast, tolOverride) {
  const tol = Number.isFinite(tolOverride) ? tolOverride : tolWorld(camera, fast);
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

let __fsw = null;   // { el, input, plus, minus, bind(state), update(target,camera,canvas) }

function rightMidWorldOfText(s){
  const minx = Math.min(s.start.x, s.end.x), maxx = Math.max(s.start.x, s.end.x);
  const miny = Math.min(s.start.y, s.end.y), maxy = Math.max(s.start.y, s.end.y);
  const cx = (minx + maxx) * 0.5, cy = (miny + maxy) * 0.5;
  const hw = (maxx - minx) * 0.5;
  const th = s.rotation || 0;
  const co = Math.cos(th), si = Math.sin(th);
  return { x: cx + hw * co, y: cy + hw * si };
}

function ensureFSWidget(){
  if (__fsw) return __fsw;

  const el = document.createElement('div');
  let currentShape = null;
  function hide(){ 
    el.style.display = 'none'; 
    currentShape = null; 
  }
  // expose to tools (used on cancel)
  try { window.__dcHideTextSizeUI = hide; } catch {}
  // Mark as UI so tools ignore its events
  el.setAttribute('data-dc-ui', 'true');
  el.style.position = 'absolute';
  el.style.left = '-9999px';
  el.style.top  = '-9999px';
  el.style.zIndex = '99999';
  el.style.display = 'none';
  el.style.pointerEvents = 'auto';
  el.setAttribute('data-dc-ui', 'true');
  // pill styling (inline)
  el.style.background = 'rgba(17,20,24,0.92)';
  el.style.border = '1px solid rgba(182,194,207,0.5)';
  el.style.borderRadius = '8px';
  el.style.padding = '6px 8px';
  el.style.boxShadow = '0 4px 14px rgba(0,0,0,0.35)';
  el.style.font = '12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
  el.style.color = '#e6eaf0';

  el.innerHTML = `
    <button data-minus style="
      width:22px;height:22px;border-radius:6px;
      border:1px solid rgba(182,194,207,0.45);
      background:#15181f;color:#e6eaf0;cursor:pointer;">-</button>
    <input data-input type="number" min="4" max="512" step="1" style="
      width:52px;height:22px;border-radius:6px;padding:0 6px;
      border:1px solid rgba(182,194,207,0.45);
      background:#0f131a;color:#e6eaf0;text-align:right;margin:0 6px;" />
    <button data-plus style="
      width:22px;height:22px;border-radius:6px;
      border:1px solid rgba(182,194,207,0.45);
      background:#15181f;color:#e6eaf0;cursor:pointer;margin-left:6px;">+</button>
    <div style="height:6px"></div>
    <div data-align-row style="display:flex;gap:6px;align-items:center;justify-content:center">
      <button data-align="left" title="Align Left" style="width:22px;height:22px;border-radius:6px;border:1px solid rgba(182,194,207,0.45);background:#15181f;color:#e6eaf0;cursor:pointer">L</button>
      <button data-align="center" title="Align Center" style="width:22px;height:22px;border-radius:6px;border:1px solid rgba(182,194,207,0.45);background:#15181f;color:#e6eaf0;cursor:pointer">C</button>
      <button data-align="right" title="Align Right" style="width:22px;height:22px;border-radius:6px;border:1px solid rgba(182,194,207,0.45);background:#15181f;color:#e6eaf0;cursor:pointer">R</button>
    </div>
    <div data-font-row style="display:flex;gap:6px;align-items:center;justify-content:center;margin-top:6px">
      <select data-font style="height:24px;border-radius:6px;padding:0 6px;border:1px solid rgba(182,194,207,0.45);background:#15181f;color:#e6eaf0;max-width:220px">
        <option value="system-ui,-apple-system,Segoe UI,Roboto,sans-serif">System</option>
        <option value="Segoe UI">Segoe UI</option>
        <option value="Roboto">Roboto</option>
        <option value="Arial, Helvetica, sans-serif">Arial</option>
        <option value="Georgia, 'Times New Roman', serif">Serif (Georgia)</option>
        <option value="'Times New Roman', Times, serif">Times New Roman</option>
        <option value="'Courier New', Courier, monospace">Courier New</option>
        <option value="'Caveat', system-ui,-apple-system,Segoe UI,Roboto,sans-serif">Caveat (Handwritten)</option>
        <option value="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace">Monospace</option>
      </select>
    </div>
  `;

  const input = el.querySelector('[data-input]');
  const minus = el.querySelector('[data-minus]');
  const plus  = el.querySelector('[data-plus]');
  const alignButtons = {
    left:   el.querySelector('[data-align="left"]'),
    center: el.querySelector('[data-align="center"]'),
    right:  el.querySelector('[data-align="right"]'),
  };
  const fontSel = el.querySelector('[data-font]');

  let bindState = null; // { state, camera }

  function setPx(px){
    if (!bindState || !currentShape) return;
    const cam = bindState.camera;
    const fsWorld = px / Math.max(1e-8, cam.scale);
    currentShape.fontSize = Math.max(1 / Math.max(1e-8, cam.scale), Math.min(2048, fsWorld));
    relayoutTextShape(currentShape, cam);
    markDirty(); scheduleRender();
  }

  minus.addEventListener('click', () => {
    const v = Math.max(4, (+(input.value||0)) - 1);
    input.value = v; setPx(v);
  });
  plus.addEventListener('click', () => {
    const v = Math.min(512, (+(input.value||0)) + 1);
    input.value = v; setPx(v);
  });

  // align
  Object.entries(alignButtons).forEach(([key, btn]) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      // update align and reflow
      const cam = bindState?.camera || camera;
      if (currentShape) { currentShape.align = (key === 'left' || key === 'right') ? key : 'center'; try { relayoutTextShape(currentShape, cam); } catch {} markDirty(); scheduleRender(); }
    });
  });
  // font select
  if (fontSel) {
    fontSel.addEventListener('change', () => {
      if (!currentShape) return;
      const fam = String(fontSel.value || '').trim();
      const cam = bindState?.camera || camera;
      currentShape.fontFamily = fam || 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      try { relayoutTextShape(currentShape, cam); } catch {}
      // Persist chosen font into state so it becomes part of the document's UI settings
      try { bindState?.state && (bindState.state.settings = { ...(bindState.state.settings || {}), fontFamily: fam }); } catch {}
      markDirty(); scheduleRender();
    });
    // prevent TextTool from intercepting typing while select has focus
    ['keydown','keypress','keyup'].forEach(type=>{
      fontSel.addEventListener(type, ev => { ev.stopPropagation(); }, { capture:false });
    });
  }
  input.addEventListener('change', () => {
    let v = +(input.value||0);
    if (!Number.isFinite(v)) v = 12;
    v = Math.max(4, Math.min(512, v));
    input.value = v; setPx(v);
  });
  ['keydown','keypress','keyup'].forEach(type=>{
    input.addEventListener(type, ev => {
      ev.stopPropagation();
      // let the input keep default behavior so typing works
    }, { capture:false });
  });

  for (const elc of [el, input, minus, plus, alignButtons.left, alignButtons.center, alignButtons.right, fontSel]) {
    ['pointerdown','mousedown'].forEach(type=>{
      elc.addEventListener(type, evt => { evt.stopPropagation(); }, { capture: true });
    });
  }

  document.addEventListener('pointerdown', (ev) => {
    const host = el.parentElement;
    if (bindState?.state?.tool !== 'text') { hide(); return; }
    if (host && !host.contains(ev.target)) hide();
  }, true);

  function bind(state, camera){ bindState = { state, camera }; }
  function update(targetShape, camera, canvasLike){
    // keep the widget inside the canvas container so it stacks like other pills
    const host = canvasLike?.parentElement || canvasLike || document.body;
    if (el.parentNode !== host) host.appendChild(el);

    // Hide if text tool isn't active or canvas/host is hidden
    if (!bindState?.state || bindState.state.tool !== 'text' || 
        !host || (host instanceof HTMLElement && host.offsetParent === null) ||
        !targetShape || targetShape.shape !== 'text' || !targetShape.editing){
      hide();
      return;
    }
    // Hide if text bbox is offscreen (not visible in current view)
    try {
      const view = visibleWorldRect(camera, canvasLike);
      const bb = targetShape.bbox || null;
      if (!bb || !rectsIntersect(bb, view)) { el.style.display = 'none'; currentShape = null; return; }
    } catch {}
    currentShape = targetShape;
    const px = Math.round((currentShape.fontSize || (24 / Math.max(1e-8, camera.scale))) * camera.scale);
    if (document.activeElement !== input) input.value = px;
    // reflect font selection
    try {
      if (fontSel) {
        const fam = String(currentShape.fontFamily || 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif');
        let found = false;
        for (const opt of Array.from(fontSel.options)) { if (opt.value === fam) { found = true; break; } }
        if (!found) { const o = document.createElement('option'); o.value = fam; o.textContent = fam.length>36? fam.slice(0,34)+'�' : fam; fontSel.appendChild(o); }
        fontSel.value = fam;
      }
    } catch {}
    // reflect alignment
    try {
      const al = currentShape.align || 'center';
      if (alignButtons) {
        for (const k of Object.keys(alignButtons)) {
          const btn = alignButtons[k]; if (!btn) continue;
          btn.style.outline = (k === al) ? '2px solid #3a7afe' : 'none';
          btn.style.outlineOffset = (k === al) ? '1px' : '0';
          btn.style.background = (k === al) ? '#0f131a' : '#15181f';
        }
      }
    } catch {}
    const w = rightMidWorldOfText(currentShape);
    const sp = camera.worldToScreen(w);
    const rect = host.getBoundingClientRect();
    const x = sp.x + 10;
    const y = sp.y - 18;
    el.style.display = 'block';
    el.style.left = `${Math.round(x)}px`;
    el.style.top  = `${Math.round(y)}px`;
  }
  __fsw = { el, input, plus, minus, bind, update };
  return __fsw;
}

function drawSelectionHandlesRotatedText(ctx, s, camera, theme, dpr) {
  const bb = s.bbox;
  const x0 = bb.minx, y0 = bb.miny, x1 = bb.maxx, y1 = bb.maxy;
  const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5;

  const px = 1 / Math.max(1e-8, dpr * camera.scale);
  let HANDLE_RADIUS_PX = 5;     
  const ROT_OFFSET_PX    = 28;   
  const LEADER_GAP_PX    = 10;       

  const r  = HANDLE_RADIUS_PX * px;           // handle radius in world units
  const lw = Math.max(px, 0.75 * px);         // stroke width in world units

  const w = x1 - x0, h = y1 - y0;
  const lx = -w / 2, ly = -h / 2;
  const rx =  w / 2, by =  h / 2;

  ctx.save();
  ctx.translate(cx, cy);
  if (s.rotation) ctx.rotate(s.rotation);

  // selection rect (rotated)
  ctx.save();
  ctx.lineWidth   = lw;
  ctx.strokeStyle = theme.selStroke;
  ctx.fillStyle   = theme.selFill;
  ctx.beginPath();
  ctx.rect(lx, ly, w, h);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // handles (8) with hover highlight
  const handlePoints = [
    ['nw', lx, ly], ['n', 0,  ly], ['ne', rx, ly],
    ['e',  rx, 0],               ['se', rx, by],
    ['s',  0,  by], ['sw', lx, by], ['w',  lx, 0]
  ];
  for (const [key, x, y] of handlePoints) {
    const isHover = s && s._hoverHandle === key;
    ctx.beginPath();
    const prevFill = ctx.fillStyle, prevStroke = ctx.strokeStyle, prevLW = ctx.lineWidth;
    if (isHover) {
      ctx.fillStyle = theme.handleHoverFill || '#3a7afe';
      ctx.strokeStyle = theme.handleHoverStroke || '#dce6ff';
      ctx.lineWidth = Math.max(px*1.25, 1.5*px);
    } else {
      ctx.strokeStyle = theme.handleStroke;
      ctx.fillStyle   = theme.handleFill;
      ctx.lineWidth   = lw;
    }
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (isHover) { ctx.fillStyle = prevFill; ctx.strokeStyle = prevStroke; ctx.lineWidth = prevLW; }
  }

  // rotation handle + leader
  const rotY       = ly - ROT_OFFSET_PX * px;
  const leaderFrom = ly - LEADER_GAP_PX * px;

  ctx.beginPath();
  ctx.moveTo(0, leaderFrom);
  ctx.lineTo(0, rotY);
  ctx.stroke();

  {
    const isHover = s && s._hoverHandle === 'rot';
    const prevFill = ctx.fillStyle, prevStroke = ctx.strokeStyle, prevLW = ctx.lineWidth;
    if (isHover) {
      ctx.fillStyle = theme.handleHoverFill || '#3a7afe';
      ctx.strokeStyle = theme.handleHoverStroke || '#dce6ff';
      ctx.lineWidth = Math.max(px*1.25, 1.5*px);
    }
    ctx.beginPath();
    ctx.arc(0, rotY, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (isHover) { ctx.fillStyle = prevFill; ctx.strokeStyle = prevStroke; ctx.lineWidth = prevLW; }
  }

  

  // arrow accent
  try {
    ctx.save();
    ctx.lineWidth = Math.max(lw * 0.9, 0.8 * px);
    ctx.strokeStyle = theme.rotateArrow || '#e6eaf0';
    const ar = r * 0.7;
    ctx.beginPath();
    ctx.arc(0, rotY, ar, Math.PI * 0.15, Math.PI * 1.3);
    ctx.stroke();
    ctx.restore();
  } catch {}

  // move handle at 45° from top-right corner for non-text shapes
  if (s && s.kind === 'shape' && s.shape !== 'text') {
    try {
      ctx.beginPath();
      const diag = (ROT_OFFSET_PX * px) / Math.SQRT2;
      const mvx = rx + diag;
      const mvy = ly - diag;
      const isHover = s && s._hoverHandle === 'move';
      const prevFill = ctx.fillStyle, prevStroke = ctx.strokeStyle, prevLW = ctx.lineWidth;
      if (isHover) {
        ctx.fillStyle = theme.handleHoverFill || '#3a7afe';
        ctx.strokeStyle = theme.handleHoverStroke || '#dce6ff';
        ctx.lineWidth = Math.max(px*1.25, 1.5*px);
      }
      ctx.arc(mvx, mvy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (isHover) { ctx.fillStyle = prevFill; ctx.strokeStyle = prevStroke; ctx.lineWidth = prevLW; }
    } catch {}
  }

  // move handle at 45� from top-right corner (text only)
  if (s && s.shape === 'text') {
    try {
      ctx.beginPath();
      const diag = (ROT_OFFSET_PX * px) / Math.SQRT2;
      const mvx = rx + diag;
      const mvy = ly - diag;
      const isHover = s && s._hoverHandle === 'move';
      const prevFill = ctx.fillStyle, prevStroke = ctx.strokeStyle, prevLW = ctx.lineWidth;
      if (isHover) {
        ctx.fillStyle = theme.handleHoverFill || '#3a7afe';
        ctx.strokeStyle = theme.handleHoverStroke || '#dce6ff';
        ctx.lineWidth = Math.max(px*1.25, 1.5*px);
      }
      ctx.arc(mvx, mvy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (isHover) { ctx.fillStyle = prevFill; ctx.strokeStyle = prevStroke; ctx.lineWidth = prevLW; }
    } catch {}
  }

  ctx.restore();
}

function drawShapeWorld(ctx, s, camera, dpr = 1) {
  const a = s.start, b = s.end;
  if (s.shape === 'text') {
    drawTextBoxWorld(ctx, camera, s, dpr);
    return;
  }
  if (s.shape === 'image') {
    try {
      const minx = Math.min(a.x, b.x), miny = Math.min(a.y, b.y);
      const maxx = Math.max(a.x, b.x), maxy = Math.max(a.y, b.y);
      const w = Math.max(1e-6, maxx - minx);
      const h = Math.max(1e-6, maxy - miny);

      // Image cache per-src
      window.__dc_img_cache = window.__dc_img_cache || new Map();
      const cache = window.__dc_img_cache;
      let rec = null;
      const key = s.src || s._src || null;
      if (key) {
        rec = cache.get(key);
        if (!rec) {
          const img = new Image();
          try { img.decoding = 'async'; } catch {}
          img.onload = () => { try { markDirty(); scheduleRender(); } catch {} };
          img.onerror = () => { try { markDirty(); scheduleRender(); } catch {} };
          img.src = key;
          rec = { img };
          cache.set(key, rec);
        }
      }
      const img = (s.img && s.img.complete) ? s.img : (rec?.img || null);
      if (!img || !img.complete) {
        // Placeholder: faint rect until image loads
        ctx.save();
        ctx.globalAlpha = Math.min(0.35, ctx.globalAlpha);
        ctx.fillStyle = '#8884';
        ctx.strokeStyle = '#aaa8';
        ctx.beginPath(); ctx.rect(minx, miny, w, h); ctx.fill(); ctx.stroke();
        ctx.restore();
        return;
      }

      const cx = (minx + maxx) * 0.5, cy = (miny + maxy) * 0.5;
      ctx.save();
      ctx.translate(cx, cy);
      if (s.rotation) ctx.rotate(s.rotation);

      const prevSmooth = ctx.imageSmoothingEnabled;
      const prevQual = ctx.imageSmoothingQuality;
      try { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; } catch {}
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.imageSmoothingEnabled = prevSmooth;
      try { ctx.imageSmoothingQuality = prevQual; } catch {}
      ctx.restore();
    } catch {}
    return;
  }
  if (s.shape === 'line') {
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); return;
  }
  if (s.shape === 'rect') {
    // draw rect in a rotated local frame (if s.rotation is set)
    let x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    let w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    const minWorld = 0.5 / Math.max(1e-8, camera.scale);
    const cx = x + w / 2, cy = y + h / 2;
    if (w < minWorld) { w = minWorld; x = cx - w / 2; }
    if (h < minWorld) { h = minWorld; y = cy - h / 2; }

    ctx.save();
    if (s.rotation) { ctx.translate(cx, cy); ctx.rotate(s.rotation); ctx.translate(-cx, -cy); }
    const lx = cx - w/2, ly = cy - h/2;
    if (s.fill) {
      ctx.save();
      if (s.fillAlpha != null) ctx.globalAlpha = s.fillAlpha;
      ctx.fillStyle = s.fillColor || ctx.strokeStyle;
      ctx.fillRect(lx, ly, w, h);
      ctx.restore();
    }
    ctx.strokeRect(lx, ly, w, h);
    ctx.restore();
    return;
  }
  if (s.shape === 'ellipse') {
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const minWorld = 0.5 / Math.max(1e-8, camera.scale);
    const rx = Math.max(minWorld, Math.abs(b.x - a.x) / 2);
    const ry = Math.max(minWorld, Math.abs(b.y - a.y) / 2);
    ctx.beginPath();
    // Canvas ellipse supports a rotation argument directly:
    ctx.ellipse(cx, cy, rx, ry, s.rotation || 0, 0, Math.PI * 2);
    if (s.fill) {
      ctx.save();
      if (s.fillAlpha != null) ctx.globalAlpha = s.fillAlpha;
      ctx.fillStyle = s.fillColor || ctx.strokeStyle;
      ctx.fill();
      ctx.restore();
    }
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
  const Ctor = pts?.constructor || Float32Array;
  const m = Math.max(0, Math.floor(n / STRIDE)); // number of points
  if (m <= 2 || !Number.isFinite(epsilon) || epsilon <= 0) {
    const out = new Ctor(n);
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
    const out = new Ctor(n);
    out.set(pts.subarray(0, n));
    return out;
  }
  const out = new Ctor(cnt * STRIDE);
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
function getLODView(stroke, camera, fast, state) {
  if (!stroke || stroke.kind !== 'path' || stroke.n == null || !stroke.pts || typeof stroke.pts.BYTES_PER_ELEMENT !== 'number') {
    return { pts: stroke?.pts, n: stroke?.n, usedLOD: false };
  }
  const orig = { pts: stroke.pts, n: stroke.n, usedLOD: false };
  if ((stroke.n / STRIDE) <= 128) return orig;

  try {
    // If we want exact geometry or are zoomed in past threshold, skip LOD entirely
    const simplifyDisableAt = state?._perf?.simplifyDisableAtScale ?? 1.25;
    if (state?._renderExact || camera.scale >= simplifyDisableAt) return orig;

    const pxTol = state?._perf?.lodPxTol ?? (fast ? 0.6 : 0.3);
    const epsBase = (Math.max(0.25, Math.round(pxTol * 4) / 4)) / Math.max(1e-8, camera.scale);
    const w = Math.max(0.5, stroke.w || 1);
    const eps = Math.min(epsBase, w * 0.5); 
    try {
      const bb = stroke.bbox;
      const diag = Math.hypot(bb.maxx - bb.minx, bb.maxy - bb.miny);
      if (diag < eps * 3) return orig;
    } catch {}

    // Cache by quantized pixel epsilon for stability
    const pxEps = Math.round((eps * Math.max(1e-8, camera.scale)) * 4) / 4; // quantize in px
    const key = `px:${pxEps}`;
    stroke._lodCache = stroke._lodCache || new Map();
    if (stroke._lodCache.has(key)) {
      const cached = stroke._lodCache.get(key);
      if (cached && cached.pts && cached.n > 0) return { ...cached, usedLOD: true };
    }
    const simplified = rdpSimplifyTA(stroke.pts, stroke.n, eps);
    const result = { pts: simplified, n: simplified.length };
    if (result.n >= stroke.n * 0.95) return orig;

    stroke._lodCache.set(key, result);
    return { ...result, usedLOD: true };
  } catch {
    return orig;
  }
}

function drawSelectionHandles(ctx, bb, camera, theme, dpr, hoverKey = null, showMove = false, showMoveIsPath = false) {
  const x0 = bb.minx, y0 = bb.miny, x1 = bb.maxx, y1 = bb.maxy;
  const cx = (x0 + x1) * 0.5;
  const px = 1 / Math.max(1e-8, dpr * camera.scale);
  let HANDLE_RADIUS_PX = 5;     
  let ROT_OFFSET_PX    = 28;   
  const LEADER_GAP_PX    = 10;       

  // Dynamic pixel radius: larger when zoomed out
  const grow = (camera.scale < 1) ? Math.min(2.0, 1 + (1 - camera.scale) * 0.75) : 1;
  HANDLE_RADIUS_PX *= grow;
  const r   = HANDLE_RADIUS_PX * px;
  const lw  = Math.max(px, 0.75 * px);

  // 8 resize handles (with keys)
  const points = [
    ['nw', x0, y0], ['n',  cx, y0], ['ne', x1, y0],
    ['e',  x1, (y0+y1)/2], ['se', x1, y1],
    ['s',  cx, y1], ['sw', x0, y1], ['w',  x0, (y0+y1)/2]
  ];

  ctx.save();
  ctx.lineWidth   = lw;
  ctx.strokeStyle = theme.handleStroke || '#b6c2cf';
  ctx.fillStyle   = theme.handleFill   || 'rgba(17,20,24,0.85)';

  for (const [key,x,y] of points) {
    ctx.beginPath();
    const isHover = !!hoverKey && hoverKey === key;
    const prevFill = ctx.fillStyle, prevStroke = ctx.strokeStyle, prevLW = ctx.lineWidth;
    if (isHover) {
      ctx.fillStyle = theme.handleHoverFill || '#3a7afe';
      ctx.strokeStyle = theme.handleHoverStroke || '#dce6ff';
      ctx.lineWidth = Math.max(px*1.25, 1.5*px);
    }
    ctx.arc(x, y, r, 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
    if (isHover) { ctx.fillStyle = prevFill; ctx.strokeStyle = prevStroke; ctx.lineWidth = prevLW; }
  }

  // move handle at 45� from top-right corner
  if (showMove) {
  try {
    ctx.beginPath();
    // If the move-handle is being shown for a freehand 'path' stroke, nudge
    // the rotation/move offset outwards a bit so the handle is easier to see.
    if (showMoveIsPath) ROT_OFFSET_PX = Math.round(ROT_OFFSET_PX * 1.4);
    const diag = (ROT_OFFSET_PX * px) / Math.SQRT2;
    const mvx = x1 + diag;
    const mvy = y0 - diag;
    const isHover = !!hoverKey && hoverKey === 'move';
    const prevFill = ctx.fillStyle, prevStroke = ctx.strokeStyle, prevLW = ctx.lineWidth;
    if (isHover) {
      ctx.fillStyle = theme.handleHoverFill || '#3a7afe';
      ctx.strokeStyle = theme.handleHoverStroke || '#dce6ff';
      ctx.lineWidth = Math.max(px*1.25, 1.5*px);
    }
    ctx.arc(mvx, mvy, r, 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
    if (isHover) { ctx.fillStyle = prevFill; ctx.strokeStyle = prevStroke; ctx.lineWidth = prevLW; }
  } catch {}
  }
  // rotation handle + leader (axis-aligned)
  const rotY = y0 - ROT_OFFSET_PX * px;
  const leadStartY = y0 - LEADER_GAP_PX * px;
  ctx.beginPath();
  ctx.moveTo(cx, leadStartY);
  ctx.lineTo(cx, rotY);
  ctx.stroke();
  {
    const isHover = !!hoverKey && hoverKey === 'rot';
    const prevFill = ctx.fillStyle, prevStroke = ctx.strokeStyle, prevLW = ctx.lineWidth;
    if (isHover) {
      ctx.fillStyle = theme.handleHoverFill || '#3a7afe';
      ctx.strokeStyle = theme.handleHoverStroke || '#dce6ff';
      ctx.lineWidth = Math.max(px*1.25, 1.5*px);
    }
    ctx.beginPath();
    ctx.arc(cx, rotY, r, 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
    if (isHover) { ctx.fillStyle = prevFill; ctx.strokeStyle = prevStroke; ctx.lineWidth = prevLW; }
  }

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

    try {
      const fsw = ensureFSWidget();
      fsw.bind(state, camera);
      let target = null;
      // 1) prefer an actively edited text box
      if (state?.strokes && state.strokes.length) {
        for (let i = state.strokes.length - 1; i >= 0; i--) {
          const s = state.strokes[i];
          if (s && s.shape === 'text' && s.editing) { target = s; break; }
        }
      }
      fsw.update(target, camera, canvasLike);
    } catch {}

    if (!skipSnapshotPath && state._navActive && state._navBmp && state._navCam0) {
    const s0 = state._navCam0.s, tx0 = state._navCam0.tx, ty0 = state._navCam0.ty;
    const s1 = camera.scale, tx1 = camera.tx, ty1 = camera.ty;
    const a = s1 / Math.max(1e-20, s0);
    const bx = tx1 - a * tx0;
    const by = ty1 - a * ty0;
    if (!state._navAllowLive) {
      const sbx = bx, sby = by;

      ctx.setTransform(dpr * a, 0, 0, dpr * a, dpr * sbx, dpr * sby);
      ctx.drawImage(state._navBmp, 0, 0);
      return { visible: 0, tiles: grid.map.size, complete: true };
    }
  }
  if (!skipSnapshotPath && state._navActive && state._navCam0 && (state._navBuf || state._navBmp)) {
    const s0 = state._navCam0.s, tx0 = state._navCam0.tx, ty0 = state._navCam0.ty;
    const s1 = camera.scale, tx1 = camera.tx, ty1 = camera.ty;
    const a = s1 / Math.max(1e-20, s0);
    const bx = tx1 - a * tx0;
    const by = ty1 - a * ty0;
    const src = state._navBuf || state._navBmp;

    const isZooming = Math.abs(a - 1) > 1e-3;
    const sbx = isZooming ? bx : (Math.round(dpr * bx) / dpr);
    const sby = isZooming ? by : (Math.round(dpr * by) / dpr);

    if (!state._navAllowLive) {
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
  const indexBusy = !!state._indexBusy;
  let candidateSet = (baking || transforming || indexBusy) ? null : query(grid, qView);
  if (baking || transforming || !candidateSet || candidateSet.size === 0) {
    candidateSet = new Set(state.strokes);
  }

  let didClip = false;
  let clipRestored = false;
  if (!baking) {
    ctx.save();
    const padClip = Math.max(2, (ctx.lineWidth || 1) * 2) / Math.max(1e-8, camera.scale);
    ctx.beginPath();
    ctx.rect(view.minx - padClip, view.miny - padClip, (view.maxx - view.minx) + padClip * 2, (view.maxy - view.miny) + padClip * 2);
    ctx.clip();
    didClip = true;
  }

  let visibleCount = 0;
  const tiles = grid.map.size;

  const strokes = state.strokes;
  // Use app-driven animation clock so play/pause is consistent.
  const tNow = (state?._anim?.t ?? (performance.now() / 1000));

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
    applyBrushStyle(ctx, camera, s, fast, dpr);
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
    if (s.shape !== 'text') {
      applyStyleLayers(ctx, camera, s, state, tNow, baseW, dpr);
    } else {
      // ensure no leftover layer state leaks into text render
      try { ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.shadowBlur = 0; ctx.filter = 'none'; } catch {}
    }
    if (s.kind === 'path') {
      if (s.pts && s.n != null) {
        const live = state._drawingActive || state._erasingActive || state._transformActive;
        const viewTA = live
          ? { pts: s.pts, n: s.n, usedLOD: false }
          : getLODView(s, camera, fast, state);
        const pts = viewTA.pts, n = viewTA.n;
        if (!pts || n < STRIDE * 2) { if (animApplied) ctx.restore(); if (unbaked) ctx.restore(); continue; }
        const tolLive = live ? (0.18 / Math.max(1e-8, camera.scale)) : null; // ~0.18px at 1×
        if (viewTA.usedLOD) {
          ctx.beginPath();
          ctx.moveTo(pts[0], pts[1]);
          // Disable simplification at high zoom-in to avoid snappy look
          const simplify = camera.scale < (state?._perf?.simplifyDisableAtScale ?? 1.25);
          const tolCap = Math.max(0.5, ctx.lineWidth) * 0.6;
          const tol = simplify ? Math.min(tolLive ?? tolWorld(camera, fast), tolCap) : 0;
          drawPolylineFastWorldTA(ctx, pts, n, camera, 0, (n / STRIDE) - 1, fast, tol);
        } else {
          const viewInStrokeSpace = unbaked ? invXformBBox(view, bake.s, bake.tx, bake.ty) : view;
          let vr = computeVisibleRange(s, viewInStrokeSpace, Math.max(1, ctx.lineWidth) * 2);
          // Guard against stale/mismatched chunk indices
          const nPts = Math.max(0, Math.floor(n / STRIDE));
          if (vr && (!Number.isFinite(vr.i0) || !Number.isFinite(vr.i1) || vr.i0 < 0 || vr.i1 < 0 || vr.i0 > vr.i1 || vr.i1 >= nPts)) {
            vr = null;
          }
          ctx.beginPath();
          if (!vr) {
            s._chunks = null;
            ctx.moveTo(pts[0], pts[1]);
            const simplify = camera.scale < (state?._perf?.simplifyDisableAtScale ?? 1.25);
            const tolCap = Math.max(0.5, ctx.lineWidth) * 0.6;
            const tol = simplify ? Math.min(tolWorld(camera, fast), tolCap) : 0;
            drawPolylineFastWorldTA(ctx, pts, n, camera, 0, (n / STRIDE) - 1, fast, tol);
          } else {
            const off = vr.i0 * STRIDE;
            ctx.moveTo(pts[off], pts[off + 1]);
            const simplify = camera.scale < (state?._perf?.simplifyDisableAtScale ?? 1.25);
            const tolCap = Math.max(0.5, ctx.lineWidth) * 0.6;
            const tol = simplify ? Math.min(tolWorld(camera, fast), tolCap) : 0;
            drawPolylineFastWorldTA(ctx, pts, n, camera, vr.i0, vr.i1, fast, tol);
          }
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
        // Disable simplification at high zoom-in to avoid snappy look
        const simplify = camera.scale < (state?._perf?.simplifyDisableAtScale ?? 1.25);
        const tw = simplify ? Math.min(tolWorld(camera, fast), Math.max(0.5, ctx.lineWidth) * 0.6) : 0;
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
          drawShapeWorld(ctx, s, camera, dpr);
          ctx.globalAlpha = sa; ctx.lineWidth = lw;
        }
        ctx.stroke();
      }
    } else if (s.kind === 'shape') {
      // Avoid double-drawing text shapes for glow; drawTextBoxWorld handles styling
      if (!fast && s.brush === 'glow' && s.mode !== 'erase' && s.shape !== 'text') {
        const sa = ctx.globalAlpha, lw = ctx.lineWidth;
        ctx.globalAlpha = Math.min(1, sa * 0.6);
        ctx.lineWidth = lw * 1.8;
        drawShapeWorld(ctx, s, camera, dpr);
        ctx.globalAlpha = sa; ctx.lineWidth = lw;
      }
      drawShapeWorld(ctx, s, camera, dpr);
    }

    if (animApplied) ctx.restore();
    if (unbaked) ctx.restore();
    try { ctx.lineDashOffset = 0; } catch {}
    ctx.setLineDash([]); ctx.shadowBlur = 0; ctx.filter = 'none'; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

if (state.selection && state.selection.size) {
  // --- Single selection path ---
  if (state.selection.size === 1) {
    const only = Array.from(state.selection)[0];

    // Handle baking transform if present
    const bakeActive = !!state._bake?.active;
    const b = state._bake;
    let bb = only.bbox;
    if (bakeActive && !only._baked) {
      bb = {
        minx: bb.minx * b.s + b.tx,
        miny: bb.miny * b.s + b.ty,
        maxx: bb.maxx * b.s + b.tx,
        maxy: bb.maxy * b.s + b.ty
      };
    }

    // Rotated text: draw rotated selection box + handles
    if (only && (only.shape === 'text' || only.shape === 'image') && Math.abs(only.rotation || 0) > 1e-6) {
      drawSelectionHandlesRotatedText(ctx, only, camera, theme, dpr);

      // (Optional) keep size label (AABB-based)
      const wPx = Math.max(0, Math.round((bb.maxx - bb.minx) * camera.scale));
      const hPx = Math.max(0, Math.round((bb.maxy - bb.miny) * camera.scale));
      const label = `${wPx} × ${hPx}px`;

      const sp = camera.worldToScreen({ x: bb.maxx, y: bb.maxy });
      ctx.setTransform(1,0,0,1,0,0);
      const pad = 6 * dpr;
      ctx.font = `${12 * dpr}px system-ui,-apple-system,Segoe UI,Roboto,sans-serif`;
      const metrics = ctx.measureText(label);
      const lw2 = Math.ceil(metrics.width + pad * 2);
      const lh = Math.ceil(18 * dpr);
      const cw = Math.floor(canvasLike.clientWidth * dpr);
      const ch = Math.floor(canvasLike.clientHeight * dpr);
      const lx = Math.min(cw - lw2 - 4 * dpr, Math.max(4 * dpr, sp.x * dpr - lw2));
      const ly = Math.min(ch - lh - 4 * dpr, Math.max(4 * dpr, sp.y * dpr + 8 * dpr));
      ctx.fillStyle = theme.labelBg;
      ctx.fillRect(lx, ly, lw2, lh);
      ctx.strokeStyle = theme.labelStroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(lx + 0.5, ly + 0.5, lw2 - 1, lh - 1);
      ctx.fillStyle = theme.labelText;
      ctx.fillText(label, lx + pad, ly + lh - 5 * dpr);

      // restore world transform for any later drawing
      ctx.setTransform(
        dpr * camera.scale, 0, 0,
        dpr * camera.scale,
        dpr * camera.tx, dpr * camera.ty
      );
    } else {
      // Non-rotated or non-text: default axis-aligned selection
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
  const hover = (only && only._hoverHandle) || state._hoverHandle || null;
  // Show the explicit move-handle for shapes and path strokes so stroke
  // selection UI matches the shape tools' selection appearance.
  const showMove = !!only && (only.kind === 'shape' || only.kind === 'path');
  drawSelectionHandles(ctx, bb, camera, theme, dpr, hover, showMove, !!(only && only.kind === 'path'));

      // Label (same as before)
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
      const cw = Math.floor(canvasLike.clientWidth * dpr);
      const ch = Math.floor(canvasLike.clientHeight * dpr);
      const lx = Math.min(cw - lw2 - 4 * dpr, Math.max(4 * dpr, sp.x * dpr - lw2));
      const ly = Math.min(ch - lh - 4 * dpr, Math.max(4 * dpr, sp.y * dpr + 8 * dpr));
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
  } else {
    // --- Multi selection path: accumulate AABB correctly ---
    const bakeActive = !!state._bake?.active;
    const b = state._bake;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;

    for (const s of state.selection) {
      if (!state.strokes.includes(s)) continue;
      let bb = s.bbox;
      if (bakeActive && !s._baked) {
        bb = {
          minx: bb.minx * b.s + b.tx,
          miny: bb.miny * b.s + b.ty,
          maxx: bb.maxx * b.s + b.tx,
          maxy: bb.maxy * b.s + b.ty
        };
      }
      minx = Math.min(minx, bb.minx);
      miny = Math.min(miny, bb.miny);
      maxx = Math.max(maxx, bb.maxx);
      maxy = Math.max(maxy, bb.maxy);
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
      // Always show move handle for multi-selection.
      const showMoveMulti = true;
      drawSelectionHandles(ctx, bb, camera, theme, dpr, state._hoverHandle || null, showMoveMulti, false);
      // label
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
      const cw = Math.floor(canvasLike.clientWidth * dpr);
      const ch = Math.floor(canvasLike.clientHeight * dpr);
      const lx = Math.min(cw - lw2 - 4 * dpr, Math.max(4 * dpr, sp.x * dpr - lw2));
      const ly = Math.min(ch - lh - 4 * dpr, Math.max(4 * dpr, sp.y * dpr + 8 * dpr));
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
  }

  // Fallback: if nothing rendered but we have strokes, do a conservative full render pass to avoid blank frames
  if (visibleCount === 0 && strokes.length > 0) {
    try {
      if (didClip && !clipRestored) { ctx.restore?.(); clipRestored = true; } // remove clip just in case
    } catch {}
    // No clip; draw everything quickly but safely
    for (let i = 0; i < strokes.length; i++) {
      const s0 = strokes[i];
      const brush = (s0.brush === 'taper' || s0.brush === 'square') ? 'pen' : s0.brush;
      const s = (brush === s0.brush) ? s0 : { ...s0, brush };

      applyBrushStyle(ctx, camera, s, /*fast=*/true, dpr);
      strokeCommonSetup(ctx, camera, s, /*fast=*/true);
      const baseW = Math.max(0.75 / Math.max(1, camera.scale), (s.w || 1));
      ctx.lineWidth = baseW;
      if (s.kind === 'path') {
        if (s.pts && s.n != null) {
          const viewTA = { pts: s.pts, n: s.n, usedLOD: false };
          const pts = viewTA.pts, n = viewTA.n;
          if (!pts || n < STRIDE * 2) continue;
          ctx.beginPath();
          ctx.moveTo(pts[0], pts[1]);
          const tolCap = Math.max(0.5, ctx.lineWidth) * 0.6;
          const tol = Math.min(tolWorld(camera, /*fast*/true), tolCap);
          drawPolylineFastWorldTA(ctx, pts, n, camera, 0, (n / STRIDE) - 1, /*fast*/true, tol);
          ctx.stroke();
        } else if (Array.isArray(s.pts)) {
          const pts = s.pts || [];
          if (pts.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          const tw = Math.min(tolWorld(camera, /*fast*/true), Math.max(0.5, ctx.lineWidth) * 0.6);
          let lx = pts[0].x, ly = pts[0].y;
          for (let k = 1; k < pts.length; k++) {
            const p = pts[k], dx = p.x - lx, dy = p.y - ly;
            if ((dx * dx + dy * dy) >= tw * tw) { ctx.lineTo(p.x, p.y); lx = p.x; ly = p.y; }
          }
          ctx.stroke();
        }
      } else if (s.kind === 'shape') {
        drawShapeWorld(ctx, s, camera, dpr);
      }
    }
  }

  // Only draw the marquee when the Select tool is active. Other tools shouldn't
  // render the selection marquee. Use the same solid selection styling used
  // for shape selection boxes so the marquee matches the shape tools' look.
  if (state._marquee && state.tool === 'select') {
    ctx.save();
    const px = 1 / Math.max(1e-8, dpr * camera.scale);
    ctx.lineWidth = Math.max(px, 0.75 * px);
    // Use solid stroke (no dashes) and the same theme colors as selection
    ctx.setLineDash([]);
    ctx.strokeStyle = theme.selStroke;
    ctx.fillStyle = theme.selFill;
    const m = state._marquee;
    const x = Math.min(m.minx, m.maxx), y = Math.min(m.miny, m.maxy);
    const w = Math.abs(m.maxx - m.minx), h = Math.abs(m.maxy - m.miny);
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  if (didClip && !clipRestored) ctx.restore?.();

  return { visible: visibleCount, tiles, complete: true };
}




