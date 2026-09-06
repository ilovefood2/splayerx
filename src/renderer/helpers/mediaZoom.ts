const MIN_MEDIA_ZOOM = 1;
const MAX_MEDIA_ZOOM = 8;
const ZOOM_SENSITIVITY = 0.01;
const PIXELS_PER_LINE = 16;

type PinchWheelEvent = Pick<WheelEvent, 'ctrlKey' | 'deltaMode' | 'deltaY'>;

function normalizeWheelDelta({ deltaMode, deltaY }: PinchWheelEvent): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) return deltaY * PIXELS_PER_LINE;
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return deltaY * window.innerHeight;
  return deltaY;
}

export function isMediaPinchGesture({ ctrlKey, deltaY }: PinchWheelEvent): boolean {
  return ctrlKey && Number.isFinite(deltaY) && deltaY !== 0;
}

export function zoomMediaFromPinch(currentZoom: number, event: PinchWheelEvent): number {
  if (!isMediaPinchGesture(event)) return currentZoom;

  const zoom = currentZoom * Math.exp(-normalizeWheelDelta(event) * ZOOM_SENSITIVITY);
  return Math.min(MAX_MEDIA_ZOOM, Math.max(MIN_MEDIA_ZOOM, zoom));
}
