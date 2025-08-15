// src/gallery.js
function $(sel, root = document) { return root.querySelector(sel); }
function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }

function ensureContainers() {
  let root = $('#galleryRoot');
  if (!root) {
    root = el('div', 'g-root');
    root.id = 'galleryRoot';
    $('#galleryView')?.appendChild(root);
  }
  let grid = $('#gGrid');
  if (!grid) {
    grid = el('div', 'g-grid');
    grid.id = 'gGrid';
    root.appendChild(grid);
  }
  return { root, grid };
}

export function showGallery() {
  const v = $('#galleryView');
  if (v) v.style.display = 'block';
  document.body.classList.add('in-gallery');
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

export function hideGallery() {
  const v = $('#galleryView');
  if (v) v.style.display = 'none';
  document.body.classList.remove('in-gallery');
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function inlineRename(nameEl, doc, commitCb) {
  const selectAll = () => {
    const r = document.createRange();
    r.selectNodeContents(nameEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  };

  nameEl.contentEditable = 'true';
  nameEl.focus();
  selectAll();

  const finish = (commit) => {
    nameEl.contentEditable = 'false';
    if (commit) {
      let nv = (nameEl.textContent || '').trim();
      if (!nv) nv = 'Untitled';
      if (nv !== (doc.name || 'Untitled')) commitCb(nv);
    }
    nameEl.textContent = doc.name || 'Untitled';
  };

  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.removeEventListener('keydown', onKey); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); nameEl.removeEventListener('keydown', onKey); finish(false); }
  };
  nameEl.addEventListener('keydown', onKey);
  nameEl.addEventListener('blur', () => finish(true), { once: true });
}

export function initGalleryView(options = {}) {
  const opts = {
    getItems: () => [],
    onOpen: (/* id */) => {},
    onRename: (/* id, name */) => {},
    onDelete: (/* id */) => {},
    onCreateNew: () => {},
    afterReorder: (/* items */) => {},
    ...options
  };

  const { grid } = ensureContainers();

  let items = [];
  const cardById = new Map();

  function setThumbAR(node, it) {
    const w = Number(it.width) || 1600;
    const h = Number(it.height) || 1000;
    const ar = Math.max(0.1, Math.min(10, w / h));
    node.style.setProperty('--thumb-ar', String(ar));
  }

  function makeCard(it) {
    const wrap = el('div', 'g-item');
    const card = el('div', 'g-card');
    card.tabIndex = 0;
    card.dataset.id = it.id;

    const thumb = el('div', 'g-thumb');
    setThumbAR(thumb, it);
    const img = document.createElement('img');
    img.alt = it.name || 'Untitled';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = it.thumb || '';
    img.onerror = () => { img.style.display = 'none'; thumb.classList.add('no-thumb'); };
    thumb.appendChild(img);

    const actions = el('div', 'g-actions');

    const renameBtn = el('button', 'g-act g-rename');
    renameBtn.title = 'Rename';
    renameBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
      </svg>`;
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      inlineRename(nameEl, it, (nv) => { opts.onRename?.(it.id, nv); it.name = nv; });
    });

    const delBtn = el('button', 'g-act g-del');
    delBtn.title = 'Delete';
    delBtn.setAttribute('aria-label', `Delete ${it.name || 'Untitled'}`);
    delBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M3 6h18"/><path d="M8 6v13a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V6"/>
        <path d="M10 11v7M14 11v7"/><path d="M9 6V4a1 1 0 0 1 1-1h4a 1 1 0 0 1 1 1v2"/>
      </svg>`;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ok = confirm(`Delete “${it.name || 'Untitled'}”? This can’t be undone.`);
      if (!ok) return;
      opts.onDelete?.(it.id);
      remove(it.id);
    });

    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);
    thumb.appendChild(actions);

    const meta = el('div', 'g-meta');
    const nameEl = el('span', 'g-name');
    nameEl.textContent = it.name || 'Untitled';
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      inlineRename(nameEl, it, (nv) => { opts.onRename?.(it.id, nv); it.name = nv; });
    });
    meta.appendChild(nameEl);

    card.appendChild(thumb);
    card.appendChild(meta);

    // open
    const open = () => opts.onOpen?.(it.id);
    card.addEventListener('dblclick', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
      else if (e.key === 'F2') { e.preventDefault(); inlineRename(nameEl, it, (nv) => { opts.onRename?.(it.id, nv); it.name = nv; }); }
      else if (e.key === 'Delete') { const ok = confirm(`Delete “${it.name || 'Untitled'}”?`); if (ok) { opts.onDelete?.(it.id); remove(it.id); } }
    });

    wrap.appendChild(card);
    return { wrap, card, img, nameEl, thumb };
  }

  function render() {
    grid.innerHTML = '';
    cardById.clear();
    items.forEach(it => {
      const nodes = makeCard(it);
      grid.appendChild(nodes.wrap);
      cardById.set(it.id, nodes);
    });
  }

  function list() { return items.slice(); }

  function add(it) {
    if (!it || !it.id) return;
    const exists = items.some(x => x.id === it.id);
    if (!exists) items.unshift({ ...it });
    else update(it);
    render();
  }

  function update(patch) {
    if (!patch || !patch.id) return;
    const idx = items.findIndex(x => x.id === patch.id);
    if (idx === -1) return;
    const it = items[idx] = { ...items[idx], ...patch };
    const nodes = cardById.get(it.id);
    if (nodes) {
      if (nodes.img && (patch.thumb !== undefined)) {
        nodes.img.src = it.thumb || '';
        nodes.thumb?.classList.toggle('no-thumb', !it.thumb);
      }
      if (nodes.nameEl && (patch.name !== undefined)) nodes.nameEl.textContent = it.name || 'Untitled';
      if (patch.width || patch.height) setThumbAR(nodes.thumb, it);
    }
  }

  function remove(id) {
    const i = items.findIndex(x => x.id === id);
    if (i !== -1) items.splice(i, 1);
    const nodes = cardById.get(id);
    if (nodes?.wrap?.parentNode) nodes.wrap.parentNode.removeChild(nodes.wrap);
    cardById.delete(id);
  }

  function rerender() { render(); }

  try { items = (opts.getItems?.() || []).slice(); } catch { items = []; }
  render();

  const onNew = () => opts.onCreateNew?.();
  document.addEventListener('gallery:new-canvas', onNew);

  return {
    list, add, update, remove, rerender,
    refresh: () => { try { items = (opts.getItems?.() || []).slice(); } catch { items = []; } render(); },
    destroy: () => { document.removeEventListener('gallery:new-canvas', onNew); cardById.clear(); }
  };
}
