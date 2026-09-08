import { mount } from './office-scene.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';

// Curated local assets only. Asset generation credentials never enter this module.
window.CoatriaOfficeRuntime = {
  mount,
  loadCharacter() {
    return new Promise((resolve, reject) => {
      new GLTFLoader().load('/spatial/characters/coworker-runtime.glb', resolve, undefined, reject);
    });
  },
  disposeCharacter(model) {
    const geometry = new Set(), materials = new Set(), textures = new Set();
    model.traverse(object => {
      if (object.geometry) geometry.add(object.geometry);
      if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material));
    });
    materials.forEach(material => Object.values(material).forEach(value => { if (value?.isTexture) textures.add(value); }));
    geometry.forEach(item => item.dispose());
    textures.forEach(item => item.dispose());
    materials.forEach(item => item.dispose());
  }
};
