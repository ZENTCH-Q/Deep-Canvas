// src/docs.js
import { queueSetItem, setItemWithRetries, safeRemoveItem } from './utils/storage.js';
import { telemetry } from './utils/telemetry.js';

const LS_LIST_KEY = 'dc_docs';
const LS_DOC_PREFIX = 'dc_doc_';

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
  return ok;
}

export function createDoc(opts = 'Untitled') {
  const id = newId();
  const name = (typeof opts === 'string') ? (opts || 'Untitled') : (opts?.name || 'Untitled');
  const w = (typeof opts === 'object' && Number.isFinite(+opts.width)) ? Math.max(256, Math.floor(+opts.width)) : 1600;
  const h = (typeof opts === 'object' && Number.isFinite(+opts.height)) ? Math.max(256, Math.floor(+opts.height)) : 1000;
  const bg = (typeof opts === 'object' && typeof opts.background === 'string') ? opts.background : '#0f1115';

  const doc = {
    id,
    name,
    updated: Date.now(),
    data: {
      version: 2,
      strokes: [],
      size: { w, h },
      background: { color: bg, alpha: 1 },
      meta: { modified: Date.now() }
    },
    camera: { s: 1.25, tx: 0, ty: 0 },
    createdCamera: { s: 1.25, tx: 0, ty: 0 },
    thumb: null
  };
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
