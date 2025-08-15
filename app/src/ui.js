// src/ui.js
import { scheduleRender, markDirty, subscribe } from './state.js';
import { clearAll } from './strokes.js';
import { insert, grid } from './spatial_index.js';
import { transformStrokeGeom } from './strokes.js';

/* ---------- color utils / recent ---------- */
const DEFAULT_PALETTE = [
  '#ffffff', '#e7ebf3', '#cfd7e3', '#9aa5b1', '#5b6b79', '#2a313c', '#121619', '#000000',
  '#ff6b6b', '#ffa94d', '#ffe66d', '#8ce99a', '#66d9e8', '#6cc3ff', '#5c7cfa', '#d0bfff',
  '#f783ac', '#12b886', '#2f9e44', '#f59f00'
];
const LS_RECENT_KEY = 'endless_recent_colors_v2';
const LEGACY_KEYS = ['endless_recent_colors_v1','endless_recent_colors','endless_recent_colors_v0'];
const MAX_RECENT = 12;

function toHex6(v) {
  if (!v && v !== 0) return null;
  let s = String(v).trim().toLowerCase();
  if (s.startsWith('rgb')) {
    try {
      const nums = s.replace(/[^\d.,]/g, '').split(',').map(n => parseFloat(n));
      if (nums.length >= 3 && nums.every(n => Number.isFinite(n))) {
        const [r, g, b] = nums;
        s = '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
      }
    } catch {}
  }
  const short = /^#?([0-9a-f]{3})$/i;
  const long  = /^#?([0-9a-f]{6})$/i;
  let m = s.match(short);
  if (m) return ('#' + m[1].split('').map(ch => ch + ch).join('')).toLowerCase();
  m = s.match(long);
  if (m) return ('#' + m[1]).toLowerCase();
  return null;
}
function dedupeKeepOrder(arr) {
  const seen = new Set(); const out = [];
  for (const h of arr) { if (!h || seen.has(h)) continue; seen.add(h); out.push(h); }
  return out;
}
function loadRecent() {
  try {
    const raw = localStorage.getItem(LS_RECENT_KEY);
    const arr = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
    const norm = arr.map(toHex6).filter(Boolean);
    if (norm.length) return norm.slice(0, MAX_RECENT);
  } catch {}
  for (const k of LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(k);
      const arr = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
      const norm = dedupeKeepOrder(arr.map(toHex6).filter(Boolean));
      if (norm.length) { saveRecent(norm); return norm.slice(0, MAX_RECENT); }
    } catch {}
  }
  return [];
}
function saveRecent(arr) { try { localStorage.setItem(LS_RECENT_KEY, JSON.stringify(arr.slice(0, MAX_RECENT))); } catch {} }
function pushRecent(hex) {
  const h = toHex6(hex); if (!h) return;
  const arr = loadRecent();
  const i = arr.indexOf(h);
  if (i !== -1) arr.splice(i, 1);
  arr.unshift(h);
  saveRecent(arr);
}

/* ---------- swatches ---------- */
function buildSwatches(host, currentGetter, onPick){
  if (!host) return { highlight:()=>{}, refreshRecent:()=>{}, replaceRecentAt:()=>{} };
  host.innerHTML = '';

  let recentNode = null;

  function makeRow(title, colors, { allowReplace = false } = {}){
    const row  = document.createElement('div'); row.className = 'sw-row';
    const t    = document.createElement('span'); t.className = 'sw-title'; t.textContent = title;
    const grid = document.createElement('div'); grid.className = 'sw-grid';
    row.appendChild(t); row.appendChild(grid);

    colors.forEach((hex, idx) => {
      const h = toHex6(hex); if (!h) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sw';
      b.style.setProperty('background-color', h, 'important');
      b.dataset.hex = h;
      if (allowReplace) b.dataset.idx = String(idx);
      b.setAttribute('aria-label', `Use color ${h}`);

      b.addEventListener('click', (ev) => {
        if (allowReplace && ev.altKey) { replaceRecentAt(idx, currentGetter()); return; }
        onPick(h);
      });
      if (allowReplace) {
        b.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          replaceRecentAt(idx, currentGetter());
        });
      }
      grid.appendChild(b);
    });
    return row;
  }

  function renderRecentRow(prependHex){
    const arr = loadRecent();
    if (prependHex) {
      const hh = toHex6(prependHex);
      if (hh) {
        const i = arr.indexOf(hh);
        if (i !== -1) arr.splice(i, 1);
        arr.unshift(hh);
      }
    }
    const node = makeRow('Recent', arr.slice(0, MAX_RECENT), { allowReplace:true });
    if (recentNode) host.replaceChild(node, recentNode); else host.appendChild(node);
    recentNode = node;
  }

  function replaceRecentAt(index, hex){
    const h = toHex6(hex); if (!h) return;
    const arr = loadRecent();
    if (index < 0 || index >= Math.min(arr.length, MAX_RECENT)) return;
    arr[index] = h;
    saveRecent(arr);

    const btn = recentNode?.querySelector(`.sw[data-idx="${index}"]`);
    if (btn) {
      btn.dataset.hex = h;
      btn.style.setProperty('background-color', h, 'important');
    }
    highlight();
  }

  function highlight(){
    const now = currentGetter();
    host.querySelectorAll('.sw').forEach(el => el.classList.toggle('current', el.dataset.hex === now));
  }

  renderRecentRow();
  const paletteRow = makeRow('Palette', DEFAULT_PALETTE);
  host.appendChild(paletteRow);
  highlight();

  return {
    highlight,
    refreshRecent(newHex){ renderRecentRow(newHex); highlight(); },
    replaceRecentAt,
  };
}

