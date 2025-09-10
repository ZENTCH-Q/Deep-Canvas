// src/docs.js
import { queueSetItem, setItemWithRetries, safeRemoveItem } from './utils/storage.js';
import { telemetry } from './utils/telemetry.js';

const LS_LIST_KEY = 'dc_docs';
const LS_DOC_PREFIX = 'dc_doc_';
const LS_CREATE_DEFAULTS = 'dc_create_defaults';

function newId() {
  return (crypto?.randomUUID?.() || ('d-' + Math.random().toString(36).slice(2, 10)));
}

export function loadThumb(id) {
  try {
    const d = getDoc(id);
    return d?.thumb || null;
  } catch {
    return null;
  }
}

export function listDocs() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_LIST_KEY) || '[]');
    return Array.isArray(arr) ? arr.sort((a,b)=> (b?.updated||0)-(a?.updated||0)) : [];
  } catch { return []; }
}

export function getDoc(id) {
  if (!id) return null;
  try { return JSON.parse(localStorage.getItem(LS_DOC_PREFIX + id) || 'null'); } catch { return null; }
}

export function saveDocMeta(meta) {
  const list = listDocs().filter(d => d && d.id !== meta.id);
  list.unshift({
    id: meta.id,
    name: meta.name || 'Untitled',
    updated: meta.updated || Date.now(),
    thumb: meta.thumb || null
  });
  // Coalesced queued write; callers may ignore the returned Promise
  return queueSetItem(LS_LIST_KEY, JSON.stringify(list));
}

export async function saveDocFull(doc) {
  if (!doc || !doc.id) return false;
  const key = LS_DOC_PREFIX + doc.id;
  try { document?.dispatchEvent?.(new CustomEvent('docs:save:begin', { detail: { id: doc.id } })); } catch {}
  let ok = await setItemWithRetries(key, JSON.stringify(doc));
  if (!ok && doc.thumb) {
    // Retry without thumbnail to reduce payload if quota is tight
    try {
      const slim = { ...doc, thumb: null };
      telemetry.record('docs.save.retry_without_thumb', { id: doc.id });
      ok = await setItemWithRetries(key, JSON.stringify(slim));
    } catch {}
  }
  // Update list meta (queued)
  await saveDocMeta({ id: doc.id, name: doc.name, updated: doc.updated, thumb: doc.thumb || null });
  try {
    if (ok) document?.dispatchEvent?.(new CustomEvent('docs:save:end', { detail: { id: doc.id, ok: true } }));
    else document?.dispatchEvent?.(new CustomEvent('docs:save:error', { detail: { id: doc.id, reason: 'quota_or_unknown' } }));
  } catch {}
  return ok;
}

function loadCreateDefaults(){
  try{
    const raw = localStorage.getItem(LS_CREATE_DEFAULTS);
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === 'object') return v;
  }catch{}
  return { w: 1600, h: 1000, bg: '#0f1115' };
}
function saveCreateDefaults(def){
  try{
    const cur = loadCreateDefaults();
    const next = { w: Math.max(256, +def.w||cur.w||1600), h: Math.max(256, +def.h||cur.h||1000), bg: (def.bg||cur.bg||'#0f1115') };
    localStorage.setItem(LS_CREATE_DEFAULTS, JSON.stringify(next));
  }catch{}
}
function resolveTemplateDims(tpl){
  switch(String(tpl||'').toLowerCase()){
    case 'square':   return { w: 2048, h: 2048 };
    case 'hd':       return { w: 1920, h: 1080 };
    case 'portrait': return { w: 1080, h: 1920 };
    case 'story':    return { w: 1080, h: 1920 };
    case 'a4':       return { w: 2480, h: 3508 };
    case 'letter':   return { w: 2550, h: 3300 };
    case 'default':  return { w: 1600, h: 1000 };
    case 'last':     return loadCreateDefaults();
    default: return null;
  }
}

