import { isProxy, toRaw } from 'vue';

/**
 * Structured-clone consumers such as Electron IPC and IndexedDB cannot
 * serialize Vue 3 reactive proxies. Copy plain containers at those boundaries
 * while preserving native structured-clone values such as Buffers, Files,
 * Dates and typed arrays.
 */
export function cloneStructuredValue(value, seen = new WeakMap()) {
  if (value == null || typeof value !== 'object') return value;
  if (isProxy(value)) value = toRaw(value);
  if (Buffer.isBuffer(value) || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value) || value instanceof Date || value instanceof Error) {
    return value;
  }
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const clone = [];
    seen.set(value, clone);
    value.forEach(item => clone.push(cloneStructuredValue(item, seen)));
    return clone;
  }
  if (value instanceof Map) {
    const clone = new Map();
    seen.set(value, clone);
    value.forEach((item, key) => clone.set(
      cloneStructuredValue(key, seen),
      cloneStructuredValue(item, seen),
    ));
    return clone;
  }
  if (value instanceof Set) {
    const clone = new Set();
    seen.set(value, clone);
    value.forEach(item => clone.add(cloneStructuredValue(item, seen)));
    return clone;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const clone = {};
  seen.set(value, clone);
  Object.keys(value).forEach((key) => {
    if (typeof value[key] !== 'function') clone[key] = cloneStructuredValue(value[key], seen);
  });
  return clone;
}

// Keep the established name for existing IPC callers.
export const cloneIpcValue = cloneStructuredValue;

export function installIpcSerialization(ipcRenderer) {
  ['invoke', 'send', 'sendSync'].forEach((method) => {
    const original = ipcRenderer[method].bind(ipcRenderer);
    ipcRenderer[method] = (channel, ...args) => original(
      channel,
      ...args.map(value => cloneStructuredValue(value)),
    );
  });
}
