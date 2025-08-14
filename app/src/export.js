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

