// src/ui.js
import { scheduleRender, markDirty, subscribe } from './state.js';
import { clearAll } from './strokes.js';
import { insert, grid } from './spatial_index.js';
import { transformStrokeGeom } from './strokes.js';

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
function dedupeKeepOrder(arr){ const s=new Set(); const out=[]; for (const h of arr){ if (!h||s.has(h)) continue; s.add(h); out.push(h);} return out; }
function loadRecent(){
  try{
    const raw = localStorage.getItem(LS_RECENT_KEY);
    const arr = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
    const norm = arr.map(toHex6).filter(Boolean);
    if (norm.length) return norm.slice(0, MAX_RECENT);
  }catch{}
  for (const k of LEGACY_KEYS){
    try{
      const raw = localStorage.getItem(k);
      const arr = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
      const norm = dedupeKeepOrder(arr.map(toHex6).filter(Boolean));
      if (norm.length){ saveRecent(norm); return norm.slice(0, MAX_RECENT); }
    }catch{}
  }
  return [];
}
function saveRecent(arr){ try{ localStorage.setItem(LS_RECENT_KEY, JSON.stringify(arr.slice(0, MAX_RECENT))); }catch{} }
function pushRecent(hex){
  const h = toHex6(hex); if (!h) return;
  const arr = loadRecent(); const i = arr.indexOf(h);
  if (i !== -1) arr.splice(i,1); arr.unshift(h); saveRecent(arr);
}

function buildSwatches(host, currentGetter, onPick){
  if (!host) return { highlight:()=>{}, refreshRecent:()=>{}, replaceRecentAt:()=>{} };
  host.innerHTML = '';
  let recentNode = null;

  function makeRow(title, colors, { allowReplace=false }={}){
    const row = document.createElement('div'); row.className='sw-row';
    const t   = document.createElement('span'); t.className='sw-title'; t.textContent=title;
    const grid= document.createElement('div'); grid.className='sw-grid';
    row.appendChild(t); row.appendChild(grid);

    colors.forEach((hex,idx)=>{
      const h = toHex6(hex); if (!h) return;
      const b = document.createElement('button');
      b.type='button'; b.className='sw'; b.style.setProperty('background-color', h, 'important');
      b.dataset.hex=h; if (allowReplace) b.dataset.idx=String(idx);
      b.setAttribute('aria-label',`Use color ${h}`);
      b.addEventListener('click',(ev)=>{ if (allowReplace && ev.altKey){ replaceRecentAt(idx, currentGetter()); return; } onPick(h); });
      if (allowReplace){
        b.addEventListener('contextmenu',(ev)=>{ ev.preventDefault(); replaceRecentAt(idx, currentGetter()); });
      }
      grid.appendChild(b);
    });
    return row;
  }

  function renderRecentRow(prependHex){
    const arr = loadRecent();
    if (prependHex){
      const hh = toHex6(prependHex); if (hh){
        const i=arr.indexOf(hh); if (i!==-1) arr.splice(i,1); arr.unshift(hh);
      }
    }
    const node = makeRow('Recent', arr.slice(0, MAX_RECENT), { allowReplace:true });
    if (recentNode) host.replaceChild(node, recentNode); else host.appendChild(node);
    recentNode = node;
  }
  function replaceRecentAt(index, hex){
    const h=toHex6(hex); if (!h) return;
    const arr = loadRecent(); if (index<0 || index>=Math.min(arr.length,MAX_RECENT)) return;
    arr[index]=h; saveRecent(arr);
    const btn = recentNode?.querySelector(`.sw[data-idx="${index}"]`);
    if (btn){ btn.dataset.hex=h; btn.style.setProperty('background-color', h, 'important'); }
    highlight();
  }
  function highlight(){
    const now = currentGetter();
    host.querySelectorAll('.sw').forEach(el => el.classList.toggle('current', el.dataset.hex===now));
  }

  renderRecentRow();
  host.appendChild(makeRow('Palette', DEFAULT_PALETTE));
  highlight();

  return { highlight, refreshRecent(newHex){ renderRecentRow(newHex); highlight(); }, replaceRecentAt };
}

