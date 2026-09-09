import { mount } from './office-scene.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { clone as cloneSkeleton } from './vendor/SkeletonUtils.js';
import { createOfficeAssetLibrary } from './office-asset-library.js';

function disposeSkeletons(model) {
  const skeletons = new Set();
  model.traverse(object => { if (object.skeleton) skeletons.add(object.skeleton); });
  skeletons.forEach(skeleton => skeleton.dispose());
}

function disposeSource(model) {
  const geometry = new Set(), materials = new Set(), textures = new Set(), images = new Set();
  model.traverse(object => {
    if (object.geometry) geometry.add(object.geometry);
    if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material));
  });
  materials.forEach(material => Object.values(material).forEach(value => { if (value?.isTexture) textures.add(value); }));
  geometry.forEach(item => item.dispose());
  textures.forEach(item => { if (item.source?.data) images.add(item.source.data); item.dispose(); });
  images.forEach(item => { if (typeof item.close === 'function') item.close(); });
  materials.forEach(item => item.dispose());
  disposeSkeletons(model);
}

// A library belongs to exactly one mounted office and authenticated identity.
// Geometry and textures are shared; each returned lease has its own skeleton.
export function createCharacterLibrary({ userId, selectAvatar }) {
  const controller = new AbortController(), cache = new Map(), leases = new Set();
  let disposed = false, catalogPromise;
  const assertOpen = () => { if (disposed) throw new DOMException('The office was closed.', 'AbortError'); };
  async function authenticatedFetch(path) {
    assertOpen();
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'X-Coatria-User': userId } });
    assertOpen();
    if (!response.ok) {
      if (response.status === 401 || response.status === 409) window.dispatchEvent(new Event('coatria:session-changed'));
      throw new Error('The character could not be loaded.');
    }
    return response;
  }
  async function catalog() {
    if (!catalogPromise) catalogPromise = authenticatedFetch('/api/avatars').then(response => response.json()).then(data => {
      assertOpen();
      const avatars = (Array.isArray(data.avatars) ? data.avatars : []).filter(avatar =>
        typeof avatar.id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(avatar.id) &&
        typeof avatar.idleClip === 'string' && typeof avatar.walkClip === 'string' &&
        Number.isFinite(avatar.walkSpeed) && avatar.walkSpeed > 0
      ).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      if (!avatars.length) throw new Error('No character models are available.');
      return avatars;
    }).catch(error => { catalogPromise = undefined; throw error; });
    return catalogPromise;
  }
  async function loadCharacter(person) {
    const avatars = await catalog();
    assertOpen();
    const metadata = selectAvatar(String(person.id), person.avatarId, avatars);
    if (!metadata || !avatars.includes(metadata)) throw new Error('No matching character is available.');
    let entry = cache.get(metadata.id);
    if (!entry) {
      entry = { source: null, promise: null };
      cache.set(metadata.id, entry);
      entry.promise = authenticatedFetch(`/api/avatars/${encodeURIComponent(metadata.id)}/model`)
        .then(response => response.arrayBuffer())
        .then(buffer => { assertOpen(); return new GLTFLoader().parseAsync(buffer, ''); })
        .then(source => {
          if (disposed) { disposeSource(source.scene); throw new DOMException('The office was closed.', 'AbortError'); }
          entry.source = source;
          return source;
        }).catch(error => { if (cache.get(metadata.id) === entry) cache.delete(metadata.id); throw error; });
    }
    const source = await entry.promise;
    assertOpen();
    const scene = cloneSkeleton(source.scene);
    let released = false;
    const lease = {
      scene, animations: source.animations, metadata,
      release() {
        if (released) return;
        released = true;
        scene.removeFromParent();
        disposeSkeletons(scene);
        leases.delete(lease);
      }
    };
    leases.add(lease);
    return lease;
  }
  return {
    loadCharacter,
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      [...leases].forEach(lease => lease.release());
      for (const entry of cache.values()) if (entry.source) disposeSource(entry.source.scene);
      cache.clear();
    },
    get diagnostics() { return { disposed, sources: cache.size, leases: leases.size }; }
  };
}

// Paid model files are available only through the authenticated asset endpoint.
window.CoatriaOfficeRuntime = { mount, createCharacterLibrary, createOfficeAssetLibrary };
