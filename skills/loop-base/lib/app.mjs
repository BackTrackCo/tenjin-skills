import fs from 'node:fs';
import path from 'node:path';

// The app a base module serves. An app registers itself once, from its own paths module, so a base module never guesses which app it
// serves and never imports app code.
let current = null;

const NAME = /^[a-z][a-z0-9-]*$/;

// defineApp({ skillDir }): the app's identity comes from its manifest.json. A `name` in the object must equal the manifest's.
export function defineApp(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('defineApp takes an object with the app\'s skillDir');
  if (typeof spec.skillDir !== 'string' || !path.isAbsolute(spec.skillDir)) throw new Error('defineApp needs skillDir, an absolute path to the app\'s skill folder');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(spec.skillDir, 'manifest.json'), 'utf8'));
  } catch (e) {
    throw new Error(`the app's manifest.json cannot be read in ${spec.skillDir}: ${e.message}`);
  }
  if (typeof manifest.name !== 'string' || !NAME.test(manifest.name)) throw new Error('the app\'s manifest.json needs a name in lower case letters, digits and dashes');
  if (spec.name !== undefined && spec.name !== manifest.name) throw new Error(`the app's name ${spec.name} differs from its manifest.json name ${manifest.name}`);
  return Object.freeze({ ...spec, name: manifest.name, skillDir: spec.skillDir, envPrefix: manifest.name.toUpperCase().replace(/-/g, '_') });
}

export function setApp(app) {
  if (!app || typeof app.name !== 'string' || typeof app.skillDir !== 'string' || typeof app.envPrefix !== 'string') throw new Error('setApp takes the object defineApp returned');
  current = app;
  return app;
}

// An app adds a declared part after its own module has loaded (the state shape lives with the code that builds it): the registered
// object is replaced by a copy that carries the part.
export function extendApp(part) {
  const app = getApp();
  current = Object.freeze({ ...app, ...part });
  return current;
}

export function getApp() {
  if (!current) throw new Error('no app is registered: the app\'s own paths module must call setApp(defineApp({ skillDir })) before a base module is used');
  return current;
}

// An env name for the registered app: envName('TICK_MS') is ALPHA_TICK_MS for alpha.
export const envName = (suffix) => `${getApp().envPrefix}_${suffix}`;