function initColorUI(state){
  const input  = document.getElementById('color');
  const eyeBtn = document.getElementById('eyedropBtn');
  const swHost = document.getElementById('swatchHost');

  const setChip = (hex)=>{
    document.documentElement.style.setProperty('--ui-color', hex);
    const dot = document.querySelector('#colorBtn .chip .dot'); if (dot) dot.style.backgroundColor = hex;
  };

  let current = toHex6(state.settings?.color || input?.value || '#88ccff') || '#88ccff';
  if (input) input.value = current;
  setChip(current);

  const swAPI = buildSwatches(swHost, ()=>current, (hex)=>setColor(hex));

  function setColor(hex, { push=true }={}){
    const h=toHex6(hex); if (!h) return;
    current=h; if (input && input.value.toLowerCase()!==h) input.value=h;
    state.settings.color=h; if (push) pushRecent(h);
    setChip(h); markDirty(); scheduleRender(); swAPI.highlight(); swAPI.refreshRecent(h);
  }

  input?.addEventListener('input', ()=>setColor(input.value));
  input?.addEventListener('change',()=>setColor(input.value));

  if (eyeBtn){
    if (!('EyeDropper' in window)){
      eyeBtn.disabled=true; eyeBtn.title='Eyedropper not supported in this browser';
    } else {
      eyeBtn.addEventListener('click', async ()=>{
        try{ const ed=new window.EyeDropper(); const res=await ed.open(); if (res?.sRGBHex) setColor(res.sRGBHex); }catch{}
      });
    }
  }

  setInterval(()=>{
    const from = toHex6(state.settings?.color);
    if (from && from!==current){ setColor(from, { push:false }); setChip(from); }
  }, 800);
}

function initColorPanelHover(){
  const colorBtn   = document.getElementById('colorBtn');
  const colorPanel = document.getElementById('colorPanel');

  function place(){
    const r = colorBtn.getBoundingClientRect();
    colorPanel.style.left = ((r.left+r.right)/2)+'px';
    colorPanel.style.top  = (r.top-10)+'px';
  }
  function open(){ place(); colorPanel.style.display='block'; requestAnimationFrame(()=>colorPanel.classList.add('open')); }
  function close(){ colorPanel.classList.remove('open'); setTimeout(()=>{ if(!colorPanel.classList.contains('open')) colorPanel.style.display='none'; },120); }

  let t=0; const soon=()=>{ clearTimeout(t); t=setTimeout(close,120); };
  const now =()=>{ clearTimeout(t); open(); };

  colorBtn?.addEventListener('mouseenter', now);
  colorBtn?.addEventListener('mouseleave', soon);
  colorPanel?.addEventListener('mouseenter', now);
  colorPanel?.addEventListener('mouseleave', soon);
  window.addEventListener('resize', ()=>{ if (colorPanel.classList.contains('open')) place(); });
}

