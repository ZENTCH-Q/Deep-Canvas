export async function initPlugins() {
  const paths = (window.pluginHost && typeof window.pluginHost.list === 'function')
    ? window.pluginHost.list()
    : [];
  const api = { registerWidget };
  for (const p of paths) {
    try {
      const mod = await import(p);
      if (mod && typeof mod.register === 'function') {
        mod.register(api);
      }
    } catch (err) {
      console.error('Plugin failed', p, err);
    }
  }
}

function registerWidget({ id, label, html, onClick }) {
  const dock = document.querySelector('.dock-group.tools');
  if (!dock) return null;
  const btn = document.createElement('button');
  btn.className = 'tool plugin-tool';
  if (id) btn.id = id;
  if (label) btn.setAttribute('aria-label', label);
  btn.innerHTML = html || label || '';
  if (typeof onClick === 'function') {
    btn.addEventListener('click', onClick);
  }
  dock.appendChild(btn);
  return btn;
}
