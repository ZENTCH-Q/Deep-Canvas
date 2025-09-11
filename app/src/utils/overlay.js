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

  // Map viewport client coordinates to the overlay canvas pixel space,
  // accounting for element position and devicePixelRatio scaling.
  const rect = overlay.getBoundingClientRect();
  const scaleX = overlay.width / Math.max(1, rect.width);
  const scaleY = overlay.height / Math.max(1, rect.height);
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;

  ctx.beginPath();
  ctx.arc(x, y, Math.max(1, radiusPx * Math.max(scaleX, scaleY)), 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
}