const SIZE_STEPS=[4,8,12,20,32];
function buildSizeRow(state){
  const row=document.getElementById('sizeRow'); if(!row) return;
  row.innerHTML='';
  const cur=Math.round(state.settings?.size??6);

  SIZE_STEPS.forEach(sz=>{
    const b=document.createElement('button'); b.type='button'; b.className='size-chip'; b.setAttribute('aria-label',`Size ${sz}px`);
    const d=document.createElement('span'); d.className='dot'; d.style.setProperty('--d', `${Math.max(6,Math.min(22,Math.round(sz*0.6)))}px`);
    b.appendChild(d); if (cur===sz) b.classList.add('current');

    b.addEventListener('click', (e)=>{
      e.stopPropagation(); state.settings.size=sz;
      row.querySelectorAll('.size-chip').forEach(el=>el.classList.remove('current')); b.classList.add('current');
      openOpacityPopover(state, b); markDirty(); scheduleRender();
    });
    b.addEventListener('wheel',(e)=>{
      e.preventDefault(); openOpacityPopover(state, b);
      const step=(e.deltaY>0?-2:2);
      setOpacityPct(state, clampPct(Math.round((state.settings.opacity??1)*100)+step));
      renderOpacityUI(state);
    }, { passive:false });

    row.appendChild(b);
  });
}
function clampPct(p){ return Math.max(5, Math.min(100, p|0)); }
let _opacityAnchor=null;
function openOpacityPopover(state, anchor){
  const pop=document.getElementById('opacityPopover'); const slider=document.getElementById('opacitySlider');
  if(!pop||!slider||!anchor) return;
  _opacityAnchor=anchor; positionOpacityPopover(anchor); openOpacityBadge(state, anchor);
  renderOpacityUI(state); pop.classList.add('open'); pop.setAttribute('aria-hidden','false'); try{ slider.focus(); }catch{}
  const onDocDown=(ev)=>{ if (!pop.classList.contains('open')) return cleanup(); if (pop.contains(ev.target)||anchor.contains(ev.target)) return; closeOpacityPopover(); cleanup(); };
  const onKey=(ev)=>{ if (ev.key==='Escape'){ closeOpacityPopover(); cleanup(); } };
  document.addEventListener('pointerdown', onDocDown); window.addEventListener('keydown', onKey, { once:true });
  function cleanup(){ document.removeEventListener('pointerdown', onDocDown); }
}
function closeOpacityPopover(){ const pop=document.getElementById('opacityPopover'); if(!pop) return; pop.classList.remove('open'); pop.setAttribute('aria-hidden','true'); closeOpacityBadge(); }
function positionOpacityPopover(anchor){
  const pop=document.getElementById('opacityPopover'); if(!pop||!anchor) return;
  const r=anchor.getBoundingClientRect(); pop.style.left=((r.left+r.right)/2)+'px'; pop.style.top=r.top+'px';
}

