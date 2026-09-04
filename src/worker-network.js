// Bound both transfer size and total network time, including response bodies.
export async function boundedFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let reader;
  try {
    const response = await fetch(url, { ...options, signal });
    const limit = 8 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new Error('Response exceeds the 8 MB size limit');
    }
    if (!response.body) return response;
    reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error('Response exceeds the 8 MB size limit');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    const result = new Response(bytes, { status: response.status, statusText: response.statusText, headers });
    Object.defineProperty(result, 'url', { value: response.url });
    return result;
  } finally {
    reader?.releaseLock();
    clearTimeout(timer);
  }
}
