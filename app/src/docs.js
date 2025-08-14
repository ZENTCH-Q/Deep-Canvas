// src/docs.js

const LS_LIST_KEY = 'dc_docs';
const LS_DOC_PREFIX = 'dc_doc_';

function newId() {
  return (crypto?.randomUUID?.() || ('d-' + Math.random().toString(36).slice(2, 10)));
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
  try { localStorage.setItem(LS_LIST_KEY, JSON.stringify(list)); } catch {}
}

export function saveDocFull(doc) {
  if (!doc || !doc.id) return;
  try { localStorage.setItem(LS_DOC_PREFIX + doc.id, JSON.stringify(doc)); } catch {}
  saveDocMeta({ id: doc.id, name: doc.name, updated: doc.updated, thumb: doc.thumb || null });
}

export function createDoc(name = 'Untitled') {
  const id = newId();
  const doc = {
    id,
    name,
    updated: Date.now(),
    data: {
      version: 2,
      strokes: [], 
      background: { color: '#0f1115', alpha: 1 },
      meta: { modified: Date.now() }
    },
    camera: { s: 1.25, tx: 0, ty: 0 },
    thumb: null
  };
  saveDocFull(doc);
  return doc;
}

export function renameDoc(id, nextName) {
  const d = getDoc(id); if (!d) return null;
  d.name = String(nextName || 'Untitled');
  d.updated = Date.now();
  saveDocFull(d);
  return d;
}

export function deleteDoc(id) {
  try { localStorage.removeItem(LS_DOC_PREFIX + id); } catch {}
  const list = listDocs().filter(d => d && d.id !== id);
  try { localStorage.setItem(LS_LIST_KEY, JSON.stringify(list)); } catch {}
}

export function saveDocThumb(id, dataUrl) {
  if (!id) return;
  const d = getDoc(id); if (!d) return;
  d.thumb = dataUrl || null;
  d.updated = Date.now();
  saveDocFull(d);
}