function openOpacityBadge(state, anchor){
  const badge=document.getElementById('opacityBadge'); if(!badge||!anchor) return;
  updateOpacityBadgeFromState(state); const r=anchor.getBoundingClientRect();
  badge.style.left=((r.left+r.right)/2)+'px'; badge.style.top=r.top+'px'; badge.style.display='block'; badge.setAttribute('aria-hidden','false');
}
function closeOpacityBadge(){ const badge=document.getElementById('opacityBadge'); if(!badge) return; badge.style.display='none'; badge.setAttribute('aria-hidden','true'); }
function updateOpacityBadgeFromState(state){ const badge=document.getElementById('opacityBadge'); if(!badge) return; badge.textContent=`${Math.round((state.settings.opacity??1)*100)}%`; }
function setOpacityPct(state, pct){ state.settings.opacity = clampPct(pct)/100; }
function renderOpacityUI(state){
  const slider=document.getElementById('opacitySlider');
  const rail=slider?.querySelector('.alpha-rail'); const fill=slider?.querySelector('.alpha-fill'); const thumb=slider?.querySelector('.alpha-thumb');
  if(!slider||!rail||!fill||!thumb) return;

  const pct=Math.round((state.settings.opacity??1)*100);
  const sliderRect = slider.getBoundingClientRect();
  const railRect   = rail.getBoundingClientRect();
  const railTop = railRect.top - sliderRect.top;
  const railHeight = railRect.height;
  const thumbH = 20;
  const fillH = (pct/100) * railHeight;
  fill.style.height = `${Math.max(0, Math.min(railHeight, fillH))}px`;
  const relTop = (1 - pct/100) * (railHeight - thumbH);
  const clampedTop = Math.max(railTop, Math.min(railTop + railHeight - thumbH, railTop + relTop));
  thumb.style.top = `${clampedTop}px`;

  slider.setAttribute('aria-valuenow', String(pct));
  updateOpacityBadgeFromState(state);
}
function initOpacityPopover(state){
  const slider=document.getElementById('opacitySlider'); const pop=document.getElementById('opacityPopover');
  if(!slider||!pop) return;

  const rail=slider.querySelector('.alpha-rail');
  const getPct=(ev)=>{
    const railRect=rail.getBoundingClientRect();
    const y = ('touches' in ev ? ev.touches[0].clientY : ev.clientY);
    const ratio = 1 - ((y - railRect.top) / railRect.height); 
    const raw = clampPct(Math.round(5 + (Math.max(0, Math.min(1, ratio)) * 95)));
    const snapped = Math.round(raw/5)*5;
    return Math.max(5, Math.min(100, snapped));
  };

  let dragging=false;
  const onDown=(ev)=>{ ev.preventDefault(); dragging=true; slider.focus(); setOpacityPct(state, getPct(ev)); renderOpacityUI(state); markDirty(); scheduleRender(); };
  const onMove=(ev)=>{ if(!dragging) return; ev.preventDefault(); setOpacityPct(state, getPct(ev)); renderOpacityUI(state); markDirty(); scheduleRender(); };
  const onUp=()=>{ dragging=false; };

  slider.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  slider.addEventListener('touchstart', onDown, { passive:false });
  window.addEventListener('touchmove', onMove, { passive:false });
  window.addEventListener('touchend', onUp);

  slider.addEventListener('wheel',(e)=>{
    e.preventDefault();
    const step=(e.deltaY>0?-5:5); setOpacityPct(state, clampPct(Math.round((state.settings.opacity??1)*100)+step));
    renderOpacityUI(state); markDirty(); scheduleRender();
  }, { passive:false });

  slider.addEventListener('keydown',(e)=>{
    const k=e.key;
    const cur=Math.round((state.settings.opacity??1)*100);
    const delta = k==='ArrowUp'?+5 : k==='ArrowDown'?-5 : k==='PageUp'?+10 : k==='PageDown'?-10 : k==='Home'?(100-cur) : k==='End'?(5-cur) : 0;
    if (delta!==0){ e.preventDefault(); setOpacityPct(state, clampPct(cur+delta)); renderOpacityUI(state); markDirty(); scheduleRender(); }
  });

  const reposition=()=>{ if(_opacityAnchor && pop.classList.contains('open')){ positionOpacityPopover(_opacityAnchor); const r=_opacityAnchor.getBoundingClientRect(); const badge=document.getElementById('opacityBadge'); if(badge){ badge.style.left=((r.left+r.right)/2)+'px'; badge.style.top=r.top+'px'; } } };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
}

/* ---------- Selection HUD helpers (unchanged) ---------- */
function deepCloneForClipboard(s){
  if (!s) return null;
  if (s.kind==='path'){
    let pts, n=null;
    if (s.n!=null && s.pts && typeof s.pts.BYTES_PER_ELEMENT==='number'){ pts=s.pts.slice(0,s.n); n=pts.length; }
    else if (Array.isArray(s.pts)){ pts=s.pts.map(p=>({x:+p.x||0,y:+p.y||0,p:(p.p!=null?+p.p:0.5)})); n=null; }
    else { pts=new Float32Array(0); n=0; }
    return { kind:'path', mode:s.mode||'draw', brush:s.brush, color:s.color, alpha:s.alpha, w:s.w,
      pts, n, bbox:{...s.bbox}, react2:(s.react2?JSON.parse(JSON.stringify(s.react2)):null), fill:!!s.fill };
  }
  return { kind:'shape', mode:s.mode||'draw', brush:s.brush, color:s.color, alpha:s.alpha, w:s.w,
    shape:s.shape, fill:!!s.fill, start:{...s.start}, end:{...s.end}, bbox:{...s.bbox}, react2:(s.react2?JSON.parse(JSON.stringify(s.react2)):null) };
}
function materializeFromClipboard(data, state){
  const base={ id: (crypto?.randomUUID?.()||('s-'+Math.random().toString(36).slice(2,10))), mode:data.mode||'draw', brush:data.brush, color:data.color, alpha:data.alpha, w:data.w, timestamp:performance.now(), _baked: !state._bake?.active };
  if (data.kind==='path'){
    let pts=data.pts, n=data.n;
    if (n!=null && pts && typeof pts.BYTES_PER_ELEMENT==='number'){ pts=pts.slice(0,n); n=pts.length; }
    else if (Array.isArray(pts)){ n=null; } else { pts=new Float32Array(0); n=0; }
    return { ...base, kind:'path', pts, n, bbox:{...data.bbox}, _chunks:null, react2:(data.react2?JSON.parse(JSON.stringify(data.react2)):null), fill:!!data.fill };
  }
  return { ...base, kind:'shape', shape:data.shape, fill:!!data.fill, start:{...data.start}, end:{...data.end}, bbox:{...data.bbox}, react2:(data.react2?JSON.parse(JSON.stringify(data.react2)):null) };
}

