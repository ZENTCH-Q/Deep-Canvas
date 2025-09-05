// src/state.js

export const state = {
  strokes: [],
  tool: 'draw',
  brush: 'pen',
  settings: { color: '#88ccff', size: 6, opacity: 1, fill: false },
  background: { color: '#0f1115', alpha: 1 },
  meta: { id: null, name: 'Untitled', modified: 0 },
  selection: new Set(),
  undoStack: [],
  redoStack: [],
  history: null,
  dirty: false,
  _deferIndex: false,
  _bake: null,
  _drawingActive: false,
  _erasingActive: false,
  _navActive: false,
  _navBuf: null,
  _navBufCtx: null,
  _navBmp: null,
  _navCam0: null,
  _navAllowLive: false,
  _marquee: null,
  _transformActive: false,
  clipboard: null,
  _audio: { t: 0, playing: false },
  _anim: { t: 0, playing: true },
};

const subs = new Set();
let raf = 0;

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    for (const fn of subs) fn(state);
  });
}

let saveTimer = 0;
export function markDirty() {
  state.dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1200);
}

function prepareStrokeForSave(s) {
  const out = { ...s };
  delete out._gridKeys;
  delete out._bakeJ;
  delete out._bakeK;
  delete out._lodCache; 

  if (
    out.kind === 'path' &&
    out.n != null &&
    out.pts &&
    typeof out.pts.BYTES_PER_ELEMENT === 'number'
  ) {
    const n = Math.max(0, Math.floor(out.n / 3) * 3);
    out.pts = Array.from(out.pts.slice(0, n));
  }
  return out;
}

function serialize() {
  const m = {
    id: state.meta?.id ?? null,
    name: state.meta?.name ?? 'Untitled',
    modified: Date.now()
  };
  return JSON.stringify({
    version: 2,
    strokes: state.strokes.map(prepareStrokeForSave),
    background: state.background,
    meta: m
  });
}

export function exportJSON() {
  return serialize();
}

export function importJSON(raw, s = state) {
  try {
    const doc = JSON.parse(raw);
    if (!doc || !Array.isArray(doc.strokes)) return false;
    const fixed = [];
    for (const st of doc.strokes) if (st) fixed.push(normalizeLoadedStroke(st));
    s.strokes.splice(0, s.strokes.length, ...fixed);
    if (doc.background && typeof doc.background.color === 'string') {
      const a = Number(doc.background.alpha);
      s.background = {
        color: doc.background.color,
        alpha: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1
      };
    }
    s.meta = {
      id: doc.meta?.id ?? s.meta?.id ?? null,
      name: doc.meta?.name ?? s.meta?.name ?? 'Untitled',
      modified: doc.meta?.modified ?? Date.now()
    };
    s.selection?.clear?.();
    s._bake = null; s._deferIndex = false; s._transformActive = false;
    scheduleRender();
    return true;
  } catch { return false; }
}

function saveNow() {
  try {
    localStorage.setItem('endless_autosave_prev', localStorage.getItem('endless_autosave') || '');
    localStorage.setItem('endless_autosave', serialize());
    state.dirty = false;
  } catch { }
}

function coercePathPtsIfNeeded(st) {
  if (!st || st.kind !== 'path') return;
  if (st.pts && typeof st.pts.BYTES_PER_ELEMENT === 'number') return; // typed array
  if (Array.isArray(st.pts) && st.pts.length && typeof st.pts[0] === 'object') {
    st.n = null;
    return;
  }

  if (Array.isArray(st.pts) && st.pts.length && typeof st.pts[0] === 'number') {
    const a = st.pts;
    const out = [];
    for (let i = 0; i < a.length; i += 3) {
      out.push({
        x: +a[i] || 0,
        y: +a[i + 1] || 0,
        p: a[i + 2] != null ? +a[i + 2] : 0.5
      });
    }
    st.pts = out;
    st.n = null;
    st._chunks = st._chunks || null;
    return;
  }

  if (st.pts && typeof st.pts === 'object' && st.n != null && !Array.isArray(st.pts)) {
    const len = Math.max(0, Math.floor(+st.n / 3) * 3);
    const ta = new Float32Array(len);
    for (let i = 0; i < len; i++) ta[i] = +st.pts[i] || 0;
    st.pts = ta;
    st.n = len;
    st._chunks = st._chunks || null;
    return;
  }
}

function normalizeLoadedStroke(st) {
  if (!st) return st;
  if (st.brush === 'taper' || st.brush === 'square') st.brush = 'pen';
  if (typeof st.alpha === 'number') st.alpha = Math.max(0.05, Math.min(1, st.alpha));

  if (!st.bbox) {
    st.bbox = { minx: 0, miny: 0, maxx: 0, maxy: 0 };
  } else {
    st.bbox = {
      minx: +st.bbox.minx,
      miny: +st.bbox.miny,
      maxx: +st.bbox.maxx,
      maxy: +st.bbox.maxy
    };
    if (st.bbox.maxx < st.bbox.minx) [st.bbox.minx, st.bbox.maxx] = [st.bbox.maxx, st.bbox.minx];
    if (st.bbox.maxy < st.bbox.miny) [st.bbox.miny, st.bbox.maxy] = [st.bbox.maxy, st.bbox.miny];
  }

  if (st.kind === 'shape') {
    st.start = st.start ? { x: +st.start.x, y: +st.start.y } : { x: 0, y: 0 };
    st.end = st.end ? { x: +st.end.x, y: +st.end.y } : { x: 0, y: 0 };
  }

  if (st.kind === 'path') {
    coercePathPtsIfNeeded(st);
    if (!(st._chunks && Array.isArray(st._chunks))) st._chunks = null;
  }
  st._baked = true;
  if (typeof st.timestamp !== 'number') st.timestamp = Date.now();

  return st;
}

export function loadAutosave(s) {
  try {
    let raw = localStorage.getItem('endless_autosave');
    if (!raw) return false;

    let doc = JSON.parse(raw);

    if (!doc || !Array.isArray(doc.strokes) || doc.strokes.length === 0) {
      const prevRaw = localStorage.getItem('endless_autosave_prev');
      if (prevRaw) {
        try { doc = JSON.parse(prevRaw); } catch { }
      }
    }

    if (Array.isArray(doc?.strokes)) {
      const fixed = [];
      for (const st of doc.strokes) {
        if (!st) continue;
        fixed.push(normalizeLoadedStroke(st));
      }
      s.strokes.splice(0, s.strokes.length, ...fixed);
      if (doc.background && typeof doc.background.color === 'string') {
        const a = Number(doc.background.alpha);
        s.background = {
          color: doc.background.color,
          alpha: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1
        };
      }
      if (doc.meta) {
        s.meta = {
          id: doc.meta.id ?? s.meta?.id ?? null,
          name: doc.meta.name ?? s.meta?.name ?? 'Untitled',
          modified: doc.meta.modified ?? Date.now()
        };
      }
      s.selection?.clear?.();
      s._bake = null;
      s._deferIndex = false;
      s._transformActive = false;

      scheduleRender();
      return true;
    }
  } catch { }
  return false;
}

window.addEventListener('beforeunload', () => {
  if (state.dirty) {
    try { localStorage.setItem('endless_autosave', serialize()); } catch { }
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.dirty) {
    try { localStorage.setItem('endless_autosave', serialize()); } catch { }
  }
});

export function setDeferIndex(v) { state._deferIndex = !!v; }
export function shouldDeferIndex() { return !!state._deferIndex; }