/* ---------- copy/paste (preserve react2 anim/style) ---------- */
function newId() { return (crypto?.randomUUID?.() || ('s-' + Math.random().toString(36).slice(2, 10))); }
function clampNum(n, fallback=0) { const v = Number(n); return Number.isFinite(v) ? v : fallback; }
function keepEnum(v, allowed, fallback) { return allowed.includes(v) ? v : fallback; }
function cloneAnimLayer(L){
  if (!L) return null;
  return {
    type: keepEnum(L.type, ['spin','sway','pulse','bounce','orbit','shake','pendulum','float','drift'], 'spin'),
    enabled: !!L.enabled,
    speed: clampNum(L.speed, 1),
    phase: clampNum(L.phase, 0),
    amount: clampNum(L.amount, 0.15),
    axis: keepEnum(L.axis, ['x','y','xy'], 'xy'),
    radiusX: clampNum(L.radiusX, 12),
    radiusY: clampNum(L.radiusY, 12),
    amountRot: clampNum(L.amountRot, 0.02),
    amountPos: clampNum(L.amountPos, 2),
    // audio fields removed
  };
}
function cloneStyleLayer(L){
  if (!L) return null;
  return {
    type: keepEnum(L.type, ['width','opacity','glow','hue','dash','blur','saturation','lightness'], 'width'),
    enabled: !!L.enabled,
    speed: clampNum(L.speed, 1),
    amount: clampNum(L.amount, 0.15),
    deg: clampNum(L.deg, 30),

    // Back-compat + new params
    rate: Number.isFinite(L.rate) ? +L.rate : undefined,          // old px/s
    dashLen: Number.isFinite(L.dashLen) ? +L.dashLen : undefined,  // new dash length (px)
    gapFactor: Number.isFinite(L.gapFactor) ? +L.gapFactor : undefined,
  };
}
function cloneReact2(r){
  if (!r) return null;
  const out = {};
  if (r.anim && Array.isArray(r.anim.layers)) out.anim = { layers: r.anim.layers.map(cloneAnimLayer).filter(Boolean) };
  if (r.style && Array.isArray(r.style.layers)) out.style = { layers: r.style.layers.map(cloneStyleLayer).filter(Boolean) };
  return out;
}
function deepCloneForClipboard(s){
  if (!s) return null;
  if (s.kind === 'path'){
    let pts, n = null;
    if (s.n != null && s.pts && typeof s.pts.BYTES_PER_ELEMENT === 'number'){ pts = s.pts.slice(0, s.n); n = pts.length; }
    else if (Array.isArray(s.pts)){ pts = s.pts.map(p => ({ x:+p.x||0, y:+p.y||0, p:(p.p!=null?+p.p:0.5) })); n = null; }
    else { pts = new Float32Array(0); n = 0; }
    return { kind:'path', mode:s.mode||'draw', brush:s.brush, color:s.color, alpha:s.alpha, w:s.w, fill:!!s.fill,
      pts, n, bbox:{...s.bbox}, react2: cloneReact2(s.react2) };
  }
  return { kind:'shape', mode:s.mode||'draw', brush:s.brush, color:s.color, alpha:s.alpha, w:s.w,
    shape:s.shape, fill:!!s.fill, start:{...s.start}, end:{...s.end}, bbox:{...s.bbox}, react2: cloneReact2(s.react2) };
}
function materializeFromClipboard(data, appState){
  const base = { id: newId(), mode: data.mode || 'draw', brush: data.brush, color: data.color, alpha: data.alpha, w: data.w,
    timestamp: performance.now(), _baked: !appState._bake?.active };
  if (data.kind === 'path'){
    let pts = data.pts, n = data.n;
    if (n != null && pts && typeof pts.BYTES_PER_ELEMENT === 'number'){ pts = pts.slice(0, n); n = pts.length; }
    else if (Array.isArray(pts)) { n = null; } else { pts = new Float32Array(0); n = 0; }
    return { ...base, kind:'path', pts, n, bbox:{...data.bbox}, _chunks:null, fill:!!data.fill, react2: cloneReact2(data.react2) };
  }
  return { ...base, kind:'shape', shape:data.shape, fill:!!data.fill, start:{...data.start}, end:{...data.end}, bbox:{...data.bbox},
    react2: cloneReact2(data.react2) };
}