function mountGalleryPlusCard(state) {
  const btn = document.getElementById('newCanvasFAB');
  if (!btn || btn._wired) return;
  btn._wired = true;
  const fire = () => document.dispatchEvent(new CustomEvent('gallery:new-canvas'));
  btn.addEventListener('click', fire);
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
  });
}

export function initUI({ state, canvas, camera, setTool }){
  document.querySelectorAll('[data-tool]').forEach(b=> b.addEventListener('click', ()=> setTool(b.dataset.tool)));

  const qBrush=document.getElementById('quickBrush');
  if (qBrush){ qBrush.value=state.brush||'pen'; qBrush.addEventListener('change', ()=>{ state.brush=qBrush.value; scheduleRender(); markDirty(); }); }

  buildSizeRow(state);
  initOpacityPopover(state);
  setInterval(()=>{
    const s=Math.round(state.settings?.size??6);
    document.querySelectorAll('#sizeRow .size-chip').forEach(el=>{
      const val=parseInt(el.getAttribute('aria-label')?.replace(/\D+/g,'')||'0',10);
      el.classList.toggle('current', val===s);
    });
    renderOpacityUI(state);
  }, 600);

  document.getElementById('undo')?.addEventListener('click', ()=> state.history?.undo());
  document.getElementById('redo')?.addEventListener('click', ()=> state.history?.redo());
  document.getElementById('clear')?.addEventListener('click', ()=>{
    if (!state.strokes.length) return;
    const prev=state.strokes.slice(); clearAll(state); state.history?.pushClear?.(prev);
  });

  window.addEventListener('keydown',(e)=>{
    const isMod=e.metaKey||e.ctrlKey; if(!isMod) return;
    const t=e.target; if (t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
    const k=(e.key||'').toLowerCase();

    if (k==='c'){
      if (state.selection && state.selection.size){
        const clip=[]; for (const s of state.selection){ const d=deepCloneForClipboard(s); if(d) clip.push(d); }
        state.clipboard = clip.length?clip:null;
      }
      if (state.clipboard) e.preventDefault();
    }
    if (k==='v'){
      if (!state.clipboard||!state.clipboard.length) return; e.preventDefault();
      const dx=16/Math.max(1e-8, camera.scale); const dy=16/Math.max(1e-8, camera.scale);
      const pasted=[];
      for (const d of state.clipboard){
        const s=materializeFromClipboard(d, state);
        transformStrokeGeom(s, { sx:1,sy:1,ox:0,oy:0,tx:dx,ty:dy }); state.strokes.push(s); insert(grid, s); pasted.push(s);
      }
      try{ state.selection?.clear?.(); }catch{}
      for (const s of pasted) state.selection?.add?.(s);
      state.history?.pushAddGroup?.(pasted); markDirty(); scheduleRender();
    }
  });

  initColorUI(state);
  initColorPanelHover();
  mountGalleryPlusCard(state);

  const poseHud = document.getElementById('poseHud');
  function selectionBBoxWorld(){
    const bake=state._bake; let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
    for (const s of (state.selection||[])){
      if (!s?.bbox) continue; let b=s.bbox;
      if (bake?.active && s._baked===false){ const s0=bake.s,tx=bake.tx,ty=bake.ty; b={minx:b.minx*s0+tx,miny:b.miny*s0+ty,maxx:b.maxx*s0+tx,maxy:b.maxy*s0+ty}; }
      if (b.minx<minx) minx=b.minx; if (b.miny<miny) miny=b.miny; if (b.maxx>maxx) maxx=b.maxx; if (b.maxy>maxy) maxy=b.maxy;
    }
    if (!Number.isFinite(minx)) return null; return {minx,miny,maxx,maxy};
  }
  function getAnimLayer(s){ const L=s?.react2?.anim?.layers; return (L&&L.length)?L[0]:null; }
  function getStyleLayer(s){ const L=s?.react2?.style?.layers; return (L&&L.length)?L[0]:null; }

  function syncAnimControlsVisibility(t){
    const speed=document.getElementById('animSpeedWrap'), amt=document.getElementById('animAmountWrap'),
          axis=document.getElementById('animAxisWrap'), rad=document.getElementById('animRadiusWrap'),
          rot=document.getElementById('animRotWrap'), pos=document.getElementById('animPosWrap');
    if (speed) speed.style.display=(t==='none')?'none':'';
    [amt,axis,rad,rot,pos].forEach(n=>{ if(n) n.style.display='none'; });
    if (t==='sway') amt&&(amt.style.display='');
    if (t==='pulse'||t==='bounce'){ amt&&(amt.style.display=''); axis&&(axis.style.display=''); }
    if (t==='orbit') rad&&(rad.style.display='');
    if (t==='shake'){ pos&&(pos.style.display=''); rot&&(rot.style.display=''); }
    if (t==='pendulum') rot&&(rot.style.display='');
    if (t==='float'){ pos&&(pos.style.display=''); rot&&(rot.style.display=''); }
    if (t==='drift') pos&&(pos.style.display='');
  }
  function syncStyleControlsVisibility(t){
    const speed=document.getElementById('styleSpeedWrap'), amount=document.getElementById('styleAmountWrap'),
          hue=document.getElementById('styleHueWrap'), rate=document.getElementById('styleRateWrap');
    if (!speed||!amount||!hue||!rate) return;
    speed.style.display=(t==='none')?'none':''; amount.style.display='none'; hue.style.display='none'; rate.style.display='none';
    if (['width','opacity','glow','blur','saturation','lightness'].includes(t)) amount.style.display='';
    if (t==='hue') hue.style.display='';
    if (t==='dash') rate.style.display='';
  }

  function updateAnimFromSel(){
    const s = Array.from(state.selection||[])[0]; if (!s) return;
    const L = getAnimLayer(s); const t=L?.type||'none';
    const animType=document.getElementById('animType');
    const animSpeed=document.getElementById('animSpeed'); const animAmount=document.getElementById('animAmount');
    const animAxis=document.getElementById('animAxis'); const animRadiusX=document.getElementById('animRadiusX');
    const animRadiusY=document.getElementById('animRadiusY'); const animRotAmt=document.getElementById('animRotAmt'); const animPosAmt=document.getElementById('animPosAmt');
    if (animType) animType.value=t; syncAnimControlsVisibility(t);
    animSpeed&&(animSpeed.value=(L?.speed??1)); animAmount&&(animAmount.value=(L?.amount??0.15));
    animAxis&&(animAxis.value=(L?.axis??'xy')); animRadiusX&&(animRadiusX.value=(L?.radiusX??12)); animRadiusY&&(animRadiusY.value=(L?.radiusY??12));
    animRotAmt&&(animRotAmt.value=(L?.amountRot??0.02)); animPosAmt&&(animPosAmt.value=(L?.amountPos??2));
  }
  function updateStyleFromSel(){
    const s = Array.from(state.selection||[])[0]; if (!s) return;
    const L = getStyleLayer(s); const t=L?.type||'none';
    const styleType=document.getElementById('styleType'); if (!styleType) return;
    styleType.value=t; const rateLabel=document.querySelector('#styleRateWrap .mini'); if (rateLabel) rateLabel.textContent=(t==='dash'?'Dash px':'px/s');
    syncStyleControlsVisibility(t);
    const styleSpeed=document.getElementById('styleSpeed'); const styleAmount=document.getElementById('styleAmount');
    const styleHue=document.getElementById('styleHue'); const styleRate=document.getElementById('styleRate');
    styleSpeed&&(styleSpeed.value=(L?.speed??1)); styleAmount&&(styleAmount.value=(L?.amount??0.15)); styleHue&&(styleHue.value=(L?.deg??30));
    if (t==='dash'){const w=s?.w??6; const fallback=Math.max(2,w*2.2);styleRate.value = (Number.isFinite(L?.dashLen) ? L.dashLen : fallback);}
    else { styleRate&&(styleRate.value=(L?.rate??120)); }
  }


  function firstSel(){ return Array.from(state.selection||[])[0]||null; }

  function ensureAnimLayer(s) {
    s.react2 = s.react2 || {};
    const anim = s.react2.anim || (s.react2.anim = { layers: [] });
    let L = anim.layers[0];
    if (!L) anim.layers[0] = L = { enabled: true, type: 'none', speed: 1 };
    return L;
  }

  function ensureStyleLayer(s){
    s.react2 = s.react2 || {};
    const style = s.react2.style || (s.react2.style = { layers: [] });
    return style.layers[0] || (style.layers[0] = { enabled:true, type:'none', speed:1 });
  }

  function commit(mutator){
    const s = firstSel(); if(!s) return;
    mutator(s); markDirty(); scheduleRender(); updateHud();
  }

  function eachSel(fn){
    const arr = Array.from(state.selection || []);
    if (!arr.length) return false;
    for (const s of arr) fn(s);
    markDirty(); scheduleRender(); updateHud();
    return true;
  }

  // shared pivot at selection center (world space)
  function selectionCenter() {
    const bb = selectionBBoxWorld();
    return bb ? { x: (bb.minx + bb.maxx) / 2, y: (bb.miny + bb.maxy) / 2 } : null;
  }

  // Optional: reuse an existing groupId if present; else create one
  function pickGroupId(){
    for (const s of (state.selection || [])){
      const L = getAnimLayer(s);
      if (L?.groupId) return L.groupId;
    }
    return 'g-' + Math.random().toString(36).slice(2,10);
  }

  // ---- wire ANIM controls
  const animType   = document.getElementById('animType');
  const animSpeed  = document.getElementById('animSpeed');
  const animAmount = document.getElementById('animAmount');
  const animAxis   = document.getElementById('animAxis');
  const animRadiusX= document.getElementById('animRadiusX');
  const animRadiusY= document.getElementById('animRadiusY');
  const animRotAmt = document.getElementById('animRotAmt');
  const animPosAmt = document.getElementById('animPosAmt');

  animType?.addEventListener('change', () => {
    const t = animType.value;
    const pv = selectionCenter();
    const gid = pickGroupId();
    eachSel(s => {
      const L = ensureAnimLayer(s);
      L.type = t;
      L.enabled = (t !== 'none');
      if (t !== 'none' && pv){
        L.pivot = { x: pv.x, y: pv.y };   // shared center => spins as one unit
        L.groupId = gid;                  // keep random-phased styles in sync later
      }
    });
  });

  animSpeed?.addEventListener('input', () => {
    const v = Number(animSpeed.value) || 1;
    eachSel(s => { ensureAnimLayer(s).speed = v; });
  });

  animAmount?.addEventListener('input', () => {
    const v = Number(animAmount.value) || 0;
    eachSel(s => { ensureAnimLayer(s).amount = v; });
  });

  animAxis?.addEventListener('change', () => {
    const v = animAxis.value || 'xy';
    eachSel(s => { ensureAnimLayer(s).axis = v; });
  });

  animRadiusX?.addEventListener('input', () => {
    const v = Number(animRadiusX.value) || 0;
    eachSel(s => { ensureAnimLayer(s).radiusX = v; });
  });

  animRadiusY?.addEventListener('input', () => {
    const v = Number(animRadiusY.value) || 0;
    eachSel(s => { ensureAnimLayer(s).radiusY = v; });
  });

  animRotAmt?.addEventListener('input', () => {
    const v = Number(animRotAmt.value) || 0;
    eachSel(s => { ensureAnimLayer(s).amountRot = v; });
  });

  animPosAmt?.addEventListener('input', () => {
    const v = Number(animPosAmt.value) || 0;
    eachSel(s => { ensureAnimLayer(s).amountPos = v; });
  });

  // --- STYLE: make "Dash px" + others apply to all
  styleType?.addEventListener('change', () => {
    const t = styleType.value;
    eachSel(s => {
      const L = ensureStyleLayer(s);
      L.type = t;
      L.enabled = (t !== 'none');
    });
  });

  styleSpeed?.addEventListener('input', () => {
    const v = Number(styleSpeed.value) || 1;
    eachSel(s => { ensureStyleLayer(s).speed = v; });
  });

  styleAmount?.addEventListener('input', () => {
    const v = Number(styleAmount.value) || 0;
    eachSel(s => { ensureStyleLayer(s).amount = v; });
  });

  styleHue?.addEventListener('input', () => {
    const v = Number(styleHue.value) || 0;
    eachSel(s => { ensureStyleLayer(s).deg = v; });
  });

  // Dash control: when in 'dash' type, this is dashLen (px). Otherwise it's rate (px/s)
  styleRate?.addEventListener('input', () => {
    const t = styleType?.value || 'none';
    const v = Math.max(1, Math.round(Number(styleRate.value) || 0));
    eachSel(s => {
      const L = ensureStyleLayer(s);
      if (t === 'dash') { L.dashLen = v; delete L.rate; }
      else { L.rate = v; delete L.dashLen; }
    });
  });

  function updateHud(){
    const poseHud = document.getElementById('poseHud');
    if (!poseHud) return;
    const show = state.tool==='select' && (state.selection?.size||0)>0;
    if (!show){ poseHud.style.display='none'; poseHud.setAttribute('aria-hidden','true'); return; }

    const bake=state._bake; let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
    for (const s of (state.selection||[])){
      if (!s?.bbox) continue; let b=s.bbox;
      if (bake?.active && s._baked===false){ const s0=bake.s,tx=bake.tx,ty=bake.ty; b={minx:b.minx*s0+tx,miny:b.miny*s0+ty,maxx:b.maxx*s0+tx,maxy:b.maxy*s0+ty}; }
      if (b.minx<minx) minx=b.minx; if (b.miny<miny) miny=b.miny; if (b.maxx>maxx) maxx=b.maxx; if (b.maxy>maxy) maxy=b.maxy;
    }
    if (!Number.isFinite(minx)){ poseHud.style.display='none'; poseHud.setAttribute('aria-hidden','true'); return; }
    const cx=(minx+maxx)/2; const bottom={x:cx,y:maxy}; const sp=camera.worldToScreen(bottom);
    poseHud.style.left=Math.round(sp.x)+'px'; poseHud.style.top=(Math.round(sp.y)+10)+'px';
    poseHud.style.transform='translate(-50%,0)'; poseHud.style.display='block'; poseHud.setAttribute('aria-hidden','false');

    updateAnimFromSel(); updateStyleFromSel();
  }
  subscribe(updateHud); window.addEventListener('resize', updateHud); setTimeout(updateHud,0);

  return { updatePosePanel: updateHud, updatePoseHud: updateHud };
}

