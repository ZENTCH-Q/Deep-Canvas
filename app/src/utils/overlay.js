// utils/overlay.js
export function clearOverlay(overlay, state) {
  if (!overlay || state?._navActive) return;
  const ctx = overlay.getContext('2d', { alpha: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  overlay.style.display = '';
}

export function drawRing(overlay, clientX, clientY, radiusPx, color = '#88ccffaa') {
  if (!overlay) return;
  overlay.style.display = 'block';
  const ctx = overlay.getContext('2d', { alpha: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ctx.beginPath();
  ctx.arc(clientX, clientY, Math.max(1, radiusPx), 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
}
