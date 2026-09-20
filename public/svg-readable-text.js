export const MIN_TEXT_PX = Object.freeze({ secondary: 13, primary: 15 });
export const CALLOUT_DETAIL_PITCH_PX = 54;

export function svgMeetScale(renderedWidth, renderedHeight, viewWidth = 3600, viewHeight = 1000) {
  const values = [renderedWidth, renderedHeight, viewWidth, viewHeight].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return 1;
  return Math.min(renderedWidth / viewWidth, renderedHeight / viewHeight);
}

export function readableTextScale(fontUnits, minimumPixels, screenScale) {
  const values = [fontUnits, minimumPixels, screenScale].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return 1;
  return Math.max(1, minimumPixels / (fontUnits * screenScale));
}

export function anchoredScaleTransform(x, y, scale) {
  if (!Number.isFinite(scale) || scale <= 1.001) return '';
  return `translate(${x} ${y}) scale(${scale.toFixed(4)}) translate(${-x} ${-y})`;
}

export function calloutDetailFits(pitchUnits, screenScale, minimumPitchPixels = CALLOUT_DETAIL_PITCH_PX) {
  const values = [pitchUnits, screenScale, minimumPitchPixels].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return false;
  return pitchUnits * screenScale >= minimumPitchPixels;
}

export function zoomedViewBox({ zoom = 1, centerX = 1800, centerY = 500, width = 3600, height = 1000 } = {}) {
  const safeZoom = Math.max(1, Number.isFinite(zoom) ? zoom : 1);
  const visibleWidth = width / safeZoom;
  const visibleHeight = height / safeZoom;
  const x = Math.min(width - visibleWidth, Math.max(0, centerX - visibleWidth / 2));
  const y = Math.min(height - visibleHeight, Math.max(0, centerY - visibleHeight / 2));
  return { x, y, width: visibleWidth, height: visibleHeight };
}
