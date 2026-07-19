export function getWheelScrollDelta(event, pageHeight = 0) {
  if (!event || !Number.isFinite(event.deltaY)) return 0;
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * pageHeight;
  return event.deltaY;
}

export function applyWheelScroll(element, event) {
  if (!element) return;
  element.scrollTop += getWheelScrollDelta(event, element.clientHeight);
}
