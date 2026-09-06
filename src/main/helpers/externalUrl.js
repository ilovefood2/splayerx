const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);

export function normalizeExternalUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('External URL must be a non-empty string');
  }

  const url = new URL(value);
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Unsupported external URL protocol: ${url.protocol}`);
  }
  return url.href;
}

