// src/gallery.js
import { listDocs, createDoc, renameDoc, deleteDoc, loadThumb } from './docs.js';

export function initGallery({ host, onOpen, onCreate }) {
  if (!host) return { refresh: () => {}, destroy: () => {} };

  function selectAll(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function makeRenameInline(nameEl, doc, { selectAllText = true } = {}) {
    nameEl.contentEditable = 'true';
    nameEl.focus();
    if (selectAllText) selectAll(nameEl);

    const finish = (commit) => {
      nameEl.contentEditable = 'false';
      if (commit) {
        const nv = (nameEl.textContent || '').trim() || 'Untitled';
        if (nv !== (doc.name || 'Untitled')) {
          renameDoc(doc.id, nv);
          doc.name = nv; 
        }
      }
      nameEl.textContent = doc.name || 'Untitled';
    };

    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); nameEl.removeEventListener('keydown', onKey); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); nameEl.removeEventListener('keydown', onKey); }
    };
    nameEl.addEventListener('keydown', onKey);
    nameEl.addEventListener('blur', () => finish(true), { once: true });
  }

  function card(doc) {
    const d = document.createElement('div');
    d.className = 'g-card';
    d.title = 'Double-click to open';
    d.tabIndex = 0;
    d.dataset.id = doc.id;

    const thumb = document.createElement('div');
    thumb.className = 'g-thumb';

    const img = document.createElement('img');
    img.alt = doc.name || 'Untitled';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = doc.thumb || loadThumb(doc.id) || '';
    img.onerror = () => { img.style.display = 'none'; thumb.classList.add('no-thumb'); };
    thumb.appendChild(img);

    // Actions (top-right)
    const actions = document.createElement('div');
    actions.className = 'g-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'g-act g-rename';
    renameBtn.title = 'Rename';
    renameBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
      </svg>
    `;
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      makeRenameInline(name, doc);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'g-act g-del';
    delBtn.title = 'Delete';
    delBtn.setAttribute('aria-label', `Delete ${doc.name || 'Untitled'}`);
    delBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M3 6h18"/><path d="M8 6v13a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V6"/>
        <path d="M10 11v7M14 11v7"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
      </svg>
    `;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ok = confirm(`Delete “${doc.name || 'Untitled'}”? This can’t be undone.`);
      if (!ok) return;
      deleteDoc(doc.id);
      render();
    });

    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);
    thumb.appendChild(actions);

    const meta = document.createElement('div');
    meta.className = 'g-meta';

    const name = document.createElement('span');
    name.className = 'g-name';
    name.textContent = doc.name || 'Untitled';
    name.title = 'Double-click to rename';
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      makeRenameInline(name, doc);
    });

    meta.appendChild(name);
    d.appendChild(thumb);
    d.appendChild(meta);
    d.addEventListener('dblclick', () => onOpen?.(doc));
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        onOpen?.(doc);
      } else if (e.key === 'F2') {
        e.preventDefault();
        makeRenameInline(name, doc);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        makeRenameInline(name, doc, { selectAllText: true });
      } else if (e.key === 'Delete') {
        const ok = confirm(`Delete “${doc.name || 'Untitled'}”? This can’t be undone.`);
        if (!ok) return;
        deleteDoc(doc.id);
        render();
      }
    });

    return d;
  }

    function newCard() {
    const d = document.createElement('button');
    d.className = 'g-card g-new';
    d.innerHTML = `
        <div class="g-thumb plus"><span>＋</span></div>
        <div class="g-meta"><span class="g-name">New Canvas</span></div>
    `;

    d.addEventListener('click', (e) => {
        e.preventDefault();
        onCreate?.();
    });

    d.addEventListener('dblclick', (e) => {
        e.preventDefault();
        onCreate?.();
    });

    return d;
    }


  function render() {
    host.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'g-grid';

    const nc = document.createElement('div');
    nc.className = 'g-item';
    nc.appendChild(newCard());
    grid.appendChild(nc);
    const rows = listDocs();
    for (const r of rows) {
      const wrap = document.createElement('div');
      wrap.className = 'g-item';
      wrap.appendChild(card({ ...r })); 
      grid.appendChild(wrap);
    }

    host.appendChild(grid);
  }

  const keyguard = (e) => {
    const typing = /^(INPUT|TEXTAREA)$/i.test(e.target?.tagName) || !!e.target?.isContentEditable;
    if (e.key === 'Backspace' && !typing && host.contains(document.activeElement)) {
      e.preventDefault();
      const focusedCard = document.activeElement?.closest?.('.g-card');
      const nameEl = focusedCard?.querySelector?.('.g-name');
      const id = focusedCard?.dataset?.id;
      if (focusedCard && nameEl && id) {
        makeRenameInline(nameEl, { id, name: nameEl.textContent || 'Untitled' }, { selectAllText: true });
      }
    }
  };
  document.addEventListener('keydown', keyguard);

  render();

  return {
    refresh: render,
    destroy() { document.removeEventListener('keydown', keyguard); }
  };
}