/* ---------- color panel ---------- */
function initColorUI(state){
  const input  = document.getElementById('color');
  const eyeBtn = document.getElementById('eyedropBtn');
  const swHost = document.getElementById('swatchHost');

  const paintBall = document.querySelector('[data-tool="paint"] .paint-ball');
  const setPaintBall = (hex) => {
    if (!paintBall) return;
    document.documentElement.style.setProperty('--ui-color', hex);
    paintBall.style.backgroundColor = hex; // fallback
  };

  let current = toHex6(state.settings?.color || input?.value || '#88ccff') || '#88ccff';
  if (input) input.value = current;
  setPaintBall(current); // init sphere color

  const swAPI = buildSwatches(swHost, () => current, (hex) => setColor(hex));

  function setColor(hex, { push = true } = {}){
    const h = toHex6(hex); if (!h) return;
    current = h;

    if (input && input.value.toLowerCase() !== h) input.value = h;
    state.settings.color = h;
    if (push) pushRecent(h);

    setPaintBall(h); 

    markDirty(); scheduleRender();
    swAPI.highlight();
    swAPI.refreshRecent(h);
  }

  input?.addEventListener('input',  () => setColor(input.value));
  input?.addEventListener('change', () => setColor(input.value));

  if (eyeBtn) {
    if (!('EyeDropper' in window)) {
      eyeBtn.disabled = true;
      eyeBtn.title = 'Eyedropper not supported in this browser';
    } else {
      eyeBtn.addEventListener('click', async () => {
        try {
          const ed = new window.EyeDropper();
          const res = await ed.open();
          if (res?.sRGBHex) setColor(res.sRGBHex);
        } catch {}
      });
    }
  }

  setInterval(() => {
    const fromState = toHex6(state.settings?.color);
    if (fromState && fromState !== current) {
      setColor(fromState, { push:false });
      setPaintBall(fromState);
    }
  }, 800);
}

function strokeBBoxWorld(state, s){
  const bake = state?._bake;
  let bb = s?.bbox; if (!bb) return null;
  if (bake?.active && s._baked === false){
    const ss=bake.s, tx=bake.tx, ty=bake.ty;
    bb = { minx: bb.minx*ss+tx, miny: bb.miny*ss+ty, maxx: bb.maxx*ss+tx, maxy: bb.maxy*ss+ty };
  }
  return bb;
}
function bboxCenter(bb){
  return {
    cx: (bb.minx + bb.maxx) * 0.5,
    cy: (bb.miny + bb.maxy) * 0.5
  };
}

