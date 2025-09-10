// src/export.js
import { render } from './renderer.js';

export async function saveViewportPNG(canvas, ctx, camera, state, scale=1, baseDpr=1){
  const dpr = Math.max(1, baseDpr) * Math.max(0.5, Math.min(4, scale));
  const w = Math.floor(canvas.clientWidth  * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);

  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');

  render(state, camera, octx, { clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight }, { dpr });

  return await new Promise(res => off.toBlob(b => res(b), 'image/png'));
}

// Generate a small, lossy thumbnail to reduce storage pressure.
// Returns a DataURL string (JPEG) sized to a max dimension.
export async function saveViewportThumb(canvas, ctx, camera, state, opts = {}){
  const {
    maxDim = 640,          // max width/height in pixels
    quality = 0.72,        // JPEG quality
    baseDpr = 1
  } = opts;

  const cw = Math.max(1, canvas.clientWidth|0);
  const ch = Math.max(1, canvas.clientHeight|0);
  const scale = Math.min(1, maxDim / Math.max(cw, ch));
  const dpr = Math.max(0.35, Math.min(2.5, (baseDpr||1) * scale));
  const w = Math.max(1, Math.floor(cw * dpr));
  const h = Math.max(1, Math.floor(ch * dpr));

  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');

  render(state, camera, octx, { clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight }, { dpr });

  const blob = await new Promise(res => off.toBlob(b => res(b), 'image/jpeg', Math.max(0.4, Math.min(0.9, quality))));
  const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result||'')); if (blob) r.readAsDataURL(blob); else res(''); });
  return dataUrl || '';
}
