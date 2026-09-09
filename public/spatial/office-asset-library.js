import { LoadingManager } from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';

const MAX_BYTES = 4 * 1024 * 1024;
const aborted = () => new DOMException('The office was closed.', 'AbortError');

function disposeSource(scene) {
  const geometry = new Set(), materials = new Set(), textures = new Set(), images = new Set();
  scene.traverse(object => {
    if (object.geometry) geometry.add(object.geometry);
    if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(value => materials.add(value));
  });
  materials.forEach(material => Object.values(material).forEach(value => { if (value?.isTexture) textures.add(value); }));
  geometry.forEach(value => value.dispose());
  textures.forEach(value => { if (value.source?.data) images.add(value.source.data); value.dispose(); });
  images.forEach(value => { if (typeof value.close === 'function') value.close(); });
  materials.forEach(value => value.dispose());
}

// Inspect the JSON before the loader can resolve any resource. Our licensed
// bundle is static, self-contained GLB; remote URLs and data URIs are not needed.
function validateBinary(buffer) {
  if (buffer.byteLength < 20 || buffer.byteLength > MAX_BYTES) throw new Error('Invalid furniture model size.');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== buffer.byteLength) throw new Error('Invalid furniture model.');
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || length > buffer.byteLength - 20) throw new Error('Invalid furniture model manifest.');
  const manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)));
  if ([...(manifest.buffers || []), ...(manifest.images || [])].some(value => value.uri !== undefined)) throw new Error('Furniture models must contain their own resources.');
  if (manifest.skins?.length || manifest.animations?.length) throw new Error('Furniture models must be static.');
}

async function readBounded(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('Furniture model exceeds the size limit.'); }
  if (!response.body) throw new Error('Furniture model is empty.');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Furniture model exceeds the size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

// A source is private to one authenticated mount. Rigid clones share its GPU
// resources; only this library disposes those resources, after every lease ends.
export function createOfficeAssetLibrary({userId, catalog = []}) {
  const controller = new AbortController(), sources = new Map(), leases = new Set(), queue = [];
  const definitions = new Map(catalog.filter(value => typeof value?.id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id) &&
    [value.width, value.depth, value.height].every(n => Number.isFinite(n) && n > 0) && ['uniform', 'footprint'].includes(value.resize)).map(value => [value.id, Object.freeze({...value})]));
  let disposed = false, activeLoads = 0, sequence = 0, notifiedIdentityChange = false;
  const assertOpen = () => { if (disposed) throw aborted(); };
  function trim() {
    const idle = [...sources.entries()].filter(([, entry]) => entry.source && !entry.refs && !entry.waiters).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (idle.length > 8) { const [id, entry] = idle.shift(); sources.delete(id); disposeSource(entry.source.scene); }
  }
  function pump() {
    while (!disposed && activeLoads < 3 && queue.length) {
      const job = queue.shift(); activeLoads++;
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { activeLoads--; pump(); });
    }
  }
  function schedule(run) {
    if (queue.length >= 100) return Promise.reject(new Error('Too many furniture models are waiting.'));
    return new Promise((resolve, reject) => { queue.push({run, resolve, reject}); pump(); });
  }
  async function fetchSource(metadata) {
    assertOpen();
    const response = await fetch(`/api/office-assets/${encodeURIComponent(metadata.id)}/model`, {
      credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: {'X-Coatria-User': userId}
    });
    assertOpen();
    if (!response.ok) {
      if ((response.status === 401 || response.status === 409) && !notifiedIdentityChange) {
        notifiedIdentityChange = true; window.dispatchEvent(new Event('coatria:session-changed'));
      }
      throw new Error('This furniture could not be loaded.');
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('model/gltf-binary')) throw new Error('Invalid furniture response.');
    const buffer = await readBounded(response); assertOpen(); validateBinary(buffer);
    const manager = new LoadingManager();
    manager.setURLModifier(url => { if (!url.startsWith('blob:')) throw new Error('External furniture resources are not allowed.'); return url; });
    const source = await new GLTFLoader(manager).parseAsync(buffer, '');
    if (disposed) { disposeSource(source.scene); throw aborted(); }
    return source;
  }
  async function loadAsset(assetId) {
    assertOpen();
    const metadata = definitions.get(assetId);
    if (!metadata) throw new Error('This furniture is not in the office collection.');
    let entry = sources.get(assetId);
    if (!entry) {
      entry = {source: null, refs: 0, waiters: 0, lastUsed: ++sequence, promise: null};
      sources.set(assetId, entry);
      entry.promise = schedule(() => fetchSource(metadata)).then(source => {
        if (disposed) { disposeSource(source.scene); throw aborted(); }
        entry.source = source; return source;
      }).catch(error => {
        if (sources.get(assetId) === entry) sources.delete(assetId);
        throw error;
      });
    }
    entry.waiters++;
    try {
      const source = await entry.promise; assertOpen();
      const scene = source.scene.clone(true); entry.refs++; entry.lastUsed = ++sequence;
      let released = false;
      const lease = {scene, metadata, release() {
        if (released) return;
        released = true; scene.removeFromParent(); entry.refs--; entry.lastUsed = ++sequence; leases.delete(lease);
        if (!disposed) trim();
      }};
      leases.add(lease); return lease;
    } finally { entry.waiters--; if (!disposed) trim(); }
  }
  return {loadAsset,
    dispose() {
      if (disposed) return;
      disposed = true; controller.abort(); queue.splice(0).forEach(job => job.reject(aborted()));
      [...leases].forEach(lease => lease.release());
      for (const entry of sources.values()) if (entry.source) disposeSource(entry.source.scene);
      sources.clear();
    },
    get diagnostics() { return {disposed, sources: sources.size, leases: leases.size, activeLoads, queued: queue.length}; }
  };
}