/* ---------- main UI ---------- */
export function initUI({ state, canvas, camera, setTool }){
  // Tool buttons
  const toolBtns = document.querySelectorAll('[data-tool]');
  toolBtns.forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

  // Controls
  const brushSel = document.getElementById('brush');
  const colorInp = document.getElementById('color');
  const sizeInp  = document.getElementById('size');
  const sizeV    = document.getElementById('sizev');
  const opacity  = document.getElementById('opacity');
  const opacityV = document.getElementById('opacityv');
  const fillChk  = document.getElementById('fill');

  sizeInp?.addEventListener('input', () => {
    state.settings.size = parseInt(sizeInp.value,10) || 1;
    if (sizeV) sizeV.textContent = sizeInp.value + ' px';
    scheduleRender(); markDirty();
  });
  colorInp?.addEventListener('input', () => {
    state.settings.color = colorInp.value || '#88ccff';
    scheduleRender(); markDirty();
  });
  brushSel?.addEventListener('change', () => {
    state.brush = brushSel.value;
    scheduleRender(); markDirty();
  });
  opacity?.addEventListener('input', () => {
    const v = parseInt(opacity.value,10);
    state.settings.opacity = Math.max(0.05, Math.min(1, (isNaN(v) ? 100 : v)/100));
    if (opacityV) opacityV.textContent = (Math.round(state.settings.opacity*100)) + '%';
    scheduleRender(); markDirty();
  });
  fillChk?.addEventListener('change', () => {
    state.settings.fill = !!fillChk.checked;
    scheduleRender(); markDirty();
  });

  if (sizeV && sizeInp) sizeV.textContent = sizeInp.value + ' px';
  if (opacityV && opacity) opacityV.textContent = opacity.value + '%';

  // Undo/Redo/Clear
  document.getElementById('undo')?.addEventListener('click', () => state.history?.undo());
  document.getElementById('redo')?.addEventListener('click', () => state.history?.redo());
  document.getElementById('clear')?.addEventListener('click', () => {
    if (!state.strokes.length) return;
    const prev = state.strokes.slice();
    clearAll(state);
    state.history?.pushClear?.(prev);
  });

  // Copy/Paste (preserves anim/style)
  window.addEventListener('keydown', (e) => {
    const isMod = e.metaKey || e.ctrlKey; if (!isMod) return;
    const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = (e.key || '').toLowerCase();

    if (k === 'c') {
      if (state.selection && state.selection.size){
        const clip = [];
        for (const s of state.selection) {
          const d = deepCloneForClipboard(s);
          if (d) clip.push(d);
        }
        state.clipboard = clip.length ? clip : null;
      }
      if (state.clipboard) e.preventDefault();
    }

    if (k === 'v') {
      if (!state.clipboard || !state.clipboard.length) return;
      e.preventDefault();
      const dx = 16 / Math.max(1e-8, camera.scale);
      const dy = 16 / Math.max(1e-8, camera.scale);
      const pasted = [];
      for (const d of state.clipboard){
        const s = materializeFromClipboard(d, state);
        transformStrokeGeom(s, { sx:1, sy:1, ox:0, oy:0, tx:dx, ty:dy });
        state.strokes.push(s);
        insert(grid, s);
        pasted.push(s);
      }
      try { state.selection?.clear?.(); } catch {}
      for (const s of pasted) state.selection?.add?.(s);
      state.history?.pushAddGroup?.(pasted);
      markDirty(); scheduleRender();
    }
  });

  // Tool properties popover (hover-to-open, optional pin)
  const dock   = document.getElementById('dock');
  const pop    = document.getElementById('toolProps');
  const pinBtn = document.getElementById('propPin');

  const propRows = {
    brush:   pop?.querySelector('[data-prop="brush"]'),
    color:   pop?.querySelector('[data-prop="color"]'),
    colorSw: pop?.querySelector('[data-prop="color-swatches"]'),
    size:    pop?.querySelector('[data-prop="size"]'),
    opacity: pop?.querySelector('[data-prop="opacity"]'),
    fill:    pop?.querySelector('[data-prop="fill"]'),
  };

  const TOOL_PROPS = {
    draw:     ['brush','color','colorSw','size','opacity'],
    paint:    ['color','colorSw','opacity'],
    line:     ['color','colorSw','size','opacity'],
    rect:     ['color','colorSw','size','opacity','fill'],
    ellipse:  ['color','colorSw','size','opacity','fill'],
    erase:    ['size'],
    delete:   [],
    pan:      [],
  };

  let pinned = false;
  let hideTimer = 0;

  function setOpen(open) {
    if (!pop) return;
    clearTimeout(hideTimer);
    if (open) { pop.style.display = 'block'; requestAnimationFrame(()=> pop.classList.add('open')); }
    else { pop.classList.remove('open'); if (!pinned) setTimeout(()=> { if (!pinned) pop.style.display='none'; }, 120); }
  }
  function showPropsFor(tool, anchorBtn) {
    if (!pop) return;
    const want = new Set(TOOL_PROPS[tool] || []);
    for (const [k,row] of Object.entries(propRows)) if (row) row.style.display = want.has(k) ? 'flex' : 'none';
    if (!want.size) { setOpen(false); return; }
    const r = anchorBtn.getBoundingClientRect();
    const x = (r.left + r.right) / 2;
    const y = r.top;
    pop.style.left = x + 'px'; pop.style.top  = (y - 10) + 'px';
    setOpen(true);
  }
  function currentTool() {
    const st = state.tool;
    if (st) return st;
    const btn = dock?.querySelector('.tool.active[data-tool]') || dock?.querySelector('[data-tool="draw"]');
    return btn?.dataset?.tool || 'draw';
  }
  function activeToolBtn() {
    return dock?.querySelector(`.tool.active[data-tool="${currentTool()}"]`) || dock?.querySelector(`[data-tool="${currentTool()}"]`);
  }
  function scheduleHide(delay=180) {
    clearTimeout(hideTimer);
    if (pinned) return;
    hideTimer = setTimeout(() => setOpen(false), delay);
  }
  dock?.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-tool]'); if (!btn) return;
    const tool = btn.dataset.tool;
    const hasProps = (TOOL_PROPS[tool] || []).length > 0;
    const alreadyActive = btn.classList.contains('active');
    requestAnimationFrame(() => {
      if (!hasProps) { setOpen(false); pinned=false; pop?.classList.remove('pinned'); return; }
      if (alreadyActive && btn.classList.contains('active')) {
        const openNow = pop?.classList.contains('open');
        if (openNow) setOpen(false); else showPropsFor(tool, btn);
      } else {
        setOpen(false); pinned=false; pop?.classList.remove('pinned');
      }
    });
  });
  dock?.addEventListener('mousemove', (e) => {
    if (pinned) return;
    const btn = activeToolBtn(); if (!btn) return;
    const tool = btn.dataset.tool;
    if (!(TOOL_PROPS[tool]||[]).length) return;
    const r = btn.getBoundingClientRect();
    const withinX = e.clientX >= r.left-6 && e.clientX <= r.right+6;
    const withinY = e.clientY >= r.top-6  && e.clientY <= r.bottom+6;
    if (withinX && withinY) showPropsFor(tool, btn); else scheduleHide(200);
  });
  pop?.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  pop?.addEventListener('mouseleave', () => { if (!pinned) scheduleHide(120); });
  document.getElementById('c')?.addEventListener('pointerdown', () => { if (!pinned) setOpen(false); });
  pinBtn?.addEventListener('click', () => {
    pinned = !pinned;
    pop?.classList.toggle('pinned', pinned);
    if (pinned) {
      const btn = activeToolBtn(); if (btn) showPropsFor(btn.dataset.tool, btn);
    } else {
      scheduleHide(200);
    }
  });
  window.addEventListener('resize', () => {
    if (!pop?.classList.contains('open')) return;
    const btn = activeToolBtn(); if (btn) showPropsFor(btn.dataset.tool, btn);
  });
  setOpen(false);

  // Color UI
  initColorUI(state);

  /* ------------ Selection HUD: Anim + Style (no audio fields) ----------- */
  const poseHud       = document.getElementById('poseHud');
  const animRow       = document.getElementById('animRow');
  const animType      = document.getElementById('animType');
  const animSpeed     = document.getElementById('animSpeed');
  const animAmount    = document.getElementById('animAmount');
  const animAxis      = document.getElementById('animAxis');
  const animRadiusX   = document.getElementById('animRadiusX');
  const animRadiusY   = document.getElementById('animRadiusY');
  const animRotAmt    = document.getElementById('animRotAmt');
  const animPosAmt    = document.getElementById('animPosAmt');
  const animSpeedWrap = document.getElementById('animSpeedWrap');
  const animAmountWrap= document.getElementById('animAmountWrap');
  const animAxisWrap  = document.getElementById('animAxisWrap');
  const animRadiusWrap= document.getElementById('animRadiusWrap');
  const animRotWrap   = document.getElementById('animRotWrap');
  const animPosWrap   = document.getElementById('animPosWrap');

  const styleRow        = document.getElementById('styleRow');
  const styleType       = document.getElementById('styleType');
  const styleSpeed      = document.getElementById('styleSpeed');
  const styleAmount     = document.getElementById('styleAmount');
  const styleHue        = document.getElementById('styleHue');
  const styleRate       = document.getElementById('styleRate');
  const styleSpeedWrap  = document.getElementById('styleSpeedWrap');
  const styleAmountWrap = document.getElementById('styleAmountWrap');
  const styleHueWrap    = document.getElementById('styleHueWrap');
  const styleRateWrap   = document.getElementById('styleRateWrap');

  function selectionBBoxWorld() {
    const bake = state._bake;
    let minx=Infinity, miny=Infinity, maxx=-Infinity, maxy=-Infinity;
    for (const s of (state.selection || [])) {
      if (!s?.bbox) continue;
      let bb = s.bbox;
      if (bake?.active && s._baked === false){
        const s0=bake.s, tx=bake.tx, ty=bake.ty;
        bb = { minx: bb.minx*s0+tx, miny: bb.miny*s0+ty, maxx: bb.maxx*s0+tx, maxy: bb.maxy*s0+ty };
      }
      if (bb.minx < minx) minx = bb.minx;
      if (bb.miny < miny) miny = bb.miny;
      if (bb.maxx > maxx) maxx = bb.maxx;
      if (bb.maxy > maxy) maxy = bb.maxy;
    }
    if (!Number.isFinite(minx)) return null;
    return { minx, miny, maxx, maxy };
  }
  function firstSelected() {
    const sel = Array.from(state.selection || []);
    return sel.length ? sel[0] : null;
  }
  function getAnimLayerFromStroke(s){
    const layers = s?.react2?.anim?.layers;
    return (layers && layers.length) ? layers[0] : null;
  }
  function getStyleLayerFromStroke(s){
    const layers = s?.react2?.style?.layers;
    return (layers && layers.length) ? layers[0] : null;
  }

  function setAnimForSelection(type, params = {}) {
    const sel = Array.from(state.selection || []); if (!sel.length) return;
    const bb = selectionBBoxWorld();
    const pivot = bb ? { x: (bb.minx + bb.maxx) * 0.5, y: (bb.miny + bb.maxy) * 0.5 } : null;
    const groupId = 'g-' + (crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 10));

    for (const s of sel) {
      s.react2 = s.react2 || {};
      if (type === 'none') { s.react2.anim = { layers: [] }; continue; }
      const L = { type, enabled: true, ...params };
      if (pivot) L.pivot = { ...pivot };   
      L.groupId = groupId;              
      s.react2.anim = s.react2.anim || { layers: [] };
      s.react2.anim.layers = [L];
    }
    scheduleRender();
  }
  function setStyleForSelection(type, params={}){
    const sel = Array.from(state.selection || []); if (!sel.length) return;
    for (const s of sel){
      s.react2 = s.react2 || {};
      if (type === 'none'){ s.react2.style = { layers: [] }; continue; }
      const L = { type, enabled:true, ...params };
      s.react2.style = s.react2.style || { layers: [] };
      s.react2.style.layers = [L];
    }
    scheduleRender();
  }

  function syncAnimControlsVisibility(type){
    animAmountWrap && (animAmountWrap.style.display = 'none');
    animAxisWrap   && (animAxisWrap.style.display   = 'none');
    animRadiusWrap && (animRadiusWrap.style.display = 'none');
    animRotWrap    && (animRotWrap.style.display    = 'none');
    animPosWrap    && (animPosWrap.style.display    = 'none');
    animSpeedWrap  && (animSpeedWrap.style.display  = (type==='none') ? 'none' : '');

    if (type==='sway')        animAmountWrap && (animAmountWrap.style.display = '');
    if (type==='pulse')      { if (animAmountWrap) animAmountWrap.style.display = ''; if (animAxisWrap) animAxisWrap.style.display=''; }
    if (type==='bounce')     { if (animAmountWrap) animAmountWrap.style.display = ''; if (animAxisWrap) animAxisWrap.style.display=''; }
    if (type==='orbit')       animRadiusWrap && (animRadiusWrap.style.display = '');
    if (type==='shake')      { if (animPosWrap) animPosWrap.style.display = ''; if (animRotWrap) animRotWrap.style.display=''; }
    if (type==='pendulum')    animRotWrap    && (animRotWrap.style.display = '');
    if (type==='float')      { if (animPosWrap) animPosWrap.style.display = ''; if (animRotWrap) animRotWrap.style.display=''; }
    if (type==='drift')       animPosWrap    && (animPosWrap.style.display = '');
  }
  function syncStyleControlsVisibility(type){
    if (!styleSpeedWrap || !styleAmountWrap || !styleHueWrap || !styleRateWrap) return;
    styleSpeedWrap.style.display  = (type==='none') ? 'none' : '';
    styleAmountWrap.style.display = 'none';
    styleHueWrap.style.display    = 'none';
    styleRateWrap.style.display   = 'none';
    if (type==='width' || type==='opacity' || type==='glow' || type==='blur' || type==='saturation' || type==='lightness') styleAmountWrap.style.display = '';
    if (type==='hue')  styleHueWrap.style.display = '';
    if (type==='dash') styleRateWrap.style.display = '';
  }
  function updateAnimControlsFromSelection(){
    const s = firstSelected(); if (!s) return;
    const L = getAnimLayerFromStroke(s);
    const t = L?.type || 'none';
    if (animType) animType.value = t;
    syncAnimControlsVisibility(t);
    animSpeed  && (animSpeed.value  = (L?.speed  ?? 1));
    animAmount && (animAmount.value = (L?.amount ?? 0.15));
    animAxis   && (animAxis.value   = (L?.axis   ?? 'xy'));
    animRadiusX&& (animRadiusX.value= (L?.radiusX?? 12));
    animRadiusY&& (animRadiusY.value= (L?.radiusY?? 12));
    animRotAmt && (animRotAmt.value = (L?.amountRot ?? 0.02));
    animPosAmt && (animPosAmt.value = (L?.amountPos ?? 2));
  }