export function createDoc(opts = 'Untitled') {
  const id = newId();
  const defaults = loadCreateDefaults();
  const name = (typeof opts === 'string') ? (opts || 'Untitled') : (opts?.name || 'Untitled');
  const tplDims = (typeof opts === 'object' && opts?.template) ? resolveTemplateDims(opts.template) : null;
  const rawW = (typeof opts === 'object' && Number.isFinite(+opts.width)) ? Math.floor(+opts.width) : (tplDims?.w ?? defaults.w ?? 1600);
  const rawH = (typeof opts === 'object' && Number.isFinite(+opts.height)) ? Math.floor(+opts.height) : (tplDims?.h ?? defaults.h ?? 1000);
  const CAP = 8192;
  const w = Math.max(256, Math.min(CAP, rawW|0));
  const h = Math.max(256, Math.min(CAP, rawH|0));
  const bg = (typeof opts === 'object' && typeof opts.background === 'string') ? opts.background : (tplDims?.bg ?? (defaults.bg || '#0f1115'));
  const transparent = !!(typeof opts === 'object' && opts.transparentBackground);

  const srcId = (typeof opts === 'object' && opts?.duplicateOf) ? String(opts.duplicateOf) : null;
  let baseDoc = null;
  if (srcId) { try { baseDoc = getDoc(srcId); } catch {} }

  const now = Date.now();
  let doc;
  if (baseDoc && baseDoc.data) {
    const copyName = (baseDoc.name || 'Untitled') + ' (copy)';
    doc = {
      id,
      name: name || copyName,
      updated: now,
      data: {
        ...baseDoc.data,
        size: { w, h },
        background: transparent ? { color: (baseDoc.data?.background?.color || bg), alpha: 0 } : { color: (baseDoc.data?.background?.color || bg), alpha: Number.isFinite(+baseDoc.data?.background?.alpha) ? +baseDoc.data.background.alpha : 1 },
        meta: { modified: now }
      },
      camera: { ...(baseDoc.camera || {}), s: Number.isFinite(baseDoc.camera?.s) ? baseDoc.camera.s : 1.25, tx: Number.isFinite(baseDoc.camera?.tx) ? baseDoc.camera.tx : 0, ty: Number.isFinite(baseDoc.camera?.ty) ? baseDoc.camera.ty : 0 },
      createdCamera: { ...(baseDoc.createdCamera || {}), s: Number.isFinite(baseDoc.createdCamera?.s) ? baseDoc.createdCamera.s : 1.25, tx: Number.isFinite(baseDoc.createdCamera?.tx) ? baseDoc.createdCamera.tx : 0, ty: Number.isFinite(baseDoc.createdCamera?.ty) ? baseDoc.createdCamera.ty : 0 },
      thumb: null
    };
  } else {
    doc = {
      id,
      name,
      updated: now,
      data: {
        version: 2,
        strokes: [],
        size: { w, h },
        background: transparent ? { color: bg, alpha: 0 } : { color: bg, alpha: 1 },
        meta: { modified: now }
      },
      camera: { s: 1.25, tx: 0, ty: 0 },
      createdCamera: { s: 1.25, tx: 0, ty: 0 },
      thumb: null
    };
  }
  // Persist last-used defaults
  saveCreateDefaults({ w, h, bg });
  try { telemetry.record('docs.create', { id, w, h, bg, mode: (srcId ? 'duplicate' : (tplDims ? 'template' : 'custom')), transparent }); } catch {}
  // Fire-and-forget persistence
  void saveDocFull(doc);
  return doc;
}

export function renameDoc(id, nextName) {
  const d = getDoc(id); if (!d) return null;
  d.name = String(nextName || 'Untitled');
  d.updated = Date.now();
  void saveDocFull(d);
  return d;
}

export async function deleteDoc(id) {
  await safeRemoveItem(LS_DOC_PREFIX + id);
  const list = listDocs().filter(d => d && d.id !== id);
  await queueSetItem(LS_LIST_KEY, JSON.stringify(list));
}

export function saveDocThumb(id, dataUrl) {
  if (!id) return;
  const d = getDoc(id); if (!d) return;
  d.thumb = dataUrl || null;
  d.updated = Date.now();
  void saveDocFull(d);
}