function updateStyleControlsFromSelection(){
  if (!styleType) return;
  const s = firstSelected(); if (!s) return;
  const L = getStyleLayerFromStroke(s);
  const t = L?.type || 'none';

  styleType.value = t;
  const rateLabel = styleRateWrap?.querySelector('.mini');
  if (rateLabel) rateLabel.textContent = (t === 'dash' ? 'Dash px' : 'px/s');

  syncStyleControlsVisibility(t);

  styleSpeed  && (styleSpeed.value  = (L?.speed  ?? 1));
  styleAmount && (styleAmount.value = (L?.amount ?? 0.15));
  styleHue    && (styleHue.value    = (L?.deg    ?? 30));

  if (t === 'dash') {
    // prefer saved dashLen; sensible fallback based on stroke width
    const w = s?.w ?? 6;
    const fallback = Math.max(2, w * 2.2);
    styleRate && (styleRate.value = (Number.isFinite(L?.dashLen) ? L.dashLen : fallback));
  } else {
    styleRate && (styleRate.value = (L?.rate ?? 120));
  }
}

  function updateHud(){
    if (!poseHud) return;

    const show = state.tool === 'select' && (state.selection?.size || 0) > 0;
    if (!show) {
      poseHud.style.display = 'none';
      poseHud.setAttribute('aria-hidden','true');
      return;
    }

    const bb = selectionBBoxWorld();
    if (!bb) { poseHud.style.display='none'; poseHud.setAttribute('aria-hidden','true'); return; }
    const cx = (bb.minx + bb.maxx) * 0.5;
    const bottom = { x: cx, y: bb.maxy };
    const sp = camera.worldToScreen(bottom);
    poseHud.style.left = Math.round(sp.x) + 'px';
    poseHud.style.top  = (Math.round(sp.y) + 10) + 'px';
    poseHud.style.transform = 'translate(-50%, 0)';
    poseHud.style.display = 'block';
    poseHud.setAttribute('aria-hidden','false');

    if (animRow) {
      animRow.style.display = 'flex';
      updateAnimControlsFromSelection();
    }
    if (styleRow) {
      styleRow.style.display = 'flex';
      updateStyleControlsFromSelection();
    }
  }

  // Anim control wiring
  animType?.addEventListener('change', () => {
    const type = animType.value || 'none';
    syncAnimControlsVisibility(type);
    const params = {
      speed: parseFloat(animSpeed?.value)||1,
      amount: parseFloat(animAmount?.value)||0,
      axis: animAxis?.value||'xy',
      radiusX: parseFloat(animRadiusX?.value)||12,
      radiusY: parseFloat(animRadiusY?.value)||12,
      amountRot: parseFloat(animRotAmt?.value)||0.02,
      amountPos: parseFloat(animPosAmt?.value)||2,
    };
    setAnimForSelection(type, params);
    updateAnimControlsFromSelection();
  });
  [animSpeed, animAmount, animAxis, animRadiusX, animRadiusY, animRotAmt, animPosAmt].forEach(inp=>{
    inp?.addEventListener('input', () => {
      const type = animType?.value || 'none';
      if (!type || type==='none') return;
      const params = {
        speed: parseFloat(animSpeed?.value)||1,
        amount: parseFloat(animAmount?.value)||0,
        axis: animAxis?.value||'xy',
        radiusX: parseFloat(animRadiusX?.value)||12,
        radiusY: parseFloat(animRadiusY?.value)||12,
        amountRot: parseFloat(animRotAmt?.value)||0.02,
        amountPos: parseFloat(animPosAmt?.value)||2,
      };
      setAnimForSelection(type, params);
    });
  });

  // Style control wiring
styleType?.addEventListener('change', () => {
  const type = styleType.value || 'none';
  syncStyleControlsVisibility(type);

  const params = (type === 'dash')
    ? {
        speed: parseFloat(styleSpeed?.value) || 1,
        dashLen: parseFloat(styleRate?.value) || 12  // <- now dash length in px
      }
    : {
        speed: parseFloat(styleSpeed?.value) || 1,
        amount: parseFloat(styleAmount?.value) || 0.15,
        deg: parseFloat(styleHue?.value) || 30,
        rate: parseFloat(styleRate?.value) || 120
      };

  setStyleForSelection(type, params);
  updateStyleControlsFromSelection();
});

// style inputs live update
[styleSpeed, styleAmount, styleHue, styleRate].forEach(inp=>{
  inp?.addEventListener('input', () => {
    const type = styleType?.value || 'none';
    if (type==='none') return;

    const params = (type === 'dash')
      ? {
          speed: parseFloat(styleSpeed?.value) || 1,
          dashLen: parseFloat(styleRate?.value) || 12
        }
      : {
          speed: parseFloat(styleSpeed?.value) || 1,
          amount: parseFloat(styleAmount?.value) || 0.15,
          deg: parseFloat(styleHue?.value) || 30,
          rate: parseFloat(styleRate?.value) || 120
        };

    setStyleForSelection(type, params);
  });
});

  // keep HUD synced
  subscribe(updateHud);
  window.addEventListener('resize', updateHud);
  setTimeout(updateHud, 0);

  let wasTransforming = false;
  const animReset = { active:false, saved:new Map() }; 

  function _onTransformStart(){
    if (animReset.active) return;
    animReset.active = true;
    animReset.saved.clear();

    for (const s of (state.selection || [])) {
      const layers = s?.react2?.anim?.layers;
      if (layers && layers.length) {
        const copy = layers.map(cloneAnimLayer).filter(Boolean);
        if (copy.length) {
          animReset.saved.set(s.id, copy);
          s.react2 = s.react2 || {};
          s.react2.anim = { layers: [] };
        }
      }
    }
    markDirty(); scheduleRender();
  }

  function _onTransformEnd(){
    if (!animReset.active) return;
    const newGroupId = 'g-' + (crypto?.randomUUID?.() || Math.random().toString(36).slice(2,10));

    for (const [id, savedLayers] of animReset.saved) {
      const s = state.strokes.find(st => st.id === id);
      if (!s) continue;

      const bb = strokeBBoxWorld(state, s);
      const c  = bb ? bboxCenter(bb) : null;

      const restored = savedLayers.map(L => {
        const r = cloneAnimLayer(L); // keep user params
        r.phase   = 0;               // reset phase like re-picking the type
        r.enabled = true;
        r.groupId = newGroupId;
        if (c) r.pivot = { x: c.cx, y: c.cy };
        return r;
      });

      s.react2 = s.react2 || {};
      s.react2.anim = { layers: restored };
    }

    animReset.saved.clear();
    animReset.active = false;
    markDirty(); scheduleRender();
  }

  subscribe(() => {
    const now = !!state._transformActive;
    if (now && !wasTransforming) _onTransformStart();
    if (!now && wasTransforming) _onTransformEnd();
    wasTransforming = now;
  });


  return { updatePosePanel: updateHud, updatePoseHud: updateHud };
}
